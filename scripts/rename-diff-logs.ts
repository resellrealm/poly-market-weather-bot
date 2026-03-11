/**
 * Rename log files where the bot bought one side but the other side won (add "_diff" suffix).
 * Winner = side with higher price at end of log.
 */
import * as fs from "fs";
import * as path from "path";

const DIRS = [
  path.resolve(__dirname, "../logs"),
  path.resolve(__dirname, "../kalshi-log"),
];

interface PriceRow {
  kUp: number;
  kDown: number;
  pUp: number;
  pDown: number;
}

function parsePriceLine(line: string): PriceRow | null {
  const m = line.match(
    /Kalshi UP ([\d.]+) DOWN ([\d.]+)\s*\|\s*Polymarket UP ([\d.]+) DOWN ([\d.]+)/
  );
  if (!m) return null;
  return {
    kUp: parseFloat(m[1]),
    kDown: parseFloat(m[2]),
    pUp: parseFloat(m[3]),
    pDown: parseFloat(m[4]),
  };
}

function analyzeBuyAndWinner(filePath: string): { bought: "UP" | "DOWN" | null; winner: "UP" | "DOWN" | null } {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // Find buy side (Entry UP or Entry DOWN)
    let bought: "UP" | "DOWN" | null = null;
    for (const line of lines) {
      if (/\[Kalshi1Poly\] Entry UP/.test(line)) {
        bought = "UP";
        break;
      }
      if (/\[Kalshi1Poly\] Entry DOWN/.test(line)) {
        bought = "DOWN";
        break;
      }
    }

    // Find last price line to determine winner
    let lastPrice: PriceRow | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const pr = parsePriceLine(lines[i]);
      if (pr) {
        lastPrice = pr;
        break;
      }
    }

    const winner = lastPrice && lastPrice.pUp >= lastPrice.pDown ? "UP" : lastPrice ? "DOWN" : null;

    return { bought, winner };
  } catch {
    return { bought: null, winner: null };
  }
}

function main(): void {
  let totalRenamed = 0;
  let totalChecked = 0;
  let totalWithBuys = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) {
      console.log("Skipping (not found):", dir);
      continue;
    }

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".log") && f.startsWith("monitor_") && !f.includes("_diff"))
      .sort();

    console.log(`\n========== ${path.basename(dir)} (${files.length} files to check) ==========\n`);

    for (const file of files) {
      const filePath = path.join(dir, file);
      totalChecked++;

      const { bought, winner } = analyzeBuyAndWinner(filePath);

      if (!bought) continue; // no buy event in this log
      totalWithBuys++;

      if (!winner) {
        console.log(`  [SKIP] ${file} (bought ${bought}, but no price data for winner)`);
        continue;
      }

      if (bought !== winner) {
        // Add _diff before .log (or before _sold.log if present)
        let newName: string;
        if (file.endsWith("_sold.log")) {
          newName = file.replace(/_sold\.log$/, "_diff_sold.log");
        } else {
          newName = file.replace(/\.log$/, "_diff.log");
        }

        const newPath = path.join(dir, newName);
        if (fs.existsSync(newPath)) {
          console.log(`  [SKIP] ${file} → ${newName} (target exists)`);
          continue;
        }

        fs.renameSync(filePath, newPath);
        console.log(`  [RENAME] ${file} → ${newName} (bought ${bought}, winner ${winner})`);
        totalRenamed++;
      }
    }
  }

  console.log(`\n========== Summary ==========`);
  console.log(`Checked: ${totalChecked} files`);
  console.log(`With buy events: ${totalWithBuys} files`);
  console.log(`Renamed: ${totalRenamed} files (added "_diff" suffix for wrong predictions)`);
  console.log(`\n========== Done ==========`);
}

main();
