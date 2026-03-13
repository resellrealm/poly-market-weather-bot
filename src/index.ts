#!/usr/bin/env node
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { BotConfig, loadConfig } from "./config";
import { resetSim } from "./simState";
import { run, showPositions } from "./strategy";

dotenv.config();

function validateKeys(cfg: BotConfig): void {
  const errors: string[] = [];
  let pk = (cfg.polymarket_private_key || "").trim();
  const addr = (cfg.polymarket_proxy_wallet_address || "").trim();

  if (!pk) {
    errors.push("POLYMARKET_PRIVATE_KEY is missing in .env");
  } else {
    // Allow both 0x-prefixed and bare 64-hex private keys
    const bare = pk.startsWith("0x") ? pk.slice(2) : pk;
    if (!/^[a-fA-F0-9]{64}$/.test(bare)) {
      errors.push(
        "POLYMARKET_PRIVATE_KEY must be 64 hex characters (with or without 0x prefix)"
      );
    } else {
      // Normalize to 0x-prefixed form for downstream use
      pk = "0x" + bare;
      cfg.polymarket_private_key = pk;
      process.env.POLYMARKET_PRIVATE_KEY = pk;
    }
  }

  if (!addr) {
    errors.push("POLYMARKET_PROXY_WALLET_ADDRESS is missing in .env");
  } else if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    errors.push(
      "POLYMARKET_PROXY_WALLET_ADDRESS must be a 0x-prefixed 40-hex address"
    );
  }

  if (errors.length) {
    console.error("\nConfiguration error:\n- " + errors.join("\n- "));
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("weatherbot-ts")
    .option("live", {
      type: "boolean",
      default: false,
      describe: "Execute trades (updates simulation balance)"
    })
    .option("interval", {
      type: "number",
      default: 0,
      describe:
        "Run in a loop every N minutes (only with --live). e.g. 30 = every 30 min"
    })
    .option("positions", {
      type: "boolean",
      default: false,
      describe: "Show open positions"
    })
    .option("reset", {
      type: "boolean",
      default: false,
      describe: "Reset simulation to $1000"
    })
    .help()
    .parseAsync();

  const cfg = await loadConfig();
  validateKeys(cfg);

  if (argv.reset) {
    await resetSim();
    return;
  }

  if (argv.positions) {
    await showPositions();
    return;
  }

  const live = Boolean(argv.live);
  const intervalMin =
    live && typeof argv.interval === "number" && argv.interval > 0
      ? argv.interval
      : 0;

  if (intervalMin > 0) {
    const intervalSec = intervalMin * 60;
    console.log(
      `  🔄 Running every ${intervalMin.toFixed(
        1
      )} min (Ctrl+C to stop)\n`
    );
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await run({ dryRun: !live, config: cfg });
      console.log(
        `\n  ⏳ Next run in ${intervalMin.toFixed(1)} min...\n`
      );
      await new Promise((res) => setTimeout(res, intervalSec * 1000));
    }
  } else {
    await run({ dryRun: !live, config: cfg });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

