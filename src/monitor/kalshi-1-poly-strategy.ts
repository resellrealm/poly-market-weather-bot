/**
 * ROLE: Strategy logic only. Called by run-kalshi-1-poly.ts on every price tick.
 * - If we hold a position: sell when Poly same-side < effective threshold (polySellBelow, or polySellBelow - rangeBuffer when Kalshi same-side = 1.00).
 * - Else: buy same side (UP or DOWN) when Method 1 (Kalshi 1.00 + Poly >= polyBuyMin). One position per market.
 */
import type { DualMarketPrices } from "./dual-monitor";
import { placePolymarketOrder, sellPolymarketOrder, getPolymarketBalanceUsd, type PlacePolyResult } from "../polymarket/order";
import { getBestAskForToken } from "../polymarket/prices";
import { getProxyTokenBalanceHuman } from "../polymarket/redeem";
import { addHolding, clearMarketHoldings } from "../polymarket/holdings";
import {
  POLY_BUY_MIN,
  POLY_SELL_BELOW,
  POLY_SELL_RANGE_BUFFER,
  KALSHI_1_POLY_DRY_RUN,
  KALSHI_1_POLY_SIZE,
} from "../core/config";
import { appendMonitorLogWithTimestamp } from "../core/monitor-logger";

// Constants
const KALSHI_1 = 100;           // cents; Method 1 trigger (Kalshi same-side >= 1.00)
const POLY_PRICE_MAX = 0.99;    // CLOB max for buy
const FOK_RETRY_MS = 100;
const FOK_RETRY_BUFFER = 0.01;
/** Wait for on-chain settlement before reading proxy balance after buy */
const BALANCE_FETCH_DELAY_MS = 1500;
/** Max sell attempts; retry on any sell failure */
const SELL_MAX_ATTEMPTS = 20;
const SELL_RETRY_DELAY_MS = 1000;
/** If more than this many minutes past the quarter (e.g. 06:34 when quarter is 06:30), fetch proxy balance and buy size = Math.floor(balance). */
const MINUTES_PAST_QUARTER_USE_BALANCE = 5;

/** Minutes since the last quarter (:00, :15, :30, :45). E.g. at 06:33 returns 3, at 06:34 returns 4. */
function minutesSinceLastQuarter(nowMs: number): number {
  const d = new Date(nowMs);
  const min = d.getUTCMinutes();
  const sec = d.getUTCSeconds();
  const ms = d.getUTCMilliseconds();
  const quarterMin = Math.floor(min / 15) * 15;
  const elapsedMin = min - quarterMin + sec / 60 + ms / 60000;
  return elapsedMin;
}

/** Start of current 15-min quarter in UTC ms (e.g. 07:30:00.000Z). */
function getCurrentQuarterStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  const min = d.getUTCMinutes();
  const quarterMin = Math.floor(min / 15) * 15;
  const q = new Date(d);
  q.setUTCMinutes(quarterMin, 0, 0);
  return q.getTime();
}

// Pre-fetched proxy USDC balance so we don't fetch at buy time (avoids delay and price change)
let lastQuarterStartMs = 0;
let cachedProxyBalanceUsd: number | null = null;
let cachedProxyBalanceUsdAt = 0;
let balanceFetchScheduled = false;
let balanceFetchTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Ensure proxy balance is either already fetched (if >= 4m past quarter) or scheduled to fetch at 4m.
 * Call every tick so we schedule once per quarter and use cached value when deciding buy size.
 * If already >= 4m past quarter, fetches now so cache is ready before buy decision.
 */
async function ensureProxyBalanceScheduledOrFetched(nowMs: number): Promise<void> {
  const quarterStart = getCurrentQuarterStartMs(nowMs);
  if (quarterStart !== lastQuarterStartMs) {
    if (balanceFetchTimeoutId != null) {
      clearTimeout(balanceFetchTimeoutId);
      balanceFetchTimeoutId = null;
    }
    lastQuarterStartMs = quarterStart;
    balanceFetchScheduled = false;
    cachedProxyBalanceUsd = null;
  }
  if (balanceFetchScheduled) return;
  balanceFetchScheduled = true;
  const minsPast = minutesSinceLastQuarter(nowMs);
  if (minsPast >= MINUTES_PAST_QUARTER_USE_BALANCE) {
    const balance = await getPolymarketBalanceUsd();
    if (balance != null) {
      cachedProxyBalanceUsd = balance;
      cachedProxyBalanceUsdAt = Date.now();
      appendMonitorLogWithTimestamp(
        `[Kalshi1Poly] >${MINUTES_PAST_QUARTER_USE_BALANCE}m past quarter (${minsPast.toFixed(1)}m); fetched proxy balance $${balance.toFixed(2)} (cached for buy size)`
      );
      console.log("[Kalshi1Poly] Fetched proxy balance $", balance.toFixed(2), "(cached for buy size)");
    }
  } else {
    const delayMs = (MINUTES_PAST_QUARTER_USE_BALANCE - minsPast) * 60 * 1000;
    appendMonitorLogWithTimestamp(
      `[Kalshi1Poly] Scheduling proxy balance fetch in ${(delayMs / 60000).toFixed(1)}m (at ${MINUTES_PAST_QUARTER_USE_BALANCE}m past quarter)`
    );
    console.log("[Kalshi1Poly] Scheduling proxy balance fetch in", (delayMs / 60000).toFixed(1), "m");
    balanceFetchTimeoutId = setTimeout(() => {
      balanceFetchTimeoutId = null;
      getPolymarketBalanceUsd().then((balance) => {
        if (balance != null) {
          cachedProxyBalanceUsd = balance;
          cachedProxyBalanceUsdAt = Date.now();
          appendMonitorLogWithTimestamp(`[Kalshi1Poly] Fetched proxy balance $${balance.toFixed(2)} (cached for buy size)`);
          console.log("[Kalshi1Poly] Fetched proxy balance $", balance.toFixed(2), "(cached for buy size)");
        }
      });
    }, delayMs);
  }
}

interface Position {
  side: "UP" | "DOWN";
  tokenId: string;
  size: number;
  conditionId: string;
}

// State (reset when market/ticker changes)
let position: Position | null = null;
let lastTicker: string | null = null;
let entryAttemptedTicker: string | null = null;
/** One buy + sell cycle per market: when we complete a sell for this ticker, do not buy again until ticker changes */
let cycleDoneTicker: string | null = null;
let seenKalshiUp1 = false;
let seenKalshiDown1 = false;
let strategyBusy = false;
/** Skip trading on a market if on first observation either Kalshi UP or DOWN was already 1.00 */
const seenTickers = new Set<string>();
const skippedTickers = new Set<string>();

function onNewTicker(ticker: string): void {
  if (lastTicker != null && lastTicker !== ticker) {
    position = null;
    entryAttemptedTicker = null;
    cycleDoneTicker = null;
    seenKalshiUp1 = false;
    seenKalshiDown1 = false;
  }
  lastTicker = ticker;
}

async function placePolyBuyWithRetry(
  tokenId: string,
  price: number,
  size: number,
  options: { forcePlace: true; conditionId: string }
): Promise<PlacePolyResult> {
  const result = await placePolymarketOrder(tokenId, price, size, options);
  if (result == null || !("error" in result)) return result;
  if (!/couldn't be fully filled|FOK|fill.or.kill/i.test(result.error)) return result;
  await new Promise((r) => setTimeout(r, FOK_RETRY_MS));
  const ask = await getBestAskForToken(tokenId);
  const retryPrice = ask != null ? Math.min(POLY_PRICE_MAX, ask + FOK_RETRY_BUFFER) : POLY_PRICE_MAX;
  const msg = `[Kalshi1Poly] FOK buy failed; retry @ ${retryPrice.toFixed(3)} (ask=${ask?.toFixed(3) ?? "?"})`;
  appendMonitorLogWithTimestamp(msg);
  console.log(msg);
  return await placePolymarketOrder(tokenId, retryPrice, size, options);
}

/** After successful buy: wait for settlement, fetch proxy balance, log it, set position.size to floor(balance, 2 decimals) for sell. */
async function updatePositionSizeFromBalance(outcomeIndex: 1 | 2): Promise<void> {
  await new Promise((r) => setTimeout(r, BALANCE_FETCH_DELAY_MS));
  if (!position) return;
  const balance = await getProxyTokenBalanceHuman(position.conditionId, outcomeIndex);
  const sellSize = Math.floor(balance * 100) / 100;
  const msg = `[Kalshi1Poly] After buy — on-chain balance: ${balance.toFixed(4)} shares → will sell ${sellSize >= 0.01 ? sellSize.toFixed(2) : "(stored)"}`;
  appendMonitorLogWithTimestamp(msg);
  console.log(msg);
  if (sellSize >= 0.01) position.size = sellSize;
}

export async function checkKalshi1PolyStrategy(p: DualMarketPrices): Promise<void> {
  if (!p.kalshi || !p.polymarket) return;
  if (strategyBusy) return;
  strategyBusy = true;
  try {
    const ticker = p.kalshiTicker;
    onNewTicker(ticker);

    const nowMs = Date.now();
    await ensureProxyBalanceScheduledOrFetched(nowMs);

    const kUp = p.kalshi.upAskCents / 100;
    const kDown = p.kalshi.downAskCents / 100;
    const polyUp = p.polymarket.upAsk;
    const polyDown = p.polymarket.downAsk;

    if (position) {
      const currentPrice = position.side === "UP" ? polyUp : polyDown;
      const kalshiSameSide = position.side === "UP" ? kUp : kDown;
      const effectiveSellThreshold = kalshiSameSide >= 1.0 
        ? POLY_SELL_BELOW - POLY_SELL_RANGE_BUFFER 
        : POLY_SELL_BELOW;
      if (currentPrice < effectiveSellThreshold) {
        const outcomeIndex = position.side === "UP" ? 1 : 2;
        if (!KALSHI_1_POLY_DRY_RUN) {
          let sold = false;
          for (let attempt = 1; attempt <= SELL_MAX_ATTEMPTS && position && !sold; attempt++) {
            const balanceHuman = await getProxyTokenBalanceHuman(position.conditionId, outcomeIndex);
            let sellSize: number;
            if (balanceHuman >= 0.01) {
              sellSize = Math.floor(balanceHuman * 100) / 100;
            } else {
              sellSize = Math.max(0.01, Math.floor((position.size - 0.02) * 100) / 100);
              if (balanceHuman === 0 && attempt === 1) {
                appendMonitorLogWithTimestamp(`[Kalshi1Poly] On-chain balance 0; using conservative sell size ${sellSize.toFixed(2)}`);
                console.warn("[Kalshi1Poly] On-chain balance 0; using conservative sell size", sellSize.toFixed(2));
              }
            }
            const thresholdInfo = kalshiSameSide >= 1.0 
              ? `${effectiveSellThreshold.toFixed(2)} (Kalshi ${position.side}=1.00, buffer applied)` 
              : `${effectiveSellThreshold.toFixed(2)}`;
            const msg = `[Kalshi1Poly] Exit: ${position.side} price ${currentPrice.toFixed(2)} < ${thresholdInfo}; selling ${sellSize.toFixed(2)} (balance ${balanceHuman.toFixed(4)}) attempt ${attempt}/${SELL_MAX_ATTEMPTS}`;
            appendMonitorLogWithTimestamp(msg);
            console.log(msg);
            if (sellSize < 0.01) {
              appendMonitorLogWithTimestamp("[Kalshi1Poly] Sell skipped: balance and stored size < 0.01 (one cycle done for this market)");
              console.warn("[Kalshi1Poly] Sell skipped: balance and stored size < 0.01");
              cycleDoneTicker = ticker;
              position = null;
              break;
            }
            const result = await sellPolymarketOrder(position.tokenId, sellSize, {
              forcePlace: true,
              conditionId: position.conditionId,
            });
            if (result && !("error" in result)) {
              const conditionId = position.conditionId;
              appendMonitorLogWithTimestamp(`[Kalshi1Poly] Sell successful: ${sellSize.toFixed(2)} shares (one cycle done for this market)`);
              console.log("[Kalshi1Poly] Sell successful:", sellSize.toFixed(2), "shares (one cycle done for this market)");
              cycleDoneTicker = ticker;
              position = null;
              sold = true;
              clearMarketHoldings(conditionId);
            } else if (result && "error" in result) {
              appendMonitorLogWithTimestamp(`[Kalshi1Poly] Sell failed (attempt ${attempt}): ${result.error}`);
              console.error("[Kalshi1Poly] Sell failed (attempt " + attempt + "):", result.error);
              if (attempt < SELL_MAX_ATTEMPTS) {
                appendMonitorLogWithTimestamp(`[Kalshi1Poly] Will retry in ${SELL_RETRY_DELAY_MS}ms (attempt ${attempt}/${SELL_MAX_ATTEMPTS})`);
                console.log("[Kalshi1Poly] Will retry in", SELL_RETRY_DELAY_MS, "ms (attempt", attempt + "/" + SELL_MAX_ATTEMPTS + ")");
                await new Promise((r) => setTimeout(r, SELL_RETRY_DELAY_MS));
              } else {
                appendMonitorLogWithTimestamp("[Kalshi1Poly] Clearing position after max sell attempts (one cycle done for this market)");
                console.error("[Kalshi1Poly] Clearing position after max sell attempts");
                cycleDoneTicker = ticker;
                position = null;
                break;
              }
            }
          }
        } else {
          cycleDoneTicker = ticker;
          position = null;
        }
        return;
      }
      return;
    }

    if (!seenTickers.has(ticker)) {
      seenTickers.add(ticker);
      if (kUp >= 1 || kDown >= 1) {
        skippedTickers.add(ticker);
        appendMonitorLogWithTimestamp(
          `[Kalshi1Poly] Skip market ${ticker}: initial Kalshi UP ${kUp.toFixed(2)} DOWN ${kDown.toFixed(2)} (either already 1.00)`
        );
        console.log("[Kalshi1Poly] Skip market (either side already 1.00):", ticker);
      }
    }
    if (skippedTickers.has(ticker)) return;

    seenKalshiUp1 = seenKalshiUp1 || p.kalshi.upAskCents >= KALSHI_1;
    seenKalshiDown1 = seenKalshiDown1 || p.kalshi.downAskCents >= KALSHI_1;

    if (cycleDoneTicker === ticker) return;

    // Method 1 only: buy when Kalshi same-side >= 1.00 and Poly same-side >= polyBuyMin
    const buyUpMethod1 = seenKalshiUp1 && polyUp >= POLY_BUY_MIN;
    const canBuyUp = buyUpMethod1 && polyUp <= POLY_PRICE_MAX;

    if (canBuyUp) {
      const minsPast = minutesSinceLastQuarter(nowMs);
      let size: number;
      if (minsPast >= MINUTES_PAST_QUARTER_USE_BALANCE) {
        const balance = cachedProxyBalanceUsd;
        size = balance != null && balance >= 1 ? Math.max(1, Math.floor(balance)) : KALSHI_1_POLY_SIZE;
        if (balance != null && balance >= 1) {
          appendMonitorLogWithTimestamp(`[Kalshi1Poly] >${MINUTES_PAST_QUARTER_USE_BALANCE}m past quarter (${minsPast.toFixed(1)}m); using cached proxy balance $${balance.toFixed(2)} → buy size ${size}`);
        }
      } else {
        size = KALSHI_1_POLY_SIZE;
      }
      const msg = `[Kalshi1Poly] Entry UP (Method 1): Kalshi UP ${kUp.toFixed(2)} Poly UP ${polyUp.toFixed(2)}; buy Poly UP x${size}`;
      appendMonitorLogWithTimestamp(msg);
      console.log(msg);
      if (!KALSHI_1_POLY_DRY_RUN) {
        const result = await placePolyBuyWithRetry(
          p.polymarket.upTokenId,
          polyUp,
          size,
          { forcePlace: true, conditionId: p.polymarket.conditionId }
        );
        if (result && !("error" in result)) {
          entryAttemptedTicker = ticker;
          position = { side: "UP", tokenId: p.polymarket.upTokenId, size, conditionId: p.polymarket.conditionId };
          addHolding(p.polymarket.conditionId, p.polymarket.upTokenId, size);
          await updatePositionSizeFromBalance(1);
        } else if (result && "error" in result) {
          appendMonitorLogWithTimestamp(`[Kalshi1Poly] Buy UP failed (will retry next tick): ${result.error}`);
        }
      }
      return;
    }

    // Method 1 only: buy when Kalshi same-side >= 1.00 and Poly same-side >= polyBuyMin
    const buyDownMethod1 = seenKalshiDown1 && polyDown >= POLY_BUY_MIN;
    const canBuyDown = buyDownMethod1 && polyDown <= POLY_PRICE_MAX;

    if (canBuyDown) {
      const minsPast = minutesSinceLastQuarter(nowMs);
      let size: number;
      if (minsPast >= MINUTES_PAST_QUARTER_USE_BALANCE) {
        const balance = cachedProxyBalanceUsd;
        size = balance != null && balance >= 1 ? Math.max(1, Math.floor(balance)) : KALSHI_1_POLY_SIZE;
        if (balance != null && balance >= 1) {
          appendMonitorLogWithTimestamp(`[Kalshi1Poly] >${MINUTES_PAST_QUARTER_USE_BALANCE}m past quarter (${minsPast.toFixed(1)}m); using cached proxy balance $${balance.toFixed(2)} → buy size ${size}`);
        }
      } else {
        size = KALSHI_1_POLY_SIZE;
      }
      const msg = `[Kalshi1Poly] Entry DOWN (Method 1): Kalshi DOWN ${kDown.toFixed(2)} Poly DOWN ${polyDown.toFixed(2)}; buy Poly DOWN x${size}`;
      appendMonitorLogWithTimestamp(msg);
      console.log(msg);
      if (!KALSHI_1_POLY_DRY_RUN) {
        const result = await placePolyBuyWithRetry(
          p.polymarket.downTokenId,
          polyDown,
          size,
          { forcePlace: true, conditionId: p.polymarket.conditionId }
        );
        if (result && !("error" in result)) {
          entryAttemptedTicker = ticker;
          position = { side: "DOWN", tokenId: p.polymarket.downTokenId, size, conditionId: p.polymarket.conditionId };
          addHolding(p.polymarket.conditionId, p.polymarket.downTokenId, size);
          await updatePositionSizeFromBalance(2);
        } else if (result && "error" in result) {
          appendMonitorLogWithTimestamp(`[Kalshi1Poly] Buy DOWN failed (will retry next tick): ${result.error}`);
        }
      }
    }
  } finally {
    strategyBusy = false;
  }
}
