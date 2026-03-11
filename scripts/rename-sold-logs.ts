/**
 * Rename log files with sell events by adding "_sold" suffix.
 * Scans logs and kalshi-log folders for "[Kalshi1Poly] Sell successful" or "Exit:" with sell.
 */
import * as fs from "fs";
import * as path from "path";

const DIRS = [
  path.resolve(__dirname, "../logs"),
  path.resolve(__dirname, "../kalshi-log"),
];

function hasSellEvent(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // Look for sell success or exit with selling
    return /\[Kalshi1Poly\] Sell successful|Exit:.*selling/i.test(content);
  } catch {
    return false;
  }
}

function main(): void {
  let totalRenamed = 0;
  let totalChecked = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) {
      console.log("Skipping (not found):", dir);
      continue;
    }

    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".log") && f.startsWith("monitor_") && !f.includes("_sold"))
      .sort();

    console.log(`\n========== ${path.basename(dir)} (${files.length} files to check) ==========\n`);

    for (const file of files) {
      const filePath = path.join(dir, file);
      totalChecked++;

      if (hasSellEvent(filePath)) {
        // Add _sold before .log extension
        const newName = file.replace(/\.log$/, "_sold.log");
        const newPath = path.join(dir, newName);

        if (fs.existsSync(newPath)) {
          console.log(`  [SKIP] ${file} → ${newName} (target exists)`);
          continue;
        }

        fs.renameSync(filePath, newPath);
        console.log(`  [RENAME] ${file} → ${newName}`);
        totalRenamed++;
      }
    }
  }

  console.log(`\n========== Summary ==========`);
  console.log(`Checked: ${totalChecked} files`);
  console.log(`Renamed: ${totalRenamed} files (added "_sold" suffix)`);
  console.log(`\n========== Done ==========`);
}

main();
