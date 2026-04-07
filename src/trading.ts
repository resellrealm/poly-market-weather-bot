import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import logger from "terminal-structured-logger";
import type { BotConfig } from "./config";
import { buildClobClient } from "./walletBalance";

let _client: ClobClient | null = null;

/**
 * Get or create a cached CLOB client for the session.
 */
export async function getClobClient(cfg: BotConfig): Promise<ClobClient> {
  if (!_client) {
    _client = await buildClobClient(cfg);
  }
  return _client;
}

/**
 * Place a real BUY YES limit order on Polymarket via the CLOB.
 * Returns the order ID on success, or null on failure.
 */
export async function placeBuyOrder(
  cfg: BotConfig,
  tokenId: string,
  price: number,
  size: number
): Promise<string | null> {
  try {
    const client = await getClobClient(cfg);
    const tickSize = await client.getTickSize(tokenId);
    const negRisk = await client.getNegRisk(tokenId);

    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );

    if (result?.orderID) {
      logger.info(`Order placed: ${result.orderID} (status: ${result.status})`);
      return result.orderID;
    }
    logger.warn(`Order response: ${JSON.stringify(result)}`);
    return null;
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.response?.data || e.message;
    logger.error(`Failed to place order: ${JSON.stringify(msg)}`);
    return null;
  }
}

/**
 * Place a real SELL YES limit order on Polymarket via the CLOB.
 * Returns the order ID on success, or null on failure.
 */
export async function placeSellOrder(
  cfg: BotConfig,
  tokenId: string,
  price: number,
  size: number
): Promise<string | null> {
  try {
    const client = await getClobClient(cfg);
    const tickSize = await client.getTickSize(tokenId);
    const negRisk = await client.getNegRisk(tokenId);

    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.SELL,
      },
      { tickSize, negRisk },
      OrderType.GTC
    );

    if (result?.orderID) {
      logger.info(`Sell order placed: ${result.orderID} (status: ${result.status})`);
      return result.orderID;
    }
    logger.warn(`Sell order response: ${JSON.stringify(result)}`);
    return null;
  } catch (e: any) {
    const msg = e?.response?.data?.error || e?.response?.data || e.message;
    logger.error(`Failed to place sell order: ${JSON.stringify(msg)}`);
    return null;
  }
}
