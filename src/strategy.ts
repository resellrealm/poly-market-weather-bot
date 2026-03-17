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
function estimateProbability(
  forecastTemp: number,
  range: [number, number],
  hoursOut: number
): number {
  // NWS forecast standard error increases with time horizon
  // ~2°F for same-day, ~3°F for next-day, ~5°F for 2-3 days out
  const daysOut = Math.max(0, hoursOut / 24);
  const stdError = 2 + daysOut * 1.2;

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

      for (let i = 0; i < 4; i++) {
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
        let matched:
          | {
              market: PolymarketMarket;
              question: string;
              price: number;
              range: [number, number];
            }
          | null = null;

        for (const market of event.markets ?? []) {
          const question = market.question ?? "";
          const rng = parseTempRange(question);
          if (rng && rng[0] <= forecastTemp && forecastTemp <= rng[1]) {
            try {
              const pricesStr = market.outcomePrices ?? "[0.5,0.5]";
              const prices = JSON.parse(pricesStr) as number[];
              const yesPrice = Number(prices[0]);
              if (!isFinite(yesPrice)) continue;
              matched = {
                market,
                question,
                price: yesPrice,
                range: rng
              };
            } catch {
              continue;
            }
            break;
          }
        }

        if (!matched) {
          skip(`No bucket found for ${forecastTemp}°F`);
          continue;
        }

        const price = matched.price;
        const marketId = matched.market.id;
        const question = matched.question;

        info(`Bucket: ${question.slice(0, 60)}`);
        info(`Market price: $${price.toFixed(3)}`);

        if (price >= config.entry_threshold) {
          skip(
            `Price $${price.toFixed(
              3
            )} above threshold $${config.entry_threshold.toFixed(2)}`
          );
          continue;
        }

        // Estimate probability using NWS forecast + normal distribution
        const ourProb = estimateProbability(forecastTemp, matched.range, hoursLeft);
        const ev = expectedValue(ourProb, price);
        const kellyPct = kellyFraction(ourProb, price, config.kelly_fraction);

        info(
          `P(win): ${(ourProb * 100).toFixed(1)}% | EV: $${ev.toFixed(3)} | Kelly: ${(kellyPct * 100).toFixed(1)}%`
        );

        // Only enter if we have positive expected value
        if (ev <= 0) {
          skip(`Negative EV ($${ev.toFixed(3)}) — no edge`);
          continue;
        }

        if (kellyPct <= 0) {
          skip("Kelly says don't bet — no edge");
          continue;
        }

        // Position sizing: min of Kelly fraction and max_position_pct cap
        const cappedPct = Math.min(kellyPct, config.max_position_pct);
        const positionSize = Number((balance * cappedPct).toFixed(2));
        const shares = positionSize / price;

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

        if (positionSize < 0.5) {
          skip(`Position size $${positionSize.toFixed(2)} too small (min $0.50)`);
          continue;
        }

        if (!dryRun) {
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
          ok(
            `Position opened — $${positionSize.toFixed(
              2
            )} deducted from balance`
          );
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
}
