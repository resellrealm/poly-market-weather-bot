import { BotConfig, getActiveLocations } from "./config";
import { C, info, ok, skip } from "./colors";
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

const POSITION_PCT = 0.05;

export interface RunOptions {
  dryRun: boolean;
  config: BotConfig;
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

  console.log(`\n${C.BOLD(C.CYAN("🌤  Weather Trading Bot v1 (TS)"))}`);
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
    `  Position size:   ${(POSITION_PCT * 100).toFixed(
      0
    )}% of balance per trade`
  );
  console.log(
    `  Entry threshold: below $${config.entry_threshold.toFixed(2)}`
  );
  console.log(
    `  Exit threshold:  above $${config.exit_threshold.toFixed(2)}`
  );
  console.log(`  Trades W/L:      ${sim.wins}/${sim.losses}`);

  // --- CHECK EXITS ---
  console.log(`\n${C.BOLD("📤 Checking exits...")}`);
  for (const [mid, pos] of Object.entries(positions)) {
    const currentPrice = await getMarketYesPrice(mid);
    if (currentPrice == null) continue;

    if (currentPrice >= config.exit_threshold) {
      exitsFound += 1;
      const pnl = (currentPrice - pos.entry_price) * pos.shares;
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
          closed_at: new Date().toISOString()
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
  console.log(`\n${C.BOLD("🔍 Scanning for entry signals...")}`);

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

      const positionSize = Number((balance * POSITION_PCT).toFixed(2));
      const shares = positionSize / price;

      ok(
        `SIGNAL — buying ${shares.toFixed(
          1
        )} shares @ $${price.toFixed(3)} = $${positionSize.toFixed(2)}`
      );

      if (positions[marketId]) {
        skip("Already in this market");
        continue;
      }

      if (tradesExecuted >= config.max_trades_per_run) {
        skip(`Max trades (${config.max_trades_per_run}) reached`);
        continue;
      }

      if (positionSize < 0.5) {
        skip(`Position size $${positionSize.toFixed(2)} too small`);
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
          opened_at: new Date().toISOString()
        };
        positions[marketId] = pos;
        sim.total_trades += 1;
        const trade: Trade = {
          type: "entry",
          question,
          entry_price: price,
          shares,
          cost: positionSize,
          opened_at: pos.opened_at
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

  if (dryRun) {
    console.log(
      `\n  ${C.YELLOW(
        "[PAPER MODE — use --live to simulate trades]"
      )}`
    );
  }
}

