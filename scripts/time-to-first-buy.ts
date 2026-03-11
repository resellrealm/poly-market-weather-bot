/**
 * Analyze kalshi-log (or LOG_DIR): time from "nearest quarter minute" (session start)
 * to first buy. Reports fastest and normal (median/mean) time to first buy.
 */
import * as fs from "fs";
import * as path from "path";

const LOG_DIR = path.resolve(__dirname, "../kalshi-log");
const KALSHI_TRIGGER = 1.0;
const KALSHI_TRIGGER_99 = 0.99;
const POLY_BUY_MIN = 0.94;

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

/** Parse session start from filename: monitor_2026-02-05_06-30.log -> 2026-02-05T06:30:00.000Z */
function sessionStartFromFilename(filePath: string): number | null {
  const base = path.basename(filePath);
  const match = base.match(/monitor_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})\.log$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const ds = `${y}-${mo}-${d}T${h}:${mi}:00.000Z`;
  return new Date(ds).getTime();
}

interface FirstBuyResult {
  file: string;
  side: "UP" | "DOWN";
  quarterStartMs: number;
  firstPriceMs: number;  // first price line in file
  buyAtMs: number;
  /** Seconds from quarter (HH:00, HH:15, HH:30, HH:45) to first buy */
  secondsFromQuarter: number;
  /** Seconds from first price line in log to first buy */
  secondsFromFirstPrice: number;
  buyAt: string;
}

function analyzeFile(filePath: string): FirstBuyResult[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const prices: PriceRow[] = [];
  for (const line of lines) {
    const pr = parsePriceLine(line);
    if (pr) prices.push(pr);
  }
  const quarterStartMs = sessionStartFromFilename(filePath);
  if (prices.length === 0 || quarterStartMs == null) return [];

  const firstPriceMs = prices[0].tsMs;
  const file = path.basename(filePath);
  const results: FirstBuyResult[] = [];

  // UP: first row where (kUp>=0.99 && pUp>=0.99) OR (seen kUp>=1.00 && pUp>=polyBuyMin)
  let upSeen1 = false;
  for (let i = 0; i < prices.length; i++) {
    const row = prices[i];
    upSeen1 = upSeen1 || row.kUp >= KALSHI_TRIGGER;
    if (row.kUp >= KALSHI_TRIGGER_99 && row.pUp >= KALSHI_TRIGGER_99) {
      results.push({
        file,
        side: "UP",
        quarterStartMs,
        firstPriceMs,
        buyAtMs: row.tsMs,
        secondsFromQuarter: (row.tsMs - quarterStartMs) / 1000,
        secondsFromFirstPrice: (row.tsMs - firstPriceMs) / 1000,
        buyAt: row.ts,
      });
      break;
    }
    if (upSeen1 && row.pUp >= POLY_BUY_MIN) {
      results.push({
        file,
        side: "UP",
        quarterStartMs,
        firstPriceMs,
        buyAtMs: row.tsMs,
        secondsFromQuarter: (row.tsMs - quarterStartMs) / 1000,
        secondsFromFirstPrice: (row.tsMs - firstPriceMs) / 1000,
        buyAt: row.ts,
      });
      break;
    }
  }

  // DOWN: same for down side
  let downSeen1 = false;
  for (let i = 0; i < prices.length; i++) {
    const row = prices[i];
    downSeen1 = downSeen1 || row.kDown >= KALSHI_TRIGGER;
    if (row.kDown >= KALSHI_TRIGGER_99 && row.pDown >= KALSHI_TRIGGER_99) {
      results.push({
        file,
        side: "DOWN",
        quarterStartMs,
        firstPriceMs,
        buyAtMs: row.tsMs,
        secondsFromQuarter: (row.tsMs - quarterStartMs) / 1000,
        secondsFromFirstPrice: (row.tsMs - firstPriceMs) / 1000,
        buyAt: row.ts,
      });
      break;
    }
    if (downSeen1 && row.pDown >= POLY_BUY_MIN) {
      results.push({
        file,
        side: "DOWN",
        quarterStartMs,
        firstPriceMs,
        buyAtMs: row.tsMs,
        secondsFromQuarter: (row.tsMs - quarterStartMs) / 1000,
        secondsFromFirstPrice: (row.tsMs - firstPriceMs) / 1000,
        buyAt: row.ts,
      });
      break;
    }
  }

  return results;
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
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

  const all: FirstBuyResult[] = [];
  for (const f of files) {
    all.push(...analyzeFile(f));
  }

  // Per-file: take the earlier of UP vs DOWN first buy (one trigger per file in practice)
  const byFile = new Map<string, FirstBuyResult>();
  for (const r of all) {
    const existing = byFile.get(r.file);
    if (!existing || r.buyAtMs < existing.buyAtMs) byFile.set(r.file, r);
  }
  const firstBuys = [...byFile.values()];

  const fromQuarter = firstBuys.map((r) => r.secondsFromQuarter);
  const fromFirstPrice = firstBuys.map((r) => r.secondsFromFirstPrice);

  console.log("========== Time to first buy (from kalshi-log) ==========\n");
  console.log("Log dir:", dir, "| Files:", files.length, "| Sessions with a buy:", firstBuys.length);
  console.log("Reference: 'Quarter' = clock quarter (e.g. 06:30:00). 'First price' = first price line in log (monitor started).\n");

  if (firstBuys.length === 0) {
    console.log("No first-buy events found in logs.");
    return;
  }

  const minQuarter = Math.min(...fromQuarter);
  const maxQuarter = Math.max(...fromQuarter);
  const medQuarter = median(fromQuarter);
  const meanQuarter = fromQuarter.reduce((a, b) => a + b, 0) / fromQuarter.length;

  const minFirst = Math.min(...fromFirstPrice);
  const medFirst = median(fromFirstPrice);
  const meanFirst = fromFirstPrice.reduce((a, b) => a + b, 0) / fromFirstPrice.length;

  console.log("--- From quarter (e.g. 06:30:00) to first buy ---");
  console.log("  Fastest (min):  ", minQuarter.toFixed(1), "seconds");
  console.log("  Normal (median):", medQuarter.toFixed(1), "seconds");
  console.log("  Normal (mean):  ", meanQuarter.toFixed(1), "seconds");
  console.log("  Slowest (max):  ", maxQuarter.toFixed(1), "seconds");
  console.log("");
  console.log("--- From first price line in log to first buy ---");
  console.log("  Fastest (min):  ", minFirst.toFixed(1), "seconds");
  console.log("  Normal (median):", medFirst.toFixed(1), "seconds");
  console.log("  Normal (mean):  ", meanFirst.toFixed(1), "seconds");
  console.log("");

  const fastest = firstBuys.find((r) => r.secondsFromQuarter === minQuarter);
  console.log("--- Fastest session (from quarter) ---");
  if (fastest) {
    console.log("  File:", fastest.file, "| Side:", fastest.side, "| Buy at:", fastest.buyAt);
    console.log("  ", minQuarter.toFixed(1), "s from quarter,", fastest.secondsFromFirstPrice.toFixed(1), "s from first price line.");
  }
  console.log("\n========== Done ==========");
}

main();
