export interface BotConfig {
  entry_threshold: number;
  exit_threshold: number;
  max_trades_per_run: number;
  min_hours_to_resolution: number;
  locations: string;
  polymarket_private_key: string;
  polymarket_proxy_wallet_address: string;
}

export const DEFAULT_CONFIG: BotConfig = {
  entry_threshold: 0.15,
  exit_threshold: 0.45,
  max_trades_per_run: 5,
  min_hours_to_resolution: 2,
  locations: "nyc,chicago,miami,dallas,seattle,atlanta",
  polymarket_private_key: "",
  polymarket_proxy_wallet_address: ""
};

export async function loadConfig(): Promise<BotConfig> {
  const parseNumber = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    entry_threshold: parseNumber(
      process.env.ENTRY_THRESHOLD,
      DEFAULT_CONFIG.entry_threshold
    ),
    exit_threshold: parseNumber(
      process.env.EXIT_THRESHOLD,
      DEFAULT_CONFIG.exit_threshold
    ),
    max_trades_per_run: parseNumber(
      process.env.MAX_TRADES_PER_RUN,
      DEFAULT_CONFIG.max_trades_per_run
    ),
    min_hours_to_resolution: parseNumber(
      process.env.MIN_HOURS_TO_RESOLUTION,
      DEFAULT_CONFIG.min_hours_to_resolution
    ),
    locations: process.env.LOCATIONS ?? DEFAULT_CONFIG.locations,
    polymarket_private_key: process.env.POLYMARKET_PRIVATE_KEY ?? "",
    polymarket_proxy_wallet_address:
      process.env.POLYMARKET_PROXY_WALLET_ADDRESS ?? ""
  };
}

export function getActiveLocations(cfg: BotConfig): string[] {
  return cfg.locations
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

