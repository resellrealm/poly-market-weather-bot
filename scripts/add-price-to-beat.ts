/**
 * Add "price to beat" line as the second line of each log file.
 * Extracts the Kalshi and Polymarket prices from the first Entry line.
 */
import * as fs from "fs";
import * as path from "path";

const DIRS = [
  path.resolve(__dirname, "../logs"),
  path.resolve(__dirname, "../kalshi-log"),
];

interface PriceToBeat {
  kalshi: number;
  polymarket: number;
}

/** Find first Entry line and extract prices */
function findPriceToBeat(content: string): PriceToBeat | null {
  const lines = content.split("\n");
  
  // Look for Entry line: [Kalshi1Poly] Entry (UP|DOWN): Kalshi (UP|DOWN) X.XX Poly (UP|DOWN) Y.YY
  for (const line of lines) {
    const match = line.match(/\[Kalshi1Poly\]\s+Entry\s+(UP|DOWN):\s+Kalshi\s+(?:UP|DOWN)\s+([\d.]+)\s+Poly\s+(?:UP|DOWN)\s+([\d.]+)/);
    if (match) {
      const kalshi = parseFloat(match[2]);
      const poly = parseFloat(match[3]);
      return { kalshi, polymarket: poly };
    }
  }
  
  return null;
}

function main(): void {
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalNoEntry = 0;

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

      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      // Check if second line already has "Price to beat"
      if (lines.length > 1 && lines[1].includes("Price to beat")) {
        // Already has price line, skip or update if needed
        continue;
      }

      // Find price to beat
      const prices = findPriceToBeat(content);
      if (!prices) {
        totalNoEntry++;
        continue;
      }

      // Insert as second line
      const priceLine = `# Price to beat - Kalshi: ${prices.kalshi.toFixed(2)} | Polymarket: ${prices.polymarket.toFixed(2)}`;
      lines.splice(1, 0, priceLine);
      
      fs.writeFileSync(filePath, lines.join("\n"), "utf8");
      console.log(`  [ADD] ${file} → Kalshi: ${prices.kalshi.toFixed(2)} | Polymarket: ${prices.polymarket.toFixed(2)}`);
      totalUpdated++;
    }
  }

  console.log(`\n========== Summary ==========`);
  console.log(`Processed: ${totalProcessed} files`);
  console.log(`Updated: ${totalUpdated} files (added price to beat)`);
  console.log(`No entry found: ${totalNoEntry} files (skipped)`);
  console.log(`\n========== Done ==========`);
}

main();
