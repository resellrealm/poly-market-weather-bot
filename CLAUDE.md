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
node dist/index.js --reset       # Reset simulation balance
```

## Agent Optimization Goals
1. **Improve entry/exit thresholds** — backtest different values to maximize Sharpe ratio
2. **Add more weather data sources** — cross-reference NWS with other APIs for higher confidence
3. **Expand market coverage** — look beyond temperature (precipitation, wind, storms)
4. **Optimize Kelly fraction** — use fractional Kelly (e.g., half-Kelly) to reduce variance on small bankroll
5. **Learn from simulation.json** — analyze past trades for pattern recognition
6. **Research other Polymarket bot repos** for additional strategies and edge detection

## Key Constraints
- $38 starting bankroll — position sizing must be conservative
- Use fractional Kelly (0.25-0.5x) to protect against ruin
- Never risk more than 20% of bankroll on a single trade
- Log everything to simulation.json for analysis

## Useful Reference Repos
- https://github.com/Polymarket/py-clob-client — Official Python CLOB client
- https://github.com/Polymarket/clob-client — Official JS/TS CLOB client
- Search GitHub for "polymarket bot" and "polymarket trading" for strategy ideas
