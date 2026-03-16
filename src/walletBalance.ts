import axios from "axios";

const POLYGON_RPC = "https://polygon-rpc.com";
const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_DECIMALS = 6;
const BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * Get USDC balance for an address on Polygon (Polymarket proxy wallet).
 * Returns balance in USD (human-readable), or 0 on error.
 */
export async function getWalletBalanceUsd(
  walletAddress: string
): Promise<number> {
  const addr = (walletAddress || "").trim();
  if (!addr || !addr.startsWith("0x") || addr.length !== 42) {
    return 0;
  }

  const paddedAddr = addr.slice(2).toLowerCase().padStart(64, "0");
  const data = BALANCE_OF_SELECTOR + paddedAddr;

  try {
    const r = await axios.post(
      POLYGON_RPC,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [
          {
            to: USDC_POLYGON,
            data
          },
          "latest"
        ]
      },
      { timeout: 10000 }
    );

    const hex = r.data?.result as string | undefined;
    if (!hex || typeof hex !== "string") return 0;

    const raw = BigInt(hex);
    const balance = Number(raw) / 10 ** USDC_DECIMALS;
    return Number.isFinite(balance) ? balance : 0;
  } catch {
    return 0;
  }
}
