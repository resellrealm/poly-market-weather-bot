/**
 * Analyze gaps between sells: for a given parameter set, find the shortest and longest
 * number of markets between consecutive sell events.
 */
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.resolve(__dirname, "../kalshi-log");
const KALSHI_TRIGGER = 1.0;
const KALSHI_TRIGGER_99 = 0.99;

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
  fileIndex: number;
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

  for (let fileIndex = 0; fileIndex < logFiles.length; fileIndex++) {
    const filePath = logFiles[fileIndex];
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

    // UP leg
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
        fileIndex,
        file,
        side: "UP",
        buyAt: prices[upBoughtAt].ts,
        buyPrice: upBuyPrice,
        soldAt,
        sellPrice,
        heldToEnd: soldAt === null,
      });
    }

    // DOWN leg
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
        fileIndex,
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

function main(): void {
  const dir = process.env.LOG_DIR || LOG_DIR;
  if (!fs.existsSync(dir)) {
    console.error("Log dir not found:", dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".log") && f.startsWith("monitor_"))
    .sort()
    .map((f) => path.join(dir, f));

  const params: SimParams = {
    polyBuyMin: parseFloat(process.env.POLY_BUY_MIN || "0.8"),
    polySellBelow: parseFloat(process.env.POLY_SELL_BELOW || "0.7"),
    rangeBuffer: parseFloat(process.env.POLY_SELL_RANGE_BUFFER || "0.15"),
  };

  console.log("========== Sell gap analysis ==========\n");
  console.log("Params: polyBuyMin=" + params.polyBuyMin + ", polySellBelow=" + params.polySellBelow + ", rangeBuffer=" + params.rangeBuffer);
  console.log("Log dir:", dir, "(" + files.length + " files)\n");

  const results = runSimulation(files, params);
  const sells = results.filter((r) => r.soldAt !== null).sort((a, b) => a.fileIndex - b.fileIndex);

  console.log("Total buys:", results.length);
  console.log("Total sells:", sells.length);
  console.log("Held to end:", results.filter((r) => r.heldToEnd).length);
  console.log("Sold rate:", (sells.length / results.length * 100).toFixed(1) + "%\n");

  if (sells.length < 2) {
    console.log("Not enough sells (< 2) to compute gaps between consecutive sells.");
    return;
  }

  const gaps: number[] = [];
  for (let i = 1; i < sells.length; i++) {
    const gap = sells[i].fileIndex - sells[i - 1].fileIndex;
    gaps.push(gap);
  }

  const minGap = Math.min(...gaps);
  const maxGap = Math.max(...gaps);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  console.log("--- Gaps between consecutive sells (in number of markets) ---");
  console.log("Shortest gap:  ", minGap, "markets");
  console.log("Longest gap:   ", maxGap, "markets");
  console.log("Average gap:   ", avgGap.toFixed(1), "markets");
  console.log("");

  console.log("--- Sell events (chronological) ---");
  sells.forEach((s, i) => {
    const gapStr = i > 0 ? ` (${sells[i].fileIndex - sells[i - 1].fileIndex} markets since prev sell)` : "";
    console.log(`${i + 1}. ${s.file} ${s.side} | sold @ ${s.soldAt} price=${s.sellPrice?.toFixed(2)}${gapStr}`);
  });

  console.log("\n========== Done ==========");
}

main();
