/**
 * Simulate strategy (two methods, first to trigger wins):
 * Method 1: When Kalshi same-side reaches 1.00, keep monitoring Poly same-side; buy when Poly >= polyBuyMin.
 * Method 2: When Kalshi same-side reaches 0.99 and Poly same-side is also >= 0.99, buy immediately.
 * Exit: if Poly same-side drops below polySellBelow, sell immediately.
 */
import * as fs from "fs";
import * as path from "path";

const KALSHI_TRIGGER = 1.0;       // method 1: buy when Poly >= polyBuyMin after this
const KALSHI_TRIGGER_99 = 0.99;   // method 2: buy when Kalshi >= this and Poly same-side >= this
// Optimized on kalshi-log: 0.94 / 0.77 -> profit 1.08 (vs 0.95/0.75 -> 0.88)
const DEFAULT_POLY_BUY_MIN = 0.94;   // only buy on Poly if same-side price > this
const DEFAULT_POLY_SELL_BELOW = 0.77; // sell all when Poly same-side price drops below this

const LOG_DIR = path.resolve(__dirname, "../kalshi-log");

interface SimParams {
  polyBuyMin: number;
  polySellBelow: number;
}

interface PriceRow {
  ts: string;
  tsMs: number;
  kUp: number;
  kDown: number;
  pUp: number;
  pDown: number;
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

interface SimTrade {
  file: string;
  side: "UP" | "DOWN";
  buyAt: string;
  buyPrice: number;
  soldAt: string | null;
  sellPrice: number | null;  // price when we triggered sell (< 0.75)
  heldToEnd: boolean;
  lastPriceInFile: number;
  /** Lowest same-side Poly price from trigger until sell or end of log */
  lowestPriceSinceTrigger: number;
  /** Winner at that market (side with higher last price in file) */
  winner: "UP" | "DOWN";
}

function runSimulation(
  logFiles: string[],
  params: SimParams = { polyBuyMin: DEFAULT_POLY_BUY_MIN, polySellBelow: DEFAULT_POLY_SELL_BELOW }
): SimTrade[] {
  const { polyBuyMin, polySellBelow } = params;
  const results: SimTrade[] = [];

  for (const filePath of logFiles) {
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const prices: PriceRow[] = [];
    for (const line of lines) {
      const pr = parsePriceLine(line);
      if (pr) prices.push(pr);
    }
    if (prices.length === 0) continue;

    const file = path.basename(filePath);

    // UP leg: buy at first row where EITHER (method 2) kUp>=0.99 and pUp>=0.99, OR (method 1) we've seen kUp>=1.00 and pUp>=polyBuyMin
    let upBoughtAt: number | null = null;
    let upBuyPrice = 0;
    let upSeen1 = false;
    for (let i = 0; i < prices.length; i++) {
      const row = prices[i];
      upSeen1 = upSeen1 || row.kUp >= KALSHI_TRIGGER;
      if (row.kUp >= KALSHI_TRIGGER_99 && row.pUp >= KALSHI_TRIGGER_99) {
        upBoughtAt = i;
        upBuyPrice = row.pUp;
        break;
      }
      if (upSeen1 && row.pUp >= polyBuyMin) {
        upBoughtAt = i;
        upBuyPrice = row.pUp;
        break;
      }
    }
    if (upBoughtAt !== null) {
      let soldAt: string | null = null;
      let sellPrice: number | null = null;
      const endIdx = prices.length;
      for (let i = upBoughtAt + 1; i < endIdx; i++) {
        if (prices[i].pUp < polySellBelow) {
          soldAt = prices[i].ts;
          sellPrice = prices[i].pUp;
          break;
        }
      }
      const last = prices[prices.length - 1];
      let lowest = upBuyPrice;
      for (let i = upBoughtAt; i < endIdx; i++) {
        if (prices[i].pUp < lowest) lowest = prices[i].pUp;
      }
      results.push({
        file,
        side: "UP",
        buyAt: prices[upBoughtAt].ts,
        buyPrice: upBuyPrice,
        soldAt,
        sellPrice,
        heldToEnd: soldAt === null,
        lastPriceInFile: last.pUp,
        lowestPriceSinceTrigger: lowest,
        winner: last.pUp >= last.pDown ? "UP" : "DOWN",
      });
    }

    // DOWN leg: buy at first row where EITHER (method 2) kDown>=0.99 and pDown>=0.99, OR (method 1) we've seen kDown>=1.00 and pDown>=polyBuyMin
    let downBoughtAt: number | null = null;
    let downBuyPrice = 0;
    let downSeen1 = false;
    for (let i = 0; i < prices.length; i++) {
      const row = prices[i];
      downSeen1 = downSeen1 || row.kDown >= KALSHI_TRIGGER;
      if (row.kDown >= KALSHI_TRIGGER_99 && row.pDown >= KALSHI_TRIGGER_99) {
        downBoughtAt = i;
        downBuyPrice = row.pDown;
        break;
      }
      if (downSeen1 && row.pDown >= polyBuyMin) {
        downBoughtAt = i;
        downBuyPrice = row.pDown;
        break;
      }
    }
    if (downBoughtAt !== null) {
      let soldAt: string | null = null;
      let sellPrice: number | null = null;
      const endIdx = prices.length;
      for (let i = downBoughtAt + 1; i < endIdx; i++) {
        if (prices[i].pDown < polySellBelow) {
          soldAt = prices[i].ts;
          sellPrice = prices[i].pDown;
          break;
        }
      }
      const last = prices[prices.length - 1];
      let lowest = downBuyPrice;
      for (let i = downBoughtAt; i < endIdx; i++) {
        if (prices[i].pDown < lowest) lowest = prices[i].pDown;
      }
      results.push({
        file,
        side: "DOWN",
        buyAt: prices[downBoughtAt].ts,
        buyPrice: downBuyPrice,
        soldAt,
        sellPrice,
        heldToEnd: soldAt === null,
        lastPriceInFile: last.pDown,
        lowestPriceSinceTrigger: lowest,
        winner: last.pUp >= last.pDown ? "UP" : "DOWN",
      });
    }
  }

  return results;
}

function singleTradeProfit(r: SimTrade): number {
  return r.soldAt != null ? (r.sellPrice! - r.buyPrice) : (1 - r.buyPrice);
}

function getTotalProfit(results: SimTrade[]): number {
  return results.reduce((sum, r) => sum + singleTradeProfit(r), 0);
}

function optimizeParams(logFiles: string[]): SimParams {
  // Coarse grid first, then refine around best
  const coarseStep = 0.05;
  const buyMinStart = 0.90;
  const buyMinEnd = 0.99;
  const sellBelowStart = 0.50;
  const sellBelowEnd = 0.85;

  const grid = (start: number, end: number, step: number): number[] => {
    const out: number[] = [];
    for (let v = start; v <= end; v += step) out.push(Math.round(v * 100) / 100);
    return out;
  };

  let bestProfit = -Infinity;
  let best: SimParams = { polyBuyMin: DEFAULT_POLY_BUY_MIN, polySellBelow: DEFAULT_POLY_SELL_BELOW };

  const buyMins = grid(buyMinStart, buyMinEnd, coarseStep);
  const sellBelows = grid(sellBelowStart, sellBelowEnd, coarseStep);

  console.log("Phase 1 (coarse step " + coarseStep + "): polyBuyMin", buyMins.length, "values, polySellBelow", sellBelows.length, "values");
  for (const polyBuyMin of buyMins) {
    for (const polySellBelow of sellBelows) {
      const results = runSimulation(logFiles, { polyBuyMin, polySellBelow });
      const total = getTotalProfit(results);
      if (total > bestProfit) {
        bestProfit = total;
        best = { polyBuyMin, polySellBelow };
      }
    }
  }
  console.log("Coarse best:", best, "-> profit", bestProfit.toFixed(2));

  // Refine: ±0.02 around best with step 0.01
  const fineStep = 0.01;
  const buyMinFine = grid(Math.max(buyMinStart, best.polyBuyMin - 0.02), Math.min(buyMinEnd, best.polyBuyMin + 0.02), fineStep);
  const sellBelowFine = grid(Math.max(sellBelowStart, best.polySellBelow - 0.02), Math.min(sellBelowEnd, best.polySellBelow + 0.02), fineStep);
  console.log("Phase 2 (fine step " + fineStep + "):", buyMinFine.length, "x", sellBelowFine.length);
  for (const polyBuyMin of buyMinFine) {
    for (const polySellBelow of sellBelowFine) {
      const results = runSimulation(logFiles, { polyBuyMin, polySellBelow });
      const total = getTotalProfit(results);
      if (total > bestProfit) {
        bestProfit = total;
        best = { polyBuyMin, polySellBelow };
      }
    }
  }
  console.log("Best params:", best, "-> profit", bestProfit.toFixed(2));
  return best;
}

const COMPARE_PAIRS: SimParams[] = [
  { polyBuyMin: 0.94, polySellBelow: 0.77 }, // current default
  { polyBuyMin: 0.95, polySellBelow: 0.75 },
  { polyBuyMin: 0.9, polySellBelow: 0.85 },
  { polyBuyMin: 0.9, polySellBelow: 0.8 },
  { polyBuyMin: 0.9, polySellBelow: 0.75 },
  { polyBuyMin: 0.85, polySellBelow: 0.8 },
  { polyBuyMin: 0.85, polySellBelow: 0.75 },
  { polyBuyMin: 0.85, polySellBelow: 0.7 },
  { polyBuyMin: 0.8, polySellBelow: 0.75 },
  { polyBuyMin: 0.8, polySellBelow: 0.7 },
  { polyBuyMin: 0.8, polySellBelow: 0.55 },
];

function runCompare(logFiles: string[]): void {
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const col = { buyMin: 14, sellBelow: 14, buys: 8, sold: 8, held: 8, profit: 12 };
  const header =
    pad("polyBuyMin", col.buyMin) +
    pad("polySellBelow", col.sellBelow) +
    pad("buys", col.buys) +
    pad("sold", col.sold) +
    pad("held", col.held) +
    "sum_pr";
  console.log("--- Comparison table ---");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const params of COMPARE_PAIRS) {
    const results = runSimulation(logFiles, params);
    const bought = results.length;
    const sold = results.filter((r) => r.soldAt !== null).length;
    const held = results.filter((r) => r.heldToEnd).length;
    const sumProfit = getTotalProfit(results);
    const row =
      pad(params.polyBuyMin.toFixed(2), col.buyMin) +
      pad(params.polySellBelow.toFixed(2), col.sellBelow) +
      pad(String(bought), col.buys) +
      pad(String(sold), col.sold) +
      pad(String(held), col.held) +
      sumProfit.toFixed(2);
    console.log(row);
  }
  console.log("-".repeat(header.length));
}

function main(): void {
  const dir = process.env.KALSHI_LOG_DIR || LOG_DIR;
  if (!fs.existsSync(dir)) {
    console.error("Log dir not found:", dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".log") && f.startsWith("monitor_"))
    .sort()
    .map((f) => path.join(dir, f));

  if (process.env.COMPARE === "1") {
    console.log("========== Compare parameter pairs (polyBuyMin vs polySellBelow) ==========\n");
    console.log("Log dir:", dir, "(" + files.length + " files)\n");
    runCompare(files);
    console.log("\n========== Done ==========");
    return;
  }

  let params: SimParams = { polyBuyMin: DEFAULT_POLY_BUY_MIN, polySellBelow: DEFAULT_POLY_SELL_BELOW };
  if (process.env.POLY_BUY_MIN != null && process.env.POLY_SELL_BELOW != null) {
    params = {
      polyBuyMin: parseFloat(process.env.POLY_BUY_MIN),
      polySellBelow: parseFloat(process.env.POLY_SELL_BELOW),
    };
  } else if (process.env.OPTIMIZE === "1") {
    console.log("========== Optimize parameters on kalshi-log ==========\n");
    params = optimizeParams(files);
    console.log("");
  }

  console.log("========== Simulate: Kalshi 1.00 -> buy same side on Poly ==========\n");
  console.log("Params: polyBuyMin (same-side buy threshold) =", params.polyBuyMin, ", polySellBelow (sell when price <) =", params.polySellBelow);
  console.log("Rules: Buy when EITHER (1) Kalshi>=1.00 and Poly same-side >=", params.polyBuyMin, "OR (2) Kalshi>=0.99 and Poly same-side>=0.99; then if Poly <", params.polySellBelow, ", sell immediately.");
  console.log("Log dir:", dir, "(" + files.length + " files)\n");

  const results = runSimulation(files, params);

  const bought = results.length;
  const sold = results.filter((r) => r.soldAt !== null).length;
  const held = results.filter((r) => r.heldToEnd).length;

  console.log("--- Summary ---");
  console.log("Total buys (triggered):", bought);
  console.log("Sold (Poly price < " + params.polySellBelow + "):", sold);
  console.log("Held to end of log:", held);
  console.log("");

  const totalProfit = getTotalProfit(results);

  // Details table: filename | side | trigger | lowest | sold_price | profit | winner
  const col = {
    file: 36,
    side: 6,
    trigger: 10,
    lowest: 10,
    sold: 10,
    profit: 10,
    winner: 8,
  };
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const header =
    pad("filename", col.file) + " " +
    pad("side", col.side) + " " +
    pad("trigger", col.trigger) + " " +
    pad("lowest", col.lowest) + " " +
    pad("sold", col.sold) + " " +
    pad("profit", col.profit) + " " +
    "winner";
  // trigger = same-side Poly price when opportunity detected; lowest = min same-side price since then
  // sold = price when sold (if token went under 0.75), else "-"
  console.log("--- Details table ---");
  console.log(header);
  console.log("-".repeat(header.length));
  results.forEach((r) => {
    const soldStr = r.sellPrice != null ? r.sellPrice.toFixed(2) : "-";
    const profitStr = singleTradeProfit(r).toFixed(2);
    const row =
      pad(r.file, col.file) + " " +
      pad(r.side, col.side) + " " +
      pad(r.buyPrice.toFixed(2), col.trigger) + " " +
      pad(r.lowestPriceSinceTrigger.toFixed(2), col.lowest) + " " +
      pad(soldStr, col.sold) + " " +
      pad(profitStr, col.profit) + " " +
      r.winner;
    console.log(row);
  });
  console.log("-".repeat(header.length));
  console.log(pad("", col.file) + " " + pad("", col.side) + " " + pad("", col.trigger) + " " + pad("", col.lowest) + " " + pad("", col.sold) + " " + pad(totalProfit.toFixed(2), col.profit) + " (sum profit)");

  console.log("");
  console.log("--- Per trade ---");
  results.forEach((r, i) => {
    const soldStr = r.soldAt != null ? `sold @ ${r.soldAt} (price=${r.sellPrice?.toFixed(2)})` : `held to end (last price=${r.lastPriceInFile.toFixed(2)})`;
    console.log(`${i + 1}. ${r.file} ${r.side} | bought @ ${r.buyAt} price=${r.buyPrice.toFixed(2)} | ${soldStr}`);
  });

  console.log("\n========== Done ==========");
}

main();
