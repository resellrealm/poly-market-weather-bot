/**
 * Polymarket token holdings: conditionId -> { tokenId: amount }.
 * Written when we buy (addHolding); used by redeem to know which markets to redeem.
 */
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const HOLDINGS_FILE = path.join(DATA_DIR, "token-holding.json");

export interface TokenHoldings {
  [conditionId: string]: {
    [tokenId: string]: number;
  };
}

function ensureDataDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

export function loadHoldings(): TokenHoldings {
  ensureDataDir();
  if (!fs.existsSync(HOLDINGS_FILE)) return {};
  try {
    const content = fs.readFileSync(HOLDINGS_FILE, "utf-8");
    return JSON.parse(content) as TokenHoldings;
  } catch {
    return {};
  }
}

export function saveHoldings(holdings: TokenHoldings): void {
  ensureDataDir();
  try {
    fs.writeFileSync(HOLDINGS_FILE, JSON.stringify(holdings, null, 2), "utf-8");
  } catch (e) {
    console.error("Failed to save holdings:", e);
  }
}

export function addHolding(conditionId: string, tokenId: string, amount: number): void {
  if (!conditionId || !tokenId || amount <= 0) return;
  const holdings = loadHoldings();
  if (!holdings[conditionId]) holdings[conditionId] = {};
  const current = holdings[conditionId][tokenId] ?? 0;
  holdings[conditionId][tokenId] = current + amount;
  saveHoldings(holdings);
  console.log(`[Holdings] +${amount} token ${tokenId.slice(0, 12)}... for condition ${conditionId.slice(0, 18)}...`);
}

export function getMarketHoldings(conditionId: string): Record<string, number> {
  return loadHoldings()[conditionId] ?? {};
}

export function getAllHoldings(): TokenHoldings {
  return loadHoldings();
}

export function clearMarketHoldings(conditionId: string): void {
  const holdings = loadHoldings();
  if (holdings[conditionId]) {
    delete holdings[conditionId];
    saveHoldings(holdings);
    console.log(`[Holdings] Cleared condition ${conditionId.slice(0, 18)}...`);
  }
}
