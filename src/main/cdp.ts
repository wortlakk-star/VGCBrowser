// ── VGC Browser — minimal Chrome DevTools Protocol client ─────────────────────
// A tiny CDP client over a single browser-level WebSocket. We use `flatten`
// auto-attach so every page/iframe session multiplexes over this one socket
// (each message carries a sessionId). This is how antidetect tools inject
// overrides into every tab the user opens — not just the first.

import WebSocket from 'ws'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: unknown
  error?: { message?: string }
}

export class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, EventHandler[]>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (data: WebSocket.RawData) => this.onMessage(data.toString()))
    // If the browser dies, the socket closes/errors. Without this, every in-flight
    // send() (and any future one) would hang forever — wedging attachInjector and
    // leaking promises. Reject all pending and mark the connection dead.
    this.ws.on('close', () => this.failAllPending('CDP connection closed'))
    this.ws.on('error', () => this.failAllPending('CDP connection error'))
  }

  private failAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const err = new Error(reason)
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    })
    return new CdpConnection(ws)
  }

  on(method: string, handler: EventHandler): void {
    const list = this.handlers.get(method) ?? []
    list.push(handler)
    this.handlers.set(method, list)
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const msg: CdpMessage = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      })
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    }) as Promise<Record<string, unknown>>
  }

  private onMessage(raw: string): void {
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }

    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result ?? {})
      return
    }

    if (msg.method) {
      const list = this.handlers.get(msg.method)
      if (list) for (const h of list) h(msg.params ?? {}, msg.sessionId)
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}

/**
 * Poll the DevTools HTTP endpoint until the browser is up, then return its
 * browser-level WebSocket debugger URL.
 */
export async function getBrowserWsUrl(port: number, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string }
        if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl
      }
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Không kết nối được CDP ở cổng ${port}: ${String(lastErr)}`)
}
