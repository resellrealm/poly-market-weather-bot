/**
 * Simulate "sell when sum < 0.75" rule on monitor logs.
 * After buying UP or DOWN leg, if (Kalshi leg + Poly opposite leg) sum drops below 0.75, we "sell" (exit).
 * Compares: resolution mismatch (Kalshi winner != Poly winner) = full loss risk vs exit rule helping.
 */
import * as fs from "fs";
import * as path from "path";

const SUM_EXIT_THRESHOLD = 0.75;

const LOG_DIR = path.resolve(__dirname, "../logs");

interface PriceRow {
  ts: string;
  tsMs: number;
  kUp: number;
  kDown: number;
  pUp: number;
  pDown: number;
}

interface Trade {
  file: string;
  ts: string;
  tsMs: number;
  leg: "UP" | "DOWN";
  entrySum: number;
}

function parseTimestamp(s: string): number {
  const m = s.match(/\[([\dTZ.-]+)\]/);
  if (!m) return 0;
  return new Date(m[1]).getTime();
}

function parsePriceLine(line: string): PriceRow | null {
  const m = line.match(
    /\[([^\]]+)\]\s*Kalshi UP ([\d.]+) DOWN ([\d.]+)\s*\|\s*Polymarket UP ([\d.]+) DOWN ([\d.]+)/
  );
  if (!m) return null;
  return {
    ts: m[1],
    tsMs: new Date(m[1]).getTime(),
    kUp: parseFloat(m[2]),
    kDown: parseFloat(m[3]),
    pUp: parseFloat(m[4]),
    pDown: parseFloat(m[5]),
  };
}

function parseTrade(line: string, file: string): Trade | null {
  const upMatch = line.match(
    /\[([^\]]+)\].*\[Arb\] Opportunity \(UP leg\): sum=([\d.]+).*placing/
  );
  if (upMatch)
    return {
      file,
      ts: upMatch[1],
      tsMs: new Date(upMatch[1]).getTime(),
      leg: "UP",
      entrySum: parseFloat(upMatch[2]),
    };
  const downMatch = line.match(
    /\[([^\]]+)\].*\[Arb\] Opportunity \(DOWN leg\): sum=([\d.]+).*placing/
  );
  if (downMatch)
    return {
      file,
      ts: downMatch[1],
      tsMs: new Date(downMatch[1]).getTime(),
      leg: "DOWN",
      entrySum: parseFloat(downMatch[2]),
    };
  return null;
}

function getSumForLeg(row: PriceRow, leg: "UP" | "DOWN"): number {
  if (leg === "UP") return row.kUp + row.pDown;
  return row.kDown + row.pUp;
}

function getWinners(row: PriceRow): { kalshi: "UP" | "DOWN"; poly: "UP" | "DOWN" } {
  return {
    kalshi: row.kUp >= row.kDown ? "UP" : "DOWN",
    poly: row.pUp >= row.pDown ? "UP" : "DOWN",
  };
}

function runSimulation(logFiles: string[]) {
  const results: {
    trade: Trade;
    resolutionMatch: boolean;
    kalshiWinner: string;
    polyWinner: string;
    sumWentBelow075: boolean;
    firstBelow075Time: string | null;
    minSumAfterEntry: number;
    exitWouldHelp: boolean; // mismatch and sum went below 0.75 -> exit avoids full loss
    exitWouldHurt: boolean; // match but sum went below 0.75 -> we'd sell a winner
  }[] = [];

  for (const file of logFiles) {
    const filePath = path.isAbsolute(file) ? file : path.join(LOG_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.error("Skip (not found):", filePath);
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    const prices: PriceRow[] = [];
    const trades: Trade[] = [];

    for (const line of lines) {
      const t = parseTrade(line, path.basename(filePath));
      if (t) trades.push(t);
      const pr = parsePriceLine(line);
      if (pr) prices.push(pr);
    }

    const lastPrice = prices.length ? prices[prices.length - 1] : null;
    const winners = lastPrice ? getWinners(lastPrice) : { kalshi: "UP" as const, poly: "UP" as const };
    const kalshiWinner = winners.kalshi;
    const polyWinner = winners.poly;
    const resolutionMatch = !lastPrice || kalshiWinner === polyWinner;

    for (const trade of trades) {
      const afterPrices = prices.filter((p) => p.tsMs > trade.tsMs);
      let minSum = trade.entrySum;
      let sumWentBelow075 = false;
      let firstBelow075Time: string | null = null;

      for (const row of afterPrices) {
        const sum = getSumForLeg(row, trade.leg);
        if (sum < minSum) minSum = sum;
        if (sum < SUM_EXIT_THRESHOLD) {
          sumWentBelow075 = true;
          if (!firstBelow075Time) firstBelow075Time = row.ts;
        }
      }

      const exitWouldHelp = !resolutionMatch && sumWentBelow075;
      const exitWouldHurt = resolutionMatch && sumWentBelow075;

      results.push({
        trade,
        resolutionMatch,
        kalshiWinner,
        polyWinner,
        sumWentBelow075,
        firstBelow075Time,
        minSumAfterEntry: minSum,
        exitWouldHelp,
        exitWouldHurt,
      });
    }
  }

  return results;
}

function main() {
  const logFiles = [
    "monitor_2026-02-03_21-30.log",
    "monitor_2026-02-03_21-45.log",
    "monitor_2026-02-03_22-00.log",
    "monitor_2026-02-03_22-15.log",
    "monitor_2026-02-03_22-30.log",
    "monitor_2026-02-03_22-45.log",
    "monitor_2026-02-03_23-00.log",
    "monitor_2026-02-03_23-15_diff.log",
    "monitor_2026-02-03_23-30.log",
    "monitor_2026-02-03_23-45.log",
    "monitor_2026-02-04_00-15.log",
    "monitor_2026-02-04_00-30.log",
    "monitor_2026-02-04_00-45.log",
    "monitor_2026-02-04_01-00.log",
    "monitor_2026-02-04_01-15.log",
    "monitor_2026-02-04_01-30.log",
    "monitor_2026-02-04_01-45.log",
    "monitor_2026-02-04_02-00.log",
    "monitor_2026-02-04_02-15.log",
    "monitor_2026-02-04_02-30.log",
    "monitor_2026-02-04_02-45_diff.log",
    "monitor_2026-02-04_03-00.log",
    "monitor_2026-02-04_03-15.log",
    "monitor_2026-02-04_03-30.log",
    "monitor_2026-02-04_03-45.log",
    "monitor_2026-02-04_04-00_diff.log",
    "monitor_2026-02-04_04-15.log",
    "monitor_2026-02-04_04-30.log",
    "monitor_2026-02-04_04-45_diff.log",
    "monitor_2026-02-04_05-00.log",
    "monitor_2026-02-04_06-30.log",
    "monitor_2026-02-04_06-45.log",
  ].map((f) => path.join(LOG_DIR, f));

  const results = runSimulation(logFiles);

  // Summary
  const mismatchTrades = results.filter((r) => !r.resolutionMatch);
  const matchTrades = results.filter((r) => r.resolutionMatch);
  const exitWouldHelp = results.filter((r) => r.exitWouldHelp);
  const exitWouldHurt = results.filter((r) => r.exitWouldHurt);
  const mismatchNoExit = mismatchTrades.filter((r) => !r.sumWentBelow075);

  console.log("========== SIMULATION: Sell when sum < 0.75 ==========\n");
  console.log("Total trades (legs) in logs:", results.length);
  console.log("Resolution MATCH (Kalshi winner = Poly winner):", matchTrades.length);
  console.log("Resolution MISMATCH (risk of full loss on one side):", mismatchTrades.length);
  console.log("");

  console.log("--- When resolution MISMATCHED (you would lose on one side) ---");
  console.log(
    "  Exit rule WOULD HAVE TRIGGERED (sum < 0.75 before end):",
    mismatchTrades.filter((r) => r.sumWentBelow075).length
  );
  console.log(
    "  Exit rule would NOT trigger (sum never < 0.75):",
    mismatchNoExit.length
  );
  console.log("  → Exit rule would have AVOIDED/REDUCED loss in", exitWouldHelp.length, "mismatch case(s).");
  console.log("");

  console.log("--- When resolution MATCHED (both sides same winner) ---");
  console.log(
    "  Exit rule would have triggered (sum < 0.75) — would have SOLD a winner:",
    exitWouldHurt.length
  );
  // Lowest sum seen in matched markets (so you can compare vs 0.75 threshold)
  const matchMinSums = matchTrades.map((r) => r.minSumAfterEntry);
  const lowestSumMatched = matchMinSums.length ? Math.min(...matchMinSums) : null;
  console.log("  LOWEST sum (after entry) in any MATCHED market:", lowestSumMatched != null ? lowestSumMatched.toFixed(3) : "n/a");
  console.log("  (So if threshold is 0.75: matched markets had min_sum as low as", lowestSumMatched != null ? lowestSumMatched.toFixed(3) : "n/a", "— those are the ones that would trigger exit and sell a winner.)");
  if (matchMinSums.length > 0) {
    const sorted = [...matchMinSums].sort((a, b) => a - b);
    console.log("  All min_sums for MATCHED trades (sorted low→high):", sorted.map((s) => s.toFixed(2)).join(", "));
  }
  console.log("");

  console.log("--- Per-trade detail (MISMATCH only) ---");
  mismatchTrades.forEach((r, i) => {
    console.log(
      `  ${i + 1}. ${r.trade.file} @ ${r.trade.ts} ${r.trade.leg} leg entry_sum=${r.trade.entrySum.toFixed(2)}`
    );
    console.log(
      `     Kalshi winner=${r.kalshiWinner} Poly winner=${r.polyWinner} | sum_went_below_0.75=${r.sumWentBelow075} min_sum=${r.minSumAfterEntry.toFixed(3)}${r.firstBelow075Time ? ` first_below_at=${r.firstBelow075Time}` : ""}`
    );
    console.log(`     → Exit rule would ${r.exitWouldHelp ? "HELP (sell before full loss)" : "NOT help (sum never < 0.75)"}`);
  });

  console.log("\n--- Per-trade detail (MATCH but sum < 0.75 — exit would hurt) ---");
  exitWouldHurt.forEach((r, i) => {
    console.log(
      `  ${i + 1}. ${r.trade.file} @ ${r.trade.ts} ${r.trade.leg} leg entry_sum=${r.trade.entrySum.toFixed(2)} min_sum=${r.minSumAfterEntry.toFixed(3)}`
    );
  });

  console.log("\n========== CONCLUSION ==========");
  if (exitWouldHelp.length >= 1)
    console.log("YES: The exit rule would have helped in", exitWouldHelp.length, "mismatch case(s) (sell before full loss).");
  if (mismatchNoExit.length >= 1)
    console.log("CAUTION: In", mismatchNoExit.length, "mismatch case(s) sum never went below 0.75 — exit rule would NOT have triggered.");
  if (exitWouldHurt.length >= 1)
    console.log("TRADEOFF: In", exitWouldHurt.length, "case(s) resolution matched but sum < 0.75 — rule would have sold a winning position (reduced profit).");
}

main();
