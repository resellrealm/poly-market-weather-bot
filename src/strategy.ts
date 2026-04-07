import { BotConfig, getActiveLocations } from "./config";
import { C, info, ok, skip, warn } from "./colors";
import { DailyForecast, LOCATIONS, getForecast } from "./nws";
import { hoursUntilResolution, parseTempRange } from "./parsing";
import {
  PolymarketEvent,
  PolymarketMarket,
  getPolymarketEvent,
  getMarketYesPrice
} from "./polymarket";
import { placeBuyOrder, placeSellOrder } from "./trading";
import { notify } from "./notify";
import {
  Position,
  SimulationState,
  Trade,
  loadSim,
  saveSim
} from "./simState";
import { MONTHS } from "./time";

export interface RunOptions {
  dryRun: boolean;
  config: BotConfig;
}

/**
 * Estimate the probability that the actual temperature falls within a given range,
 * given our NWS forecast point estimate. Uses a normal distribution approximation
 * with NWS typical forecast error (~3°F for 1-day, scaling up for further out).
 */
/** Seasonal multiplier for forecast error — winter is harder to predict */
function getSeasonalMultiplier(): number {
  const month = new Date().getMonth(); // 0-11
  // Dec/Jan/Feb: +25-30%, Jun/Jul/Aug: -15-20%, shoulders: transitional
  const factors = [1.3, 1.3, 1.2, 1.1, 1.0, 0.85, 0.8, 0.85, 1.0, 1.1, 1.2, 1.3];
  return factors[month];
}

/** Regional forecast error factor — coastal cities are more predictable */
const REGIONAL_ERROR_FACTOR: Record<string, number> = {
  nyc: 1.0, chicago: 1.15, miami: 0.85, dallas: 1.1,
  seattle: 0.9, atlanta: 1.0
};

function estimateProbability(
  forecastTemp: number,
  range: [number, number],
  hoursOut: number,
  citySlug?: string
): number {
  // NWS forecast standard error increases with time horizon
  const daysOut = Math.max(0, hoursOut / 24);
  const baseError = 2 + daysOut * 1.0;

  // Apply seasonal and regional adjustments
  const seasonal = getSeasonalMultiplier();
  const regional = REGIONAL_ERROR_FACTOR[citySlug ?? ""] ?? 1.0;
  const stdError = baseError * seasonal * regional;

  // Use normal CDF approximation to estimate P(temp in [low, high])
  const zLow = (range[0] - forecastTemp) / stdError;
  const zHigh = (range[1] - forecastTemp) / stdError;

  return normalCdf(zHigh) - normalCdf(zLow);
}

/** Approximation of the standard normal CDF using Abramowitz & Stegun */
function normalCdf(x: number): number {
  if (x < -6) return 0;
  if (x > 6) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Kelly criterion: f* = (b*p - q) / b
 * where b = net odds (payout per $1 wagered), p = our probability, q = 1-p
 * For binary markets: buying YES at price P, payout is $1 if correct.
 * b = (1 - P) / P (net profit per dollar risked)
 * Apply fractional Kelly to reduce variance.
 */
function kellyFraction(
  ourProb: number,
  marketPrice: number,
  kellyMultiplier: number
): number {
  if (ourProb <= 0 || ourProb >= 1 || marketPrice <= 0 || marketPrice >= 1) return 0;

  const b = (1 - marketPrice) / marketPrice; // net odds
  const q = 1 - ourProb;
  const fullKelly = (b * ourProb - q) / b;

  if (fullKelly <= 0) return 0; // no edge, don't bet

  return fullKelly * kellyMultiplier;
}

/** Expected value of a trade: EV = ourProb * (1 - price) - (1 - ourProb) * price */
function expectedValue(ourProb: number, marketPrice: number): number {
  return ourProb * (1 - marketPrice) - (1 - ourProb) * marketPrice;
}

export async function showPositions(): Promise<void> {
  const sim = await loadSim();
  const positions = sim.positions;
  console.log(`\n${C.BOLD("📊 Open Positions:")}`);
  const mids = Object.keys(positions);
  if (!mids.length) {
    console.log("  No open positions");
    return;
  }

  let totalPnl = 0;
  for (const mid of mids) {
    const pos = positions[mid];
    const currentPrice =
      (await getMarketYesPrice(mid)) ?? pos.entry_price ?? 0;
    const pnl = (currentPrice - pos.entry_price) * pos.shares;
    totalPnl += pnl;
    const pnlStr =
      pnl >= 0
        ? C.GREEN(`+$${pnl.toFixed(2)}`)
        : C.RED(`-$${Math.abs(pnl).toFixed(2)}`);

    console.log(`\n  • ${pos.question.slice(0, 65)}...`);
    console.log(
      `    Entry: $${pos.entry_price.toFixed(3)} | Now: $${currentPrice.toFixed(
        3
      )} | ` +
        `Shares: ${pos.shares.toFixed(1)} | PnL: ${pnlStr}`
    );
    console.log(`    Cost: $${pos.cost.toFixed(2)}`);
    if (pos.kelly_pct != null) {
      console.log(
        `    Kelly: ${(pos.kelly_pct * 100).toFixed(1)}% | EV: $${(pos.ev ?? 0).toFixed(3)} | P(win): ${((pos.our_prob ?? 0) * 100).toFixed(1)}%`
      );
    }
  }

  console.log(`\n  Balance:      $${sim.balance.toFixed(2)}`);
  const pnlColor = totalPnl >= 0 ? C.GREEN : C.RED;
  console.log(
    `  Open PnL:     ${pnlColor(
      `${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`
    )}`
  );
  console.log(
    `  Total trades: ${sim.total_trades} | W/L: ${sim.wins}/${sim.losses}`
  );
}

export async function run(options: RunOptions): Promise<void> {
  const { dryRun, config } = options;

  console.log(`\n${C.BOLD(C.CYAN("🌤  Weather Trading Bot v2 (Kelly Criterion)"))}`);
  console.log("=".repeat(50));

  const sim = await loadSim();
  let balance = sim.balance;
  const positions = sim.positions;
  let tradesExecuted = 0;
  let exitsFound = 0;

  const mode = dryRun
    ? `${C.YELLOW("PAPER MODE")}`
    : `${C.GREEN("LIVE MODE")}`;

  const starting = sim.starting_balance;
  const totalReturn = ((balance - starting) / starting) * 100;
  const returnStr =
    totalReturn >= 0
      ? C.GREEN(`+${totalReturn.toFixed(1)}%`)
      : C.RED(`${totalReturn.toFixed(1)}%`);

  console.log(`\n  Mode:            ${mode}`);
  console.log(
    `  Virtual balance: ${C.BOLD(
      `$${balance.toFixed(2)}`
    )} (started $${starting.toFixed(2)}, ${returnStr})`
  );
  console.log(
    `  Kelly fraction:  ${config.kelly_fraction}x (fractional Kelly)`
  );
  console.log(
    `  Max per trade:   ${(config.max_position_pct * 100).toFixed(0)}% of bankroll ($${(balance * config.max_position_pct).toFixed(2)})`
  );
  console.log(
    `  Entry threshold: below $${config.entry_threshold.toFixed(2)}`
  );
  console.log(
    `  Exit threshold:  above $${config.exit_threshold.toFixed(2)}`
  );
  console.log(
    `  Stop-loss:       -${(config.stop_loss_pct * 100).toFixed(0)}% per position`
  );
  console.log(`  Trades W/L:      ${sim.wins}/${sim.losses}`);

  const openPositionCount = Object.keys(positions).length;

  // --- CHECK STOP-LOSSES AND EXITS ---
  console.log(`\n${C.BOLD("📤 Checking exits & stop-losses...")}`);
  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);
    if (currentPrice == null) continue;

    const pnl = (currentPrice - pos.entry_price) * pos.shares;
    const lossPct = -pnl / pos.cost;

    // Stop-loss check
    if (lossPct >= config.stop_loss_pct) {
      exitsFound += 1;
      warn(
        `STOP-LOSS: ${pos.question.slice(0, 50)}...`
      );
      info(
        `Loss: -${(lossPct * 100).toFixed(1)}% >= stop ${(config.stop_loss_pct * 100).toFixed(0)}% | PnL: -$${Math.abs(pnl).toFixed(2)}`
      );

      if (!dryRun) {
        // Place real sell order if we have a token ID
        const tokenId = (pos as any).token_id;
        let sellOrderId: string | null = null;
        if (tokenId && pos.shares > 0) {
          ok(`Placing REAL SELL (stop-loss): ${pos.shares.toFixed(1)} shares @ $${currentPrice.toFixed(3)}`);
          sellOrderId = await placeSellOrder(config, tokenId, currentPrice, pos.shares);
        }
        // If sell order failed, do NOT mark position as closed
        if (!sellOrderId) {
          warn(`Stop-loss sell failed — keeping position open`);
          continue;
        }
        balance += pos.cost + pnl;
        sim.losses += 1;
        const trade: Trade = {
          type: "exit",
          question: pos.question,
          entry_price: pos.entry_price,
          exit_price: currentPrice,
          pnl: Number(pnl.toFixed(2)),
          cost: pos.cost,
          closed_at: new Date().toISOString(),
          kelly_pct: pos.kelly_pct,
          ev: pos.ev,
          our_prob: pos.our_prob,
          location: pos.location,
          date: pos.date
        };
        sim.trades.push(trade);
        delete positions[mid];
        ok(`Stop-loss triggered — PnL: -$${Math.abs(pnl).toFixed(2)}`);
        notify(`🛑 *STOP-LOSS* ${pos.question.slice(0, 60)}\nEntry: $${pos.entry_price.toFixed(3)} → Now: $${currentPrice.toFixed(3)}\nLoss: -$${Math.abs(pnl).toFixed(2)} (-${(lossPct * 100).toFixed(0)}%)`);
      } else {
        skip("Paper mode — not selling");
      }
      continue;
    }

    // Regular exit check
    if (currentPrice >= config.exit_threshold) {
      exitsFound += 1;
      ok(`EXIT: ${pos.question.slice(0, 50)}...`);
      info(
        `Price $${currentPrice.toFixed(
          3
        )} >= exit $${config.exit_threshold.toFixed(2)} | PnL: +$${pnl.toFixed(
          2
        )}`
      );

      if (!dryRun) {
        // Place real sell order if we have a token ID
        const tokenId = (pos as any).token_id;
        let sellOrderId: string | null = null;
        if (tokenId && pos.shares > 0) {
          ok(`Placing REAL SELL (exit): ${pos.shares.toFixed(1)} shares @ $${currentPrice.toFixed(3)}`);
          sellOrderId = await placeSellOrder(config, tokenId, currentPrice, pos.shares);
        }
        // If sell order failed, do NOT mark position as closed
        if (!sellOrderId) {
          warn(`Exit sell failed — keeping position open`);
          continue;
        }
        balance += pos.cost + pnl;
        if (pnl > 0) sim.wins += 1;
        else sim.losses += 1;
        const trade: Trade = {
          type: "exit",
          question: pos.question,
          entry_price: pos.entry_price,
          exit_price: currentPrice,
          pnl: Number(pnl.toFixed(2)),
          cost: pos.cost,
          closed_at: new Date().toISOString(),
          kelly_pct: pos.kelly_pct,
          ev: pos.ev,
          our_prob: pos.our_prob,
          location: pos.location,
          date: pos.date
        };
        sim.trades.push(trade);
        delete positions[mid];
        ok(
          `Closed — PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
        );
        const emoji = pnl >= 0 ? "✅" : "📉";
        notify(`${emoji} *EXIT* ${pos.question.slice(0, 60)}\nEntry: $${pos.entry_price.toFixed(3)} → Exit: $${currentPrice.toFixed(3)}\nPnL: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      } else {
        skip("Paper mode — not selling");
      }
    }
  }

  if (exitsFound === 0) {
    skip("No exit opportunities");
  }

  // --- SCAN ENTRIES ---
  console.log(`\n${C.BOLD("🔍 Scanning for entry signals (Kelly criterion)...")}`);

  const currentOpenCount = Object.keys(positions).length;
  if (currentOpenCount >= config.max_concurrent_positions) {
    skip(
      `Max concurrent positions (${config.max_concurrent_positions}) reached — skipping entry scan`
    );
  } else {
    const activeLocations = getActiveLocations(config);
    for (const citySlug of activeLocations) {
      if (!(citySlug in LOCATIONS)) {
        continue;
      }

      const locData = LOCATIONS[citySlug];
      const forecast: DailyForecast = await getForecast(citySlug);
      if (!forecast || Object.keys(forecast).length === 0) continue;

      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        const dateStr = date.toISOString().slice(0, 10);
        const month = MONTHS[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();

        const forecastTemp = forecast[dateStr];
        if (forecastTemp == null) continue;

        const event: PolymarketEvent | null = await getPolymarketEvent(
          citySlug,
          month,
          day,
          year
        );
        if (!event) continue;

        const hoursLeft = hoursUntilResolution(event);

        console.log(`\n${C.BOLD(`📍 ${locData.name} — ${dateStr}`)}`);
        info(
          `Forecast: ${forecastTemp}°F | Resolves in: ${hoursLeft.toFixed(0)}h`
        );

        if (hoursLeft < config.min_hours_to_resolution) {
          skip(`Resolves in ${hoursLeft.toFixed(0)}h — too soon`);
          continue;
        }

        // Find matching temperature bucket
        // Evaluate ALL buckets in this event to find the best EV opportunity
        type Candidate = {
          market: PolymarketMarket;
          question: string;
          price: number;
          range: [number, number];
          yesTokenId: string | null;
          ourProb: number;
          ev: number;
          kellyPct: number;
        };
        const candidates: Candidate[] = [];

        for (const market of event.markets ?? []) {
          const question = market.question ?? "";
          const rng = parseTempRange(question);
          if (!rng) continue;
          try {
            const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
            const prices = JSON.parse(pricesStr) as number[];
            const yesPrice = Number(prices[0]);
            if (!isFinite(yesPrice) || yesPrice <= 0 || yesPrice >= 1) continue;
            if (yesPrice >= config.entry_threshold) continue;

            const prob = estimateProbability(forecastTemp, rng, hoursLeft, citySlug);
            const evVal = expectedValue(prob, yesPrice);
            const kelly = kellyFraction(prob, yesPrice, config.kelly_fraction);

            if (evVal > 0 && kelly > 0) {
              let yesTokenId: string | null = null;
              try {
                const tokenIds = JSON.parse(market.clobTokenIds ?? "[]");
                if (Array.isArray(tokenIds) && tokenIds.length > 0) {
                  yesTokenId = tokenIds[0];
                }
              } catch { /* ignore */ }

              candidates.push({
                market, question, price: yesPrice, range: rng,
                yesTokenId, ourProb: prob, ev: evVal, kellyPct: kelly
              });
            }
          } catch { continue; }
        }

        // Pick the best candidate by EV
        if (candidates.length === 0) {
          skip(`No positive-EV buckets for ${forecastTemp}°F forecast`);
          continue;
        }

        candidates.sort((a, b) => b.ev - a.ev);
        const best = candidates[0];
        const matched = best;
        const price = best.price;
        const marketId = best.market.id;
        const question = best.question;
        const ourProb = best.ourProb;
        const ev = best.ev;
        const kellyPct = best.kellyPct;

        info(`Bucket: ${question.slice(0, 60)}`);
        info(`Market price: $${price.toFixed(3)}${candidates.length > 1 ? ` (best of ${candidates.length} candidates)` : ""}`);
        info(
          `P(win): ${(ourProb * 100).toFixed(1)}% | EV: $${ev.toFixed(3)} | Kelly: ${(kellyPct * 100).toFixed(1)}%`
        );

        // Position sizing: min of Kelly fraction and max_position_pct cap
        const cappedPct = Math.min(kellyPct, config.max_position_pct);
        let positionSize = Number((balance * cappedPct).toFixed(2));
        let shares = positionSize / price;

        ok(
          `SIGNAL — Kelly ${(kellyPct * 100).toFixed(1)}% (capped ${(cappedPct * 100).toFixed(1)}%) → $${positionSize.toFixed(2)} for ${shares.toFixed(1)} shares @ $${price.toFixed(3)}`
        );

        if (positions[marketId]) {
          skip("Already in this market");
          continue;
        }

        if (Object.keys(positions).length >= config.max_concurrent_positions) {
          skip(`Max concurrent positions (${config.max_concurrent_positions}) reached`);
          continue;
        }

        if (tradesExecuted >= config.max_trades_per_run) {
          skip(`Max trades (${config.max_trades_per_run}) reached`);
          continue;
        }

        // Polymarket minimum order is 5 shares — round up if affordable
        if (shares < 5) {
          const minCost = 5 * price;
          if (minCost <= balance * 0.5 && ev > 0) {
            shares = 5;
            positionSize = Number(minCost.toFixed(2));
            info(`Rounded up to 5 shares (min order) — cost $${positionSize.toFixed(2)}`);
          } else {
            skip(`Order size ${shares.toFixed(1)} shares too small and can't afford min`);
            continue;
          }
        }

        if (!dryRun) {
          // Place real order on Polymarket CLOB
          let orderId: string | null = null;
          if (matched.yesTokenId) {
            ok(`Placing REAL BUY order: ${shares.toFixed(1)} shares @ $${price.toFixed(3)} (token: ${matched.yesTokenId.slice(0, 12)}...)`);
            orderId = await placeBuyOrder(config, matched.yesTokenId, price, shares);
          } else {
            warn(`No token ID for market — skipping (cannot trade without token)`);
            continue;
          }

          // If the order failed, do NOT track the position or deduct balance
          if (!orderId) {
            warn(`Buy order returned null — not tracking position or deducting balance`);
            continue;
          }

          balance -= positionSize;
          const pos: Position = {
            question,
            entry_price: price,
            shares,
            cost: positionSize,
            date: dateStr,
            location: citySlug,
            forecast_temp: forecastTemp,
            opened_at: new Date().toISOString(),
            kelly_pct: kellyPct,
            ev,
            our_prob: ourProb
          };
          (pos as any).order_id = orderId;
          (pos as any).token_id = matched.yesTokenId;
          positions[marketId] = pos;
          sim.total_trades += 1;
          const trade: Trade = {
            type: "entry",
            question,
            entry_price: price,
            shares,
            cost: positionSize,
            opened_at: pos.opened_at,
            kelly_pct: kellyPct,
            ev,
            our_prob: ourProb,
            location: citySlug,
            date: dateStr
          };
          sim.trades.push(trade);
          tradesExecuted += 1;
          ok(`LIVE order placed — ID: ${orderId} — $${positionSize.toFixed(2)} committed`);
          notify(`📈 *BUY* ${shares.toFixed(1)} shares @ $${price.toFixed(3)}\n${question.slice(0, 80)}\nKelly: ${(kellyPct * 100).toFixed(1)}% | EV: $${ev.toFixed(3)}\nCost: $${positionSize.toFixed(2)} | Order: ${orderId}`);
        } else {
          skip("Paper mode — not buying");
          tradesExecuted += 1;
        }
      }
    }
  }

  if (!dryRun) {
    sim.balance = Number(balance.toFixed(2));
    sim.positions = positions;
    sim.peak_balance = Math.max(sim.peak_balance ?? balance, balance);
    await saveSim(sim);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${C.BOLD("📊 Summary:")}`);
  info(`Balance:         $${balance.toFixed(2)}`);
  info(`Trades this run: ${tradesExecuted}`);
  info(`Exits found:     ${exitsFound}`);
  info(`Open positions:  ${Object.keys(positions).length}/${config.max_concurrent_positions}`);

  // Performance metrics
  if (sim.wins + sim.losses > 0) {
    const winRate = sim.wins / (sim.wins + sim.losses);
    info(`Win rate:        ${(winRate * 100).toFixed(1)}% (${sim.wins}W/${sim.losses}L)`);
  }

  if (dryRun) {
    console.log(
      `\n  ${C.YELLOW(
        "[PAPER MODE — use --live to simulate trades]"
      )}`
    );
  }

  // Send summary notification (live mode only, and only if something happened)
  if (!dryRun && (tradesExecuted > 0 || exitsFound > 0)) {
    const openCount = Object.keys(positions).length;
    notify(`🤖 *Bot Run Summary*\nBalance: $${balance.toFixed(2)}\nTrades: ${tradesExecuted} | Exits: ${exitsFound}\nOpen: ${openCount}/${config.max_concurrent_positions}\nW/L: ${sim.wins}/${sim.losses}`);
  }
}
