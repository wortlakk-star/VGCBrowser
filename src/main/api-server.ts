// ── VGC Browser — local automation REST API ──────────────────────────────────
// A small HTTP API bound to 127.0.0.1 (GoLogin's :36912 equivalent) so external
// automation can drive profiles. Starting a profile returns its CDP browser
// WebSocket endpoint, which Puppeteer/Playwright connect to:
//
//   POST /profiles/:id/start  →  { id, port, ws }
//     puppeteer.connect({ browserWSEndpoint: ws })
//     playwright.chromium.connectOverCDP(ws)
//
// This module is deliberately electron-free (deps are injected) so it can be
// unit-tested standalone.

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { CreateProfileInput, Profile, ProfileRuntimeState } from '../shared/types'

export interface ApiDeps {
  listProfiles: () => Promise<Profile[]>
  launchProfile: (id: string, opts?: { headless?: boolean }) => Promise<ProfileRuntimeState>
  stopProfile: (id: string) => void
  getRuntimeState: (id: string) => ProfileRuntimeState
  browserWsForPort: (port: number) => Promise<string>
  createProfile: (input: CreateProfileInput) => Promise<Profile>
  updateProfile: (id: string, patch: Partial<Profile>) => Promise<Profile>
  deleteProfile: (id: string) => Promise<void>
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}

export interface ApiHandle {
  close: () => void
  port: number
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export async function startApiServer(opts: {
  port: number
  token: string
  deps: ApiDeps
}): Promise<ApiHandle> {
  const { token, deps } = opts

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      const method = req.method ?? 'GET'

      // Health check needs no auth.
      if (path === '/ping') {
        return send(res, 200, { ok: true, app: 'vgc-browser' })
      }

      // Bearer token auth for everything else.
      if (!token || req.headers['authorization'] !== `Bearer ${token}`) {
        return send(res, 401, { error: 'Unauthorized' })
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
          let ws = ''
          if (state.debugPort) {
            try {
              ws = await deps.browserWsForPort(state.debugPort)
            } catch {
              /* ws best-effort */
            }
          }
          return send(res, 200, { id, port: state.debugPort, ws })
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
      send(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  })

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
      try {
        server.close()
      } catch {
        /* ignore */
      }
    },
    port
  }
}
