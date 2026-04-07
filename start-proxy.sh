#!/bin/bash
# Ensure WireGuard tunnel (Norway) and SOCKS5 proxy are running

if ! ip link show mullvad-no &>/dev/null; then
    echo "[proxy] Starting WireGuard tunnel to Norway..."
    wg-quick up mullvad-no
fi

if ! pgrep -f "microsocks.*1080" &>/dev/null; then
    echo "[proxy] Starting SOCKS5 proxy on :1080..."
    microsocks -i 127.0.0.1 -p 1080 -b 10.75.82.86 &
    sleep 1
fi

echo "[proxy] Tunnel and proxy ready (Norway)"
