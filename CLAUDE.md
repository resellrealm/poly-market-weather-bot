# Polymarket Weather Trading Bot

## Overview
Kelly-criterion weather trading bot for Polymarket. Analyzes NWS forecasts to find mispriced temperature markets and trades them. Starting bankroll: **$38**.

## Tech Stack
- TypeScript / Node.js
- @polymarket/clob-client for market interaction
- NWS API for weather forecasts
- Kelly criterion for position sizing

## Project Structure
- `src/index.ts` — Entry point, CLI args
- `src/strategy.ts` — Kelly criterion trading logic
- `src/nws.ts` — NWS weather data fetching
- `src/polymarket.ts` — Polymarket API integration
- `src/parsing.ts` — Market data parsing
- `src/walletBalance.ts` — Balance tracking
- `src/simState.ts` — Simulation state management
- `src/config.ts` — Configuration loading
- `config.json` — Market configuration
- `simulation.json` — Performance tracking log

## Commands
```bash
npm run build                    # Compile TypeScript
node dist/index.js               # Paper trading (no real trades)
node dist/index.js --live        # Live simulated trading
node dist/index.js --live --interval 30  # Run every 30 mins
node dist/index.js --positions   # View current positions/PnL
node dist/index.js --reset       # Reset simulation balance to $38
```

## Strategy: Kelly Criterion (v2)
- **Probability estimation**: Uses NWS forecast + normal distribution (std error ~2-5°F scaling with time horizon) to estimate P(temp in bucket)
- **Kelly formula**: f* = (b*p - q) / b, applied with fractional multiplier
- **Position sizing**: min(Kelly fraction, max_position_pct) × bankroll
- **Risk controls**: stop-loss per position, max concurrent positions, max trades per run

## Config Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| entry_threshold | 0.15 | Buy when market price below this |
| exit_threshold | 0.45 | Sell when price above this |
| kelly_fraction | 0.25 | Fractional Kelly multiplier (quarter-Kelly) |
| max_position_pct | 0.20 | Max 20% of bankroll per trade |
| max_concurrent_positions | 3 | Max open positions at once |
| stop_loss_pct | 0.50 | Exit if position loses 50% of cost |
| max_trades_per_run | 3 | Limit entries per execution |

## Key Constraints
- $38 starting bankroll — position sizing must be conservative
- Quarter-Kelly (0.25x) default to protect against ruin on small bankroll
- Never risk more than 20% of bankroll ($7.60) on a single trade
- Max 3 concurrent positions to maintain diversification
- Stop-loss at -50% per position to limit downside
- Log everything to simulation.json for analysis

## Useful Reference Repos
- https://github.com/Polymarket/py-clob-client — Official Python CLOB client
- https://github.com/Polymarket/clob-client — Official JS/TS CLOB client
- Search GitHub for "polymarket bot" and "polymarket trading" for strategy ideas
