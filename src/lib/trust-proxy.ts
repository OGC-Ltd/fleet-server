/**
 * Which hops Express may believe about the client's address (`req.ip`).
 *
 * Production has TWO proxies on one of its routes. fleettrack.co.ke reaches
 * nginx directly, but fleettracking.ogc-monitoring.com is a LiteSpeed reverse
 * proxy on separate hosting (198.38.90.19) that forwards to that same nginx —
 * and it carried ~46% of the box's requests on 2026-10-06. With only one hop
 * trusted (`trust proxy 1`), every user on that domain resolved to LiteSpeed's
 * address, so all of them shared ONE per-IP rate-limit bucket: one 100/s API
 * allowance and one 20-per-15-minutes sign-in allowance between everyone.
 *
 * The rule, read from the socket outwards:
 *   - the immediate peer is trusted, whatever it is (nginx on loopback) —
 *     exactly the old `trust proxy 1`;
 *   - beyond it, only addresses named in TRUSTED_PROXY_IPS are trusted.
 * The first address NOT trusted is the client. A caller who reaches nginx
 * directly and writes their own X-Forwarded-For gains nothing: their real
 * address is the hop nginx appends, it is not on the list, so it is the one
 * that counts.
 */

const norm = (a: string): string => a.trim().replace(/^::ffff:/, '')

export function trustProxy(extra: readonly string[]): (addr: string, hop: number) => boolean {
  const trusted = new Set(extra.map(norm).filter(Boolean))
  return (addr, hop) => hop === 0 || trusted.has(norm(addr))
}

/** "a, b ,c" → ["a","b","c"] */
export const parseProxyList = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
