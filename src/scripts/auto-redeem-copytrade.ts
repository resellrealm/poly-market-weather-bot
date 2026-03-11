#!/usr/bin/env node
/**
 * Auto-redeem for Polymarket positions (forked from polymarket-copytrading-bot-ts).
 * Uses data/token-holding.json; when using Gnosis Safe (POLYMARKET_PROXY), redeems via Safe.
 *
 * - Runs every 160 seconds
 * - Checks all conditionIds in data/token-holding.json
 * - Redeems winning positions (via EOA or via Safe if proxy is set)
 * - Clears redeemed (or losing) positions from holdings
 *
 * Usage:
 *   npm run auto-redeem
 *   npx ts-node src/scripts/auto-redeem-copytrade.ts
 */
import "dotenv/config";
import path from "path";
import { redeemMarket, isMarketResolved } from "../polymarket/redeem";
import { getAllHoldings, clearMarketHoldings } from "../polymarket/holdings";
import { POLYMARKET_PROXY } from "../core/config";

const REDEEM_INTERVAL_MS = 120 * 1000; // 160 seconds
const HOLDINGS_FILE = path.resolve(process.cwd(), "data/token-holding.json");

let totalChecks = 0;
let totalRedeemed = 0;
let totalFailed = 0;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function checkAndRedeemPositions(): Promise<void> {
  totalChecks++;
  log("═".repeat(60));
  log(`AUTO-REDEEM CHECK #${totalChecks}`);
  log("═".repeat(60));

  const holdings = getAllHoldings();
  const marketIds = Object.keys(holdings);

  if (marketIds.length === 0) {
    log("No open positions (data/token-holding.json is empty).");
    log("═".repeat(60) + "\n");
    return;
  }

  log(`Checking ${marketIds.length} market(s)...`);
  let redeemedCount = 0;
  let failedCount = 0;
  let notResolvedCount = 0;

  for (const conditionId of marketIds) {
    const tokens = holdings[conditionId];
    const tokenIds = Object.keys(tokens);
    const totalAmount = Object.values(tokens).reduce((sum, amt) => sum + amt, 0);

    try {
      log(`Checking ${conditionId.substring(0, 24)}... (${tokenIds.length} token(s), ${totalAmount.toFixed(2)} total)`);

      const { isResolved, winningIndexSets } = await isMarketResolved(conditionId);

      if (!isResolved) {
        notResolvedCount++;
        log("  Status: not resolved yet");
        continue;
      }

      log(`  Status: resolved. Winning: ${winningIndexSets?.join(", ") ?? "?"}`);
      log("  Attempting redemption...");

      try {
        await redeemMarket(conditionId);
        clearMarketHoldings(conditionId);
        redeemedCount++;
        totalRedeemed++;
        log("  REDEEMED successfully; cleared from holdings.");
      } catch (redeemErr) {
        failedCount++;
        totalFailed++;
        const errMsg = redeemErr instanceof Error ? redeemErr.message : String(redeemErr);
        if (
          errMsg.includes("don't hold any winning tokens") ||
          errMsg.includes("You don't have any tokens")
        ) {
          log("  Don't hold winning tokens (lost position); clearing from holdings.");
          clearMarketHoldings(conditionId);
        } else {
          log(`  Redemption failed: ${errMsg}`);
        }
      }
    } catch (e) {
      failedCount++;
      log(`  Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const remaining = Object.keys(getAllHoldings()).length;
  log("─".repeat(60));
  log(`Summary: ${marketIds.length} total, ${notResolvedCount} not resolved, ${redeemedCount} redeemed, ${failedCount} failed, ${remaining} remaining`);
  log("═".repeat(60));
  log(`Next check in ${REDEEM_INTERVAL_MS / 1000}s...\n`);
}

async function main(): Promise<void> {
  console.log("\n" + "═".repeat(60));
  console.log("AUTO-REDEEM FOR COPY TRADE POSITIONS");
  console.log("═".repeat(60));
  console.log(`Holdings: ${HOLDINGS_FILE}`);
  console.log(`Interval: ${REDEEM_INTERVAL_MS / 1000}s`);
  console.log(`Proxy (Safe): ${POLYMARKET_PROXY || "(none – EOA redeem)"}`);
  console.log("═".repeat(60) + "\n");

  const holdings = getAllHoldings();
  const count = Object.keys(holdings).length;
  if (count > 0) {
    log(`Found ${count} market(s) with holdings to monitor.\n`);
  } else {
    log("No open positions.\n");
  }

  log("Running initial redemption check...\n");
  await checkAndRedeemPositions();

  setInterval(async () => {
    try {
      await checkAndRedeemPositions();
    } catch (e) {
      log(`Error during check: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, REDEEM_INTERVAL_MS);

  log("Auto-redeem service running. Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    log("Stopping auto-redeem...");
    log(`Stats: checks=${totalChecks} redeemed=${totalRedeemed} failed=${totalFailed}`);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("Stopping auto-redeem...");
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
