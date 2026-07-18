// ── VGC Browser — residential proxy keep-alive ───────────────────────────────
// Evomi hardsession residential IPs are held "as long as the session stays connected"
// (no lifetime cap). If a session goes idle, the peer can be recycled and the next use
// gets a NEW IP. This background service pokes every saved proxy on a short interval so
// its sticky session stays active and the IP is held for as long as the underlying peer
// is online (a home-broadband peer is on 24/7 → often many days). The poke is connect-only
// (≈no payload — see pokeProxy), so it barely touches the GB-metered residential balance.
// It CANNOT prevent an IP change when the real peer device goes offline — for a truly
// never-changing IP the account needs an ISP Static proxy instead.

import type { SavedProxy } from '../shared/types'
import { listProxies } from './proxy-store'
import { pokeProxy } from './proxy-check'
import { getSettings } from './settings'
import { dbg } from './dbg'

const INTERVAL_MS = 3 * 60 * 1000 // poke every 3 min — under typical sticky idle windows
const FIRST_DELAY_MS = 20 * 1000 // let the app settle before the first cycle
const CONCURRENCY = 6 // bounded in-flight pokes → no burst of connections

let timer: ReturnType<typeof setInterval> | null = null
let running = false

/** Poke a list of proxies with at most CONCURRENCY connections open at once. */
async function pokeAll(proxies: SavedProxy[]): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  let next = 0
  async function worker(): Promise<void> {
    while (next < proxies.length) {
      const p = proxies[next++]
      if (await pokeProxy(p)) ok++
      else fail++
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, proxies.length) }, () => worker())
  )
  return { ok, fail }
}

async function cycle(): Promise<void> {
  if (running) return // a slow cycle is still going — skip this tick rather than overlap
  running = true
  try {
    const settings = await getSettings()
    if (settings.proxyKeepAlive === false) return
    const proxies = (await listProxies()).filter((p) => p.host && p.port)
    if (proxies.length === 0) return
    const { ok, fail } = await pokeAll(proxies)
    dbg(`[keepalive] poked ${proxies.length} proxies — ${ok} alive, ${fail} unreachable`)
  } catch (e) {
    dbg(`[keepalive] cycle error: ${(e as Error).message}`)
  } finally {
    running = false
  }
}

/** Start the background keep-alive loop (idempotent). */
export function startProxyKeepAlive(): void {
  if (timer) return
  setTimeout(() => void cycle(), FIRST_DELAY_MS)
  timer = setInterval(() => void cycle(), INTERVAL_MS)
}

export function stopProxyKeepAlive(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
