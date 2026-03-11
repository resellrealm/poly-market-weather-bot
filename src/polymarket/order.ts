/**
 * Place FOK (Fill-or-Kill) market buy orders on Polymarket CLOB.
 * Order status is logged 2s after placement.
 */
import * as fs from "fs";
import * as path from "path";
import { Side, OrderType, AssetType } from "@polymarket/clob-client";
import {
  POLYMARKET_PRIVATE_KEY,
  POLYMARKET_PROXY,
  POLYMARKET_CLOB_URL,
  POLYMARKET_CHAIN_ID,
  POLYMARKET_TICK_SIZE,
  POLYMARKET_NEG_RISK,
  POLYMARKET_CREDENTIAL_PATH,
  POLYMARKET_SIGNATURE_TYPE,
  POLYMARKET_MIN_USD,
  POLY_BUY_LIMIT_BUFFER,
  ARB_DRY_RUN,
} from "../core/config";
import { appendMonitorLogWithTimestamp } from "../core/monitor-logger";
import { addHolding } from "./holdings";

export type PlacePolyResult = { orderId: string } | { error: string } | null;

export interface PlacePolymarketOrderOptions {
  tickSize?: "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  forcePlace?: boolean;
  conditionId?: string;
}

let cachedClient: Awaited<ReturnType<typeof buildClobClient>> | null = null;
let cachedClientKey: string = "";

async function buildClobClient(): Promise<
  import("@polymarket/clob-client").ClobClient
> {
  const { Wallet } = await import("ethers");
  const { ClobClient } = await import("@polymarket/clob-client");
  const host = POLYMARKET_CLOB_URL;
  const chainId = POLYMARKET_CHAIN_ID;
  const signer = new Wallet(
    POLYMARKET_PRIVATE_KEY.startsWith("0x")
      ? POLYMARKET_PRIVATE_KEY
      : `0x${POLYMARKET_PRIVATE_KEY}`
  );

  let creds: import("@polymarket/clob-client").ApiKeyCreds;
  if (POLYMARKET_CREDENTIAL_PATH && fs.existsSync(POLYMARKET_CREDENTIAL_PATH)) {
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), POLYMARKET_CREDENTIAL_PATH),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { key: string; secret: string; passphrase: string };
    const secretBase64 = (parsed.secret ?? "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    creds = {
      key: parsed.key,
      secret: secretBase64,
      passphrase: parsed.passphrase ?? "",
    };
  } else {
    const tempClient = new ClobClient(host, chainId, signer);
    creds = await tempClient.createOrDeriveApiKey();
  }

  return new ClobClient(host, chainId, signer, creds, POLYMARKET_SIGNATURE_TYPE, POLYMARKET_PROXY);
}

function getClientKey(): string {
  return `${POLYMARKET_CLOB_URL}|${POLYMARKET_CHAIN_ID}|${POLYMARKET_CREDENTIAL_PATH || "derive"}|${POLYMARKET_SIGNATURE_TYPE}`;
}

function roundPriceToTickSize(price: number, tickSize: string): number {
  const decimals =
    tickSize === "0.01"
      ? 2
      : tickSize === "0.001"
        ? 3
        : tickSize === "0.0001"
          ? 4
          : 4;
  const mult = 10 ** decimals;
  return Math.round(price * mult) / mult;
}

async function getClobClient(): Promise<
  import("@polymarket/clob-client").ClobClient
> {
  const key = getClientKey();
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = await buildClobClient();
  cachedClientKey = key;
  return cachedClient;
}

export function clearPolymarketClientCache(): void {
  cachedClient = null;
  cachedClientKey = "";
}

/** Preload CLOB client so first arb order is not delayed. Call at monitor startup. */
export function warmPolymarketClient(): void {
  if (!POLYMARKET_PRIVATE_KEY || !POLYMARKET_PROXY) return;
  getClobClient().catch(() => {});
}

/** USDC uses 6 decimals on-chain/CLOB; raw balance must be divided by this to get USD. */
const USDC_DECIMALS = 1_000_000;

/** Get Polymarket CLOB collateral (USDC) balance in USD. Returns null if Polymarket is not configured. */
export async function getPolymarketBalanceUsd(): Promise<number | null> {
  if (!POLYMARKET_PRIVATE_KEY || !POLYMARKET_PROXY) return null;
  try {
    const client = await getClobClient();
    const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = (res as { balance?: string }).balance ?? "0";
    const rawNum = parseFloat(raw) || 0;
    return rawNum / USDC_DECIMALS;
  } catch {
    return null;
  }
}

/** Delay (ms) before we check order status after place. 200ms gives the API time to have the order available. */
const FULFILLMENT_CHECK_MS = 200;

/**
 * Schedule a fulfillment check 200ms after order placement: log Polymarket order status (fulfilled or not).
 */
function scheduleFulfillmentCheck(
  orderId: string,
  clobClient: Awaited<ReturnType<typeof getClobClient>>
): void {
  setTimeout(async () => {
    try {
      const order = await clobClient.getOrder(orderId);
      if (order == null || typeof order !== "object") {
        const logMsg = `[Polymarket order] Not found 200ms after place (may be filled or cancelled): orderId=${orderId}`;
        console.log(logMsg);
        appendMonitorLogWithTimestamp(logMsg);
        return;
      }
      const o = order as { original_size?: string; size_matched?: string; status?: string };
      const original = parseFloat(o.original_size ?? "0");
      const matched = parseFloat(o.size_matched ?? "0");
      const status = o.status ?? "";
      const fulfilled = original > 0 && matched >= original;
      const statusLine = `orderId=${orderId} status=${status} matched=${matched} original=${original}`;
      const logMsg = fulfilled
        ? `[Polymarket order] Fulfilled — ${statusLine}`
        : `[Polymarket order] Not fulfilled — ${statusLine}`;
      console.log(logMsg);
      appendMonitorLogWithTimestamp(logMsg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const logMsg = `[Polymarket order] Not found (may be filled or cancelled): orderId=${orderId} — ${msg}`;
      console.log(logMsg);
      appendMonitorLogWithTimestamp(logMsg);
    }
  }, FULFILLMENT_CHECK_MS);
}

export async function placePolymarketOrder(
  tokenId: string,
  price: number,
  size: number,
  options?: PlacePolymarketOrderOptions
): Promise<PlacePolyResult> {
  if (!POLYMARKET_PRIVATE_KEY || !POLYMARKET_PROXY) {
    const msg = `[Polymarket] Not configured (missing POLYMARKET_PRIVATE_KEY or POLYMARKET_PROXY). Would buy token ${tokenId.slice(0, 8)}... @ ${price.toFixed(3)} x${size}`;
    console.log(msg);
    appendMonitorLogWithTimestamp(msg);
    return null;
  }
  if (ARB_DRY_RUN && !options?.forcePlace) {
    return null;
  }
  const minUsd = POLYMARKET_MIN_USD > 0 ? POLYMARKET_MIN_USD : 1;
  if (price * size < minUsd) {
    const msg = `Polymarket order notional $${(price * size).toFixed(2)} below min $${minUsd}. Use size >= ${Math.ceil(minUsd / price)} (or set POLYMARKET_MIN_USD).`;
    console.error(msg);
    appendMonitorLogWithTimestamp(msg);
    return { error: msg };
  }
  try {
    const clobClient = await getClobClient();
    const tickSize = options?.tickSize ?? POLYMARKET_TICK_SIZE;
    const negRisk = options?.negRisk ?? POLYMARKET_NEG_RISK;

    // Limit buy: price = Math.min(recent price + buffer, 0.99). GTC so order rests on book if not immediately filled.
    const limitPrice = Math.min(price + POLY_BUY_LIMIT_BUFFER, 0.99);
    const roundedPrice = roundPriceToTickSize(limitPrice, tickSize);
    const notionalUsd = roundedPrice * size;
    if (roundedPrice * size < minUsd) {
      const msg = `Polymarket limit order notional $${(roundedPrice * size).toFixed(2)} below min $${minUsd}.`;
      console.error(msg);
      appendMonitorLogWithTimestamp(msg);
      return { error: msg };
    }
    const resp = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        side: Side.BUY,
        size,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );
    const data = resp as { orderID?: string; orderId?: string; error?: string; errorMsg?: string };
    const orderId = data.orderID ?? data.orderId;
    const errMsg = data.error ?? data.errorMsg;
    if (errMsg || !orderId) {
      const msg = errMsg ?? "No order ID in response";
      console.error("Polymarket limit buy order failed:", msg);
      appendMonitorLogWithTimestamp(`Polymarket limit buy order failed: ${msg}`);
      return { error: msg };
    }
    const msg = `Polymarket limit buy placed: ${orderId} token=${tokenId.slice(0, 12)}... notional=$${notionalUsd.toFixed(2)} (limitPrice=${roundedPrice} size=${size})`;
    console.log(msg);
    appendMonitorLogWithTimestamp(msg);
    if (options?.conditionId) {
      addHolding(options.conditionId, tokenId, size);
    }
    scheduleFulfillmentCheck(String(orderId), clobClient);
    return { orderId: String(orderId) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const resp = (err as { response?: { data?: unknown } })?.response?.data;
    const detail = resp != null ? ` ${JSON.stringify(resp)}` : "";
    console.error("Polymarket order failed:", msg + detail);
    appendMonitorLogWithTimestamp(`Polymarket order failed: ${msg}${detail}`);
    return { error: detail ? `${msg}${detail}` : msg };
  }
}

/** Sell Polymarket tokens (FAK market sell). Amount = number of shares to sell. Buys use FOK; sells use FAK. */
export async function sellPolymarketOrder(
  tokenId: string,
  size: number,
  options?: PlacePolymarketOrderOptions
): Promise<PlacePolyResult> {
  if (!POLYMARKET_PRIVATE_KEY || !POLYMARKET_PROXY) {
    return null;
  }
  if (ARB_DRY_RUN && !options?.forcePlace) {
    return null;
  }
  if (size <= 0) {
    return { error: "Sell size must be positive" };
  }
  try {
    const clobClient = await getClobClient();
    const tickSize = options?.tickSize ?? POLYMARKET_TICK_SIZE;
    const negRisk = options?.negRisk ?? POLYMARKET_NEG_RISK;
    const resp = await clobClient.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount: size,
        side: Side.SELL,
      },
      { tickSize, negRisk },
      OrderType.FAK
    );
    const data = resp as { orderID?: string; orderId?: string; error?: string; errorMsg?: string };
    const orderId = data.orderID ?? data.orderId;
    const errMsg = data.error ?? data.errorMsg;
    if (errMsg || !orderId) {
      const msg = errMsg ?? "No order ID in response";
      console.error("Polymarket FAK sell failed:", msg);
      appendMonitorLogWithTimestamp(`Polymarket FAK sell failed: ${msg}`);
      return { error: msg };
    }
    const logMsg = `Polymarket FAK sell placed: ${orderId} token=${tokenId.slice(0, 12)}... size=${size}`;
    console.log(logMsg);
    appendMonitorLogWithTimestamp(logMsg);
    return { orderId: String(orderId) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Polymarket sell failed:", msg);
    appendMonitorLogWithTimestamp(`Polymarket sell failed: ${msg}`);
    return { error: msg };
  }
}
