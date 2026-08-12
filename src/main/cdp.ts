// ── VGC Browser — minimal Chrome DevTools Protocol client ─────────────────────
// A tiny CDP client over a single browser-level WebSocket. We use `flatten`
// auto-attach so every page/iframe session multiplexes over this one socket
// (each message carries a sessionId). This is how antidetect tools inject
// overrides into every tab the user opens — not just the first.

import WebSocket from 'ws'
import { readLimitedResponseJson } from './http-limit'
import type { Readable, Writable } from 'node:stream'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
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
  private static readonly MAX_MESSAGE_BYTES = 64 * 1024 * 1024
  private static readonly COMMAND_TIMEOUT_MS = 60_000
  private nextId = 1
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, EventHandler[]>()
  // Transport-agnostic core: WebSocket (port mode) OR a pipe (--remote-debugging-pipe).
  private writeRaw: (data: string) => void
  private closeRaw: () => void
  private closed = false

  private constructor(writeRaw: (data: string) => void, closeRaw: () => void) {
    this.writeRaw = writeRaw
    this.closeRaw = closeRaw
  }

  private failAllPending(reason: string): void {
    this.closed = true
    const err = new Error(reason)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /** Connect over the browser-level WebSocket (requires --remote-debugging-port). */
  static async connect(wsUrl: string): Promise<CdpConnection> {
    const parsed = new URL(wsUrl)
    if (
      parsed.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(parsed.pathname)
    ) {
      throw new Error('CDP WebSocket URL không hợp lệ')
    }
    const ws = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      maxPayload: CdpConnection.MAX_MESSAGE_BYTES,
      handshakeTimeout: 10_000
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    })
    const conn = new CdpConnection(
      (data) => ws.send(data),
      () => {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    )
    ws.on('message', (data: WebSocket.RawData) => conn.onMessage(data.toString()))
    // If the browser dies, the socket closes/errors. Without this, every in-flight
    // send() (and any future one) would hang forever — wedging attachInjector and
    // leaking promises. Reject all pending and mark the connection dead.
    ws.on('close', () => conn.failAllPending('CDP connection closed'))
    ws.on('error', () => conn.failAllPending('CDP connection error'))
    return conn
  }

  /**
   * Connect over a PIPE (browser launched with --remote-debugging-pipe). CDP JSON
   * messages are NUL-delimited on the child's inherited fds: we WRITE commands to
   * fd 3 (writeStream) and READ events/results from fd 4 (readStream). There is NO
   * TCP debug port, so Google's "this browser or app may not be secure" debug-port
   * detection has nothing to find — the standard antidetect/Puppeteer approach.
   */
  static connectPipe(writeStream: Writable, readStream: Readable): CdpConnection {
    const conn = new CdpConnection(
      (data) => {
        writeStream.write(data + '\0')
      },
      () => {
        try {
          writeStream.end()
        } catch {
          // ignore
        }
      }
    )
    // Accumulate raw bytes and split on NUL (0x00) — binary-safe across chunk
    // boundaries (a multi-byte UTF-8 char can straddle two 'data' events).
    let buf = Buffer.alloc(0)
    readStream.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length > CdpConnection.MAX_MESSAGE_BYTES) {
        buf = Buffer.alloc(0)
        conn.failAllPending('CDP pipe message too large')
        try {
          readStream.destroy()
        } catch {
          // ignore
        }
        return
      }
      let nul = buf.indexOf(0)
      while (nul !== -1) {
        const msg = buf.subarray(0, nul).toString('utf8')
        buf = buf.subarray(nul + 1)
        if (msg) conn.onMessage(msg)
        nul = buf.indexOf(0)
      }
    })
    readStream.on('close', () => conn.failAllPending('CDP pipe closed'))
    readStream.on('error', () => conn.failAllPending('CDP pipe error'))
    return conn
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
    if (this.closed) return Promise.reject(new Error('CDP connection closed'))
    const id = this.nextId++
    const msg: CdpMessage = { id, method, params }
    if (sessionId) msg.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, CdpConnection.COMMAND_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })
      try {
        this.writeRaw(JSON.stringify(msg))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }) as Promise<Record<string, unknown>>
  }

  private onMessage(raw: string): void {
    if (Buffer.byteLength(raw, 'utf8') > CdpConnection.MAX_MESSAGE_BYTES) {
      this.failAllPending('CDP message too large')
      this.closeRaw()
      return
    }
    let msg: CdpMessage
    try {
      msg = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }

    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
      else p.resolve(msg.result ?? {})
      return
    }

    if (msg.method) {
      const list = this.handlers.get(msg.method)
      if (list) {
        for (const h of list) {
          try {
            h(msg.params ?? {}, msg.sessionId)
          } catch {
            // One event consumer must not break the CDP transport.
          }
        }
      }
    }
  }

  close(): void {
    this.failAllPending('CDP connection closed')
    this.closeRaw()
  }
}

/**
 * Poll the DevTools HTTP endpoint until the browser is up, then return its
 * browser-level WebSocket debugger URL.
 */
export async function getBrowserWsUrl(port: number, timeoutMs = 15000): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDP port không hợp lệ')
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
        redirect: 'error'
      })
      if (res.ok) {
        const json = await readLimitedResponseJson<{ webSocketDebuggerUrl?: string }>(res, 64 * 1024)
        if (typeof json.webSocketDebuggerUrl === 'string') {
          const ws = new URL(json.webSocketDebuggerUrl)
          if (
            ws.protocol === 'ws:' &&
            ['127.0.0.1', 'localhost'].includes(ws.hostname) &&
            Number(ws.port) === port &&
            !ws.username &&
            !ws.password &&
            /^\/devtools\/browser\/[a-z0-9-]+$/i.test(ws.pathname)
          ) {
            return ws.toString()
          }
        }
      } else {
        await res.body?.cancel().catch(() => {})
      }
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Không kết nối được CDP ở cổng ${port}: ${String(lastErr)}`)
}
