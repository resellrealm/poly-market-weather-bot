import { Wallet } from "@ethersproject/wallet";
import { ClobClient, AssetType } from "@polymarket/clob-client";
import type { BotConfig } from "./config";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const USDC_DECIMALS = 6;

/**
 * Derive API credentials from the wallet private key.
 * Returns { key, secret, passphrase } needed for authenticated CLOB calls.
 */
export async function deriveApiCreds(cfg: BotConfig) {
  const pk = (cfg.polymarket_private_key || "").trim();
  if (!pk) throw new Error("Missing private key");

  const wallet = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
  return tempClient.deriveApiKey(0);
}

/**
 * Build a fully authenticated ClobClient for trading.
 */
export async function buildClobClient(cfg: BotConfig): Promise<ClobClient> {
  const pk = (cfg.polymarket_private_key || "").trim();
  const wallet = new Wallet(pk.startsWith("0x") ? pk : "0x" + pk);
  const apiCreds = await deriveApiCreds(cfg);
  const signatureType = cfg.signature_type;
  const funderAddress =
    signatureType === 1 || signatureType === 2
      ? (cfg.polymarket_proxy_wallet_address || "").trim()
      : undefined;

  return new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    apiCreds,
    signatureType,
    funderAddress || undefined
  );
}

/**
 * Get USDC balance via Polymarket CLOB API.
 * Returns balance in USD, or 0 on error.
 */
export async function getWalletBalanceUsdViaClob(cfg: BotConfig): Promise<number> {
  try {
    const client = await buildClobClient(cfg);
    const res = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL
    });
    const raw = parseFloat(res?.balance ?? "0");
    const balance = raw / 10 ** USDC_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    return 0;
  }
}
