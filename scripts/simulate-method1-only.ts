/**
 * Simulate with Method 1 ONLY (no Method 2: disable 0.99/0.99 buy).
 * Method 1: When Kalshi same-side reaches 1.00, buy when Poly same-side >= polyBuyMin.
 * Exit: dynamic threshold with range buffer (when Kalshi same-side = 1.00).
 */
import * as fs from "fs";
import * as path from "path";

const KALSHI_TRIGGER = 1.0;
const DEFAULT_POLY_BUY_MIN = 0.8;
const DEFAULT_POLY_SELL_BELOW = 0.7;
const DEFAULT_RANGE_BUFFER = 0.15;

interface SimParams {
  polyBuyMin: number;
  polySellBelow: number;
  rangeBuffer: number;
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
  sellPrice: number | null;
  heldToEnd: boolean;
}

function runSimulation(logFiles: string[], params: SimParams): SimTrade[] {
  const { polyBuyMin, polySellBelow, rangeBuffer } = params;
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

    // UP leg: Method 1 ONLY (no Method 2)
    let upBoughtAt: number | null = null;
    let upBuyPrice = 0;
    let upSeen1 = false;
    for (let i = 0; i < prices.length; i++) {
      const row = prices[i];
      upSeen1 = upSeen1 || row.kUp >= KALSHI_TRIGGER;
      if (upSeen1 && row.pUp >= polyBuyMin) {
        upBoughtAt = i;
        upBuyPrice = row.pUp;
        break;
      }
    }
    if (upBoughtAt !== null) {
      let soldAt: string | null = null;
      let sellPrice: number | null = null;
      for (let i = upBoughtAt + 1; i < prices.length; i++) {
        const row = prices[i];
        const effectiveThreshold = row.kUp >= 1.0 ? polySellBelow - rangeBuffer : polySellBelow;
        if (row.pUp < effectiveThreshold) {
          soldAt = row.ts;
          sellPrice = row.pUp;
          break;
        }
      }
      results.push({
        file,
        side: "UP",
        buyAt: prices[upBoughtAt].ts,
        buyPrice: upBuyPrice,
        soldAt,
        sellPrice,
        heldToEnd: soldAt === null,
      });
    }

    // DOWN leg: Method 1 ONLY
    let downBoughtAt: number | null = null;
    let downBuyPrice = 0;
    let downSeen1 = false;
    for (let i = 0; i < prices.length; i++) {
      const row = prices[i];
      downSeen1 = downSeen1 || row.kDown >= KALSHI_TRIGGER;
      if (downSeen1 && row.pDown >= polyBuyMin) {
        downBoughtAt = i;
        downBuyPrice = row.pDown;
        break;
      }
    }
    if (downBoughtAt !== null) {
      let soldAt: string | null = null;
      let sellPrice: number | null = null;
      for (let i = downBoughtAt + 1; i < prices.length; i++) {
        const row = prices[i];
        const effectiveThreshold = row.kDown >= 1.0 ? polySellBelow - rangeBuffer : polySellBelow;
        if (row.pDown < effectiveThreshold) {
          soldAt = row.ts;
          sellPrice = row.pDown;
          break;
        }
      }
      results.push({
        file,
        side: "DOWN",
        buyAt: prices[downBoughtAt].ts,
        buyPrice: downBuyPrice,
        soldAt,
        sellPrice,
        heldToEnd: soldAt === null,
      });
    }
  }

  return results;
}

function getTotalProfit(results: SimTrade[]): number {
  return results.reduce((sum, r) => {
    const profit = r.soldAt != null ? (r.sellPrice! - r.buyPrice) : (1 - r.buyPrice);
    return sum + profit;
  }, 0);
}

const COMPARE_PAIRS: Array<SimParams> = [
  { polyBuyMin: 0.94, polySellBelow: 0.77, rangeBuffer: 0.15 },
  { polyBuyMin: 0.8, polySellBelow: 0.7, rangeBuffer: 0.15 },
  { polyBuyMin: 0.8, polySellBelow: 0.55, rangeBuffer: 0.15 },
  { polyBuyMin: 0.8, polySellBelow: 0.55, rangeBuffer: 0.2 },
  { polyBuyMin: 0.85, polySellBelow: 0.7, rangeBuffer: 0.15 },
  { polyBuyMin: 0.9, polySellBelow: 0.8, rangeBuffer: 0.15 },
];

function main(): void {
  const logsDir = path.resolve(__dirname, "../logs");
  const kalshiLogDir = path.resolve(__dirname, "../kalshi-log");

  console.log("========== Simulate Method 1 ONLY (no 0.99/0.99 buy) ==========\n");
  console.log("Method 1: When Kalshi same-side >= 1.00, buy when Poly same-side >= polyBuyMin");
  console.log("Exit: When Kalshi same-side >= 1.00, sell if Poly < (polySellBelow - rangeBuffer); else sell if Poly < polySellBelow\n");

  for (const dir of [logsDir, kalshiLogDir]) {
    if (!fs.existsSync(dir)) {
      console.log("Skipping (not found):", dir, "\n");
      continue;
    }
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".log") && f.startsWith("monitor_"))
      .sort()
      .map((f) => path.join(dir, f));

    const dirName = path.basename(dir);
    console.log("========== " + dirName + " (" + files.length + " files) ==========\n");

    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    const col = { buyMin: 12, sellBelow: 14, buffer: 12, buys: 8, sold: 8, held: 8, profit: 12 };
    const header =
      pad("polyBuyMin", col.buyMin) +
      pad("polySellBelow", col.sellBelow) +
      pad("rangeBuffer", col.buffer) +
      pad("buys", col.buys) +
      pad("sold", col.sold) +
      pad("held", col.held) +
      "sum_profit";
    console.log(header);
    console.log("-".repeat(header.length + 10));

    for (const params of COMPARE_PAIRS) {
      const results = runSimulation(files, params);
      const bought = results.length;
      const sold = results.filter((r) => r.soldAt !== null).length;
      const held = results.filter((r) => r.heldToEnd).length;
      const sumProfit = getTotalProfit(results);
      const row =
        pad(params.polyBuyMin.toFixed(2), col.buyMin) +
        pad(params.polySellBelow.toFixed(2), col.sellBelow) +
        pad(params.rangeBuffer.toFixed(2), col.buffer) +
        pad(String(bought), col.buys) +
        pad(String(sold), col.sold) +
        pad(String(held), col.held) +
        sumProfit.toFixed(2);
      console.log(row);
    }
    console.log("-".repeat(header.length + 10));
    console.log("");
  }

  console.log("\n========== Done ==========");
}

main();
