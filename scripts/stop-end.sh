#!/usr/bin/env bash
# Stop the Kalshi-Poly "end" monitor. If the bot still runs after pm2 stop end,
# another instance is running outside PM2 — this script finds and kills those too.

set -e
echo "=== 1. Stop PM2 process 'end' ==="
pm2 stop end 2>/dev/null || true

echo ""
echo "=== 2. Find any other Node processes running the endside monitor ==="
PIDS=$(pgrep -f "run-kalshi-1-poly" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "Found: $PIDS"
  for pid in $PIDS; do ps -p "$pid" -o pid,args= 2>/dev/null || true; done
  echo "Killing them..."
  echo "$PIDS" | xargs -r kill
  echo "Done."
else
  echo "None found (only PM2 'end' was running it)."
fi

echo ""
pm2 list | grep -E "name|end" || true
