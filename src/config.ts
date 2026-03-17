/** Wallet signature type: 0 = EOA, 1 = Polymarket proxy (Magic), 2 = Gnosis Safe */
export type SignatureType = 0 | 1 | 2;

export interface BotConfig {
  entry_threshold: number;
  exit_threshold: number;
  max_trades_per_run: number;
  min_hours_to_resolution: number;
  locations: string;
  /** Fractional Kelly multiplier (0.25 = quarter-Kelly, 0.5 = half-Kelly). Reduces variance. */
  kelly_fraction: number;
  /** Maximum percentage of bankroll risked on any single trade (0.20 = 20%) */
  max_position_pct: number;
  /** Maximum number of concurrent open positions */
  max_concurrent_positions: number;
  /** Stop-loss threshold: exit if position loses this fraction of cost (0.5 = -50%) */
  stop_loss_pct: number;
  polymarket_private_key: string;
  polymarket_proxy_wallet_address: string;
  /** Use proxy/safe wallet (funds at proxy address). If true, signature_type defaults to 2. */
  use_proxy_wallet: boolean;
  /** 0 = EOA, 1 = Polymarket proxy, 2 = Gnosis Safe. When use_proxy_wallet=true default is 2. */
  signature_type: SignatureType;
}

export const DEFAULT_CONFIG: BotConfig = {
  entry_threshold: 0.15,
  exit_threshold: 0.45,
  max_trades_per_run: 3,
  min_hours_to_resolution: 2,
  locations: "nyc,chicago,miami,dallas,seattle,atlanta",
  kelly_fraction: 0.25,
  max_position_pct: 0.20,
  max_concurrent_positions: 3,
  stop_loss_pct: 0.50,
  polymarket_private_key: "",
  polymarket_proxy_wallet_address: "",
  use_proxy_wallet: false,
  signature_type: 0
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
    kelly_fraction: parseNumber(
      process.env.KELLY_FRACTION,
      DEFAULT_CONFIG.kelly_fraction
    ),
    max_position_pct: parseNumber(
      process.env.MAX_POSITION_PCT,
      DEFAULT_CONFIG.max_position_pct
    ),
    max_concurrent_positions: parseNumber(
      process.env.MAX_CONCURRENT_POSITIONS,
      DEFAULT_CONFIG.max_concurrent_positions
    ),
    stop_loss_pct: parseNumber(
      process.env.STOP_LOSS_PCT,
      DEFAULT_CONFIG.stop_loss_pct
    ),
    polymarket_private_key: process.env.POLYMARKET_PRIVATE_KEY ?? "",
    polymarket_proxy_wallet_address:
      process.env.POLYMARKET_PROXY_WALLET_ADDRESS ?? "",
    use_proxy_wallet:
      (process.env.USE_PROXY_WALLET ?? "").toLowerCase() === "true",
    signature_type: (() => {
      const raw = process.env.SIGNATURE_TYPE ?? "";
      if (raw === "1") return 1 as SignatureType;
      if (raw === "2") return 2 as SignatureType;
      return (process.env.USE_PROXY_WALLET ?? "").toLowerCase() === "true"
        ? (2 as SignatureType)
        : (0 as SignatureType);
    })()
  };
}

export function getActiveLocations(cfg: BotConfig): string[] {
  return cfg.locations
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

