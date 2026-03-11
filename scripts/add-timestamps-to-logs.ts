/**
 * Add Kalshi and Polymarket timestamps to the first line of log files.
 * - Kalshi format: DDmmmYYHHMM in ET timezone (e.g. 05feb261245)
 * - Polymarket format: unix timestamp in seconds (e.g. 1770330600)
 * Filename is in UTC (e.g. monitor_2026-02-05_17-45.log), converted to ET for Kalshi timestamp.
 */
import * as fs from "fs";
import * as path from "path";

const DIRS = [
  path.resolve(__dirname, "../logs"),
  path.resolve(__dirname, "../kalshi-log"),
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Parse filename to get UTC datetime: monitor_2026-02-05_17-45.log -> 2026-02-05T17:45:00Z */
function parseFilenameToUtc(filename: string): Date | null {
  const m = filename.match(/monitor_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:00.000Z`);
}

/** Convert UTC date to ET (EST/EDT). In Feb 2026, ET is EST (UTC-5). */
function convertToEt(utcDate: Date): Date {
  // Simple approach: subtract 5 hours for EST (Feb is always EST, not EDT)
  // For accurate DST handling use a library, but Feb is always EST
  const etMs = utcDate.getTime() - 5 * 60 * 60 * 1000;
  return new Date(etMs);
}

/** Format date to Kalshi timestamp: YYmmmDDHHMM in ET (e.g. 26feb051245 for 2026-02-05 12:45 ET) */
function formatKalshiTimestamp(etDate: Date): string {
  const year = String(etDate.getUTCFullYear()).slice(-2);
  const month = MONTHS[etDate.getUTCMonth()];
  const day = String(etDate.getUTCDate()).padStart(2, "0");
  const hour = String(etDate.getUTCHours()).padStart(2, "0");
  const min = String(etDate.getUTCMinutes()).padStart(2, "0");
  return `${year}${month}${day}${hour}${min}`;
}

/** Unix timestamp in seconds */
function getPolymarketTimestamp(utcDate: Date): number {
  return Math.floor(utcDate.getTime() / 1000);
}

function main(): void {
  let totalProcessed = 0;
  let totalUpdated = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) {
      console.log("Skipping (not found):", dir);
      continue;
    }

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".log") && f.startsWith("monitor_"))
      .sort();

    console.log(`\n========== ${path.basename(dir)} (${files.length} files) ==========\n`);

    for (const file of files) {
      const filePath = path.join(dir, file);
      totalProcessed++;

      const utcDate = parseFilenameToUtc(file);
      if (!utcDate) {
        console.log(`  [SKIP] ${file} (cannot parse filename)`);
        continue;
      }

      const etDate = convertToEt(utcDate);
      // Add 15 minutes for Kalshi timestamp (market window end time)
      const etDatePlus15 = new Date(etDate.getTime() + 15 * 60 * 1000);
      const kalshiTs = formatKalshiTimestamp(etDatePlus15);
      const polyTs = getPolymarketTimestamp(utcDate);

      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      const firstLine = lines[0] || "";
      
      const timestampLine = `# Kalshi: ${kalshiTs} | Polymarket: ${polyTs}`;

      if (firstLine.startsWith("# Kalshi:") || firstLine.startsWith("Kalshi:")) {
        // Already has timestamp line, replace it
        if (firstLine === timestampLine) {
          // Already correct, skip
          continue;
        }
        lines[0] = timestampLine;
        fs.writeFileSync(filePath, lines.join("\n"), "utf8");
        console.log(`  [UPDATE] ${file} → Kalshi: ${kalshiTs} | Polymarket: ${polyTs}`);
        totalUpdated++;
      } else {
        // No timestamp line, prepend it
        const newContent = timestampLine + "\n" + content;
        fs.writeFileSync(filePath, newContent, "utf8");
        console.log(`  [ADD] ${file} → Kalshi: ${kalshiTs} | Polymarket: ${polyTs}`);
        totalUpdated++;
      }
    }
  }

  console.log(`\n========== Summary ==========`);
  console.log(`Processed: ${totalProcessed} files`);
  console.log(`Updated: ${totalUpdated} files (added timestamp line)`);
  console.log(`\n========== Done ==========`);
}

main();
