/**
 * Monitor logger: appends price lines to one log file per 15m market slot.
 * File: logs/monitor_{YYYY-MM-DD}_{HH}-{00|15|30|45}.log
 */
import * as fs from "fs";
import * as path from "path";

const LOGS_DIR = "logs";

function timeBucket15m(d: Date): string {
  const y = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = Math.floor(d.getMinutes() / 15) * 15;
  const minStr = String(min).padStart(2, "0");
  return `${y}-${month}-${day}_${h}-${minStr}`;
}

function ensureLogsDir(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Append a line to the monitor log file for the given time (15m slot).
 */
export function appendMonitorLog(line: string, at: Date): void {
  ensureLogsDir();
  const bucket = timeBucket15m(at);
  const filename = `monitor_${bucket}.log`;
  const filepath = path.join(LOGS_DIR, filename);
  fs.appendFile(filepath, line + "\n", "utf8", (err) => {
    if (err) console.error("Monitor log append error:", err);
  });
}

/** Append a line with [ISO timestamp] prefix to the current 15m slot's monitor log. */
export function appendMonitorLogWithTimestamp(message: string): void {
  const at = new Date();
  appendMonitorLog(`[${at.toISOString()}] ${message}`, at);
}
