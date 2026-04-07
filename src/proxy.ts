import dns from "dns";

/**
 * Force IPv4 DNS resolution and set POLYMARKET_SOCKS_PROXY env var.
 * The actual proxy injection is done via a patch in the CLOB client's
 * bundled axios adapter (node_modules/@polymarket/clob-client/node_modules/axios/lib/adapters/http.js).
 */
export function installClobProxy(): void {
  // Force IPv4 DNS resolution globally — prevents IPv6 from bypassing the SOCKS tunnel
  dns.setDefaultResultOrder("ipv4first");

  console.log(`  🇳🇴 CLOB proxy: Norway via Mullvad (SOCKS5 127.0.0.1:1080, IPv4 forced)`);
}
