// ── VGC Browser — local automation REST API ──────────────────────────────────
// A small HTTP API bound to 127.0.0.1 (GoLogin's :36912 equivalent) so external
// automation can manage profiles. Browser control stays on the app's private
// CDP pipe and is never exposed as an unauthenticated DevTools socket:
//
//   POST /profiles/:id/start  ->  { id, status }
//
// This module is deliberately electron-free (deps are injected) so it can be
// unit-tested standalone.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import type { Socket } from 'net'
import type { CreateProfileInput, Profile, ProfileRuntimeState } from '../shared/types'
import type { LaunchProfileOptions } from './profile-manager'

export interface ApiDeps {
  listProfiles: () => Promise<Profile[]>
  launchProfile: (id: string, opts?: LaunchProfileOptions) => Promise<ProfileRuntimeState>
  stopProfile: (id: string) => void
  getRuntimeState: (id: string) => ProfileRuntimeState
  createProfile: (input: CreateProfileInput) => Promise<Profile>
  updateProfile: (id: string, patch: Partial<Profile>) => Promise<Profile>
  deleteProfile: (id: string) => Promise<void>
}

const MAX_BODY_BYTES = 1024 * 1024
const MAX_CONNECTIONS = 128
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::[1-9]\d{0,4})?$/i

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let exceeded = false
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        exceeded = true
        return
      }
      data += chunk.toString('utf-8')
    })
    req.on('end', () => {
      if (exceeded) return reject(new ApiError(413, 'Request body too large'))
      try {
        const parsed = data ? (JSON.parse(data) as unknown) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ApiError(400, 'JSON object required'))
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new ApiError(400, 'Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

export interface ApiHandle {
  close: () => void
  port: number
}

function send(res: ServerResponse, code: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  res.end(JSON.stringify(body))
}

function validBearer(actual: string | undefined, token: string): boolean {
  if (!actual || !token) return false
  const got = Buffer.from(actual, 'utf8')
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export async function startApiServer(opts: {
  port: number
  token: string
  deps: ApiDeps
}): Promise<ApiHandle> {
  const { token, deps } = opts
  if (!/^[a-f0-9]{48}$/i.test(token)) throw new Error('API token không hợp lệ')
  if (
    !Number.isInteger(opts.port) ||
    (opts.port !== 0 && (opts.port < 1024 || opts.port > 65535))
  ) {
    throw new Error('API port không hợp lệ')
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'

      // Anti-DNS-rebinding / anti-CSRF: a real automation client connects straight to
      // 127.0.0.1 and sends NO Origin header; a web page in any browser always sends
      // one. Pinning Host to loopback also defeats a rebound domain (evil.com →
      // 127.0.0.1) reaching the API. Reject both before doing anything else.
      const hostHeader = req.headers.host ?? ''
      if (req.headers.origin || !LOOPBACK_HOST.test(hostHeader)) {
        return send(res, 403, { error: 'Forbidden' })
      }

      // Bearer token auth for every route, including health checks, so websites and
      // unrelated local processes cannot probe whether VGC Browser is running.
      if (!validBearer(req.headers.authorization, token)) {
        return send(res, 401, { error: 'Unauthorized' })
      }

      if (
        (method === 'PATCH' || method === 'PUT' || (method === 'POST' && path === '/profiles')) &&
        !String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
      ) {
        return send(res, 415, { error: 'application/json required' })
      }

      if (path === '/ping') {
        return send(res, 200, { ok: true })
      }

      if (path === '/profiles' && method === 'GET') {
        const list = await deps.listProfiles()
        return send(
          res,
          200,
          list.map((p) => ({
            id: p.id,
            name: p.name,
            status: deps.getRuntimeState(p.id).status
          }))
        )
      }

      if (path === '/profiles' && method === 'POST') {
        const body = await readBody(req)
        const created = await deps.createProfile(body as CreateProfileInput)
        return send(res, 200, created)
      }

      const m = path.match(/^\/profiles\/([^/]+)(?:\/(start|stop))?$/)
      if (m) {
        const id = decodeURIComponent(m[1])
        const action = m[2]

        if (method === 'POST' && action === 'start') {
          const headless =
            url.searchParams.get('headless') === '1' ||
            url.searchParams.get('headless') === 'true'
          const state = await deps.launchProfile(id, { headless })
          return send(res, 200, { id, status: state.status })
        }
        if (method === 'POST' && action === 'stop') {
          deps.stopProfile(id)
          return send(res, 200, { ok: true })
        }
        if (method === 'GET' && !action) {
          return send(res, 200, deps.getRuntimeState(id))
        }
        if ((method === 'PATCH' || method === 'PUT') && !action) {
          const body = await readBody(req)
          const updated = await deps.updateProfile(id, body as Partial<Profile>)
          return send(res, 200, updated)
        }
        if (method === 'DELETE' && !action) {
          await deps.deleteProfile(id)
          return send(res, 200, { ok: true })
        }
      }

      send(res, 404, { error: 'Not found' })
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 500
      send(res, status, { error: e instanceof Error ? e.message : String(e) })
    }
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 15_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 50
  server.maxConnections = MAX_CONNECTIONS
  const clients = new Set<Socket>()
  server.on('connection', (socket) => {
    if (socket.remoteAddress !== '127.0.0.1') {
      socket.destroy()
      return
    }
    clients.add(socket)
    socket.once('close', () => clients.delete(socket))
  })
  // A late server error must not become an uncaught EventEmitter error in main.
  server.on('error', () => {})

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port
  return {
    close: () => {
      for (const socket of clients) socket.destroy()
      clients.clear()
      try {
        server.close()
      } catch {
        /* ignore */
      }
    },
    port
  }
}
