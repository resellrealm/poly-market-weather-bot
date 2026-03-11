/**
 * ROLE: Entry point. Starts the price monitor and runs the Kalshi1Poly strategy on every tick.
 * - Checks env, lock, balances → starts polling Kalshi + Polymarket → on each update calls checkKalshi1PolyStrategy and logs prices.
 * Strategy details (buy/exit rules) live in kalshi-1-poly-strategy.ts.
 */
import { startDualPriceMonitor, formatDualPricesLine } from "./dual-monitor";
import { checkKalshi1PolyStrategy } from "./kalshi-1-poly-strategy";
import { warmPolymarketClient, getPolymarketBalanceUsd } from "../polymarket/order";
import { primePolymarketTokenCacheForCurrentSlot } from "../polymarket/prices";
import { warmKalshiOrdersApi, getKalshiBalanceCents } from "../kalshi/bot";
import { appendMonitorLog } from "../core/monitor-logger";
import { acquireMonitorLock, releaseMonitorLock } from "../core/monitor-lock";
import { validateRequiredEnvOrExit } from "../core/validate-env";
import { MIN_BALANCE_USD, POLY_BUY_MIN, POLY_SELL_BELOW, KALSHI_1_POLY_DRY_RUN, KALSHI_1_POLY_SIZE } from "../core/config";

async function checkBalancesOrExit(): Promise<void> {
  const minCents = Math.round(MIN_BALANCE_USD * 100);
  const [kalshiCents, polyUsd] = await Promise.all([
    getKalshiBalanceCents(),
    getPolymarketBalanceUsd(),
  ]);
  const kalshiOk = kalshiCents >= minCents;
  const polyConfigured = polyUsd !== null;
  const polyOk = !polyConfigured || (polyUsd >= MIN_BALANCE_USD);

  if (!kalshiOk || !polyOk) {
    const kalshiStr = `Kalshi $${(kalshiCents / 100).toFixed(2)}`;
    const polyStr = polyConfigured ? `Polymarket $${polyUsd.toFixed(2)}` : "Polymarket (not configured)";
    console.error(
      `[Balance] Below minimum $${MIN_BALANCE_USD}. ${kalshiStr}, ${polyStr}. Stopping.`
    );
    // process.exit(1);
  }
}

async function main(): Promise<void> {
  validateRequiredEnvOrExit();
  acquireMonitorLock();
  await checkBalancesOrExit();

  const intervalMs = parseInt(
    process.env.KALSHI_MONITOR_INTERVAL_MS ?? "100",
    10
  );
  const ticker = process.env.KALSHI_MONITOR_TICKER;
  const restartOnQuarterHour =
    process.env.KALSHI_MONITOR_NO_RESTART !== "true" && process.env.KALSHI_MONITOR_NO_RESTART !== "1";

  console.log(
    `[Kalshi1Poly] Strategy: same-side Method 1 only (Kalshi>=1.00 → Poly>=polyBuyMin). polyBuyMin=${POLY_BUY_MIN} polySellBelow=${POLY_SELL_BELOW} size=${KALSHI_1_POLY_SIZE}${KALSHI_1_POLY_DRY_RUN ? " (DRY RUN)" : ""}`
  );
  console.log(
    `Starting price monitor (poll every ${intervalMs}ms${ticker ? ` ticker=${ticker}` : ", first open BTC up/down"}${restartOnQuarterHour && !ticker ? ", restart at :00/:15/:30/:45" : ""})...`
  );

  warmPolymarketClient();
  warmKalshiOrdersApi();
  await primePolymarketTokenCacheForCurrentSlot("btc");

  const stop = await startDualPriceMonitor({
    kalshiTicker: ticker || undefined,
    intervalMs,
    restartProcessOnQuarterHour: restartOnQuarterHour,
    onPrices: (p) => {
      checkKalshi1PolyStrategy(p).catch((err: unknown) => {
        console.error("[Kalshi1Poly] Error:", err);
      });
      const line = formatDualPricesLine(p);
      if (line != null) {
        console.log(line);
        appendMonitorLog(line, p.fetchedAt);
      }
    },
    onError: (err) => {
      console.error("Monitor error:", err);
    },
  });

  process.on("SIGINT", () => {
    console.log("\nStopping Kalshi1Poly strategy...");
    stop();
    releaseMonitorLock();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
