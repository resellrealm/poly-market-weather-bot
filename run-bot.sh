#!/bin/bash
# Run the Polymarket weather bot — ensures proxy is up, then executes one live trading pass
cd /root/projects/polymarket-bot-live

# Ensure proxy is running
./start-proxy.sh

# Run bot in live mode (single pass)
node dist/index.js --live
