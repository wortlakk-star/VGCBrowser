// ── VGC Browser — automation API verification ────────────────────────────────
// Drives the electron-free api-server with stub deps: checks health, Bearer
// auth (401 vs 200), profile listing, and that start returns a CDP ws endpoint.
//
// Build+run:  npx esbuild test/verify-api.ts --bundle --platform=node
//               --format=cjs --outfile=test/api.cjs && node test/api.cjs

import { startApiServer } from '../src/main/api-server'

const TOKEN = 'test-token-123'

const deps = {
  listProfiles: async () => [{ id: 'p1', name: 'Profile One' }] as never,
  launchProfile: async (id: string) => ({ id, status: 'running', debugPort: 9999 }) as never,
  stopProfile: () => {},
  getRuntimeState: (id: string) => ({ id, status: 'stopped' }) as never,
  browserWsForPort: async (p: number) => `ws://127.0.0.1:${p}/devtools/browser/abc-123`,
  createProfile: async (input: { name?: string }) => ({ id: 'newid', name: input.name }) as never,
  updateProfile: async (id: string, patch: object) => ({ id, ...patch }) as never,
  deleteProfile: async () => {}
}

async function main(): Promise<void> {
  const h = await startApiServer({ port: 0, token: TOKEN, deps })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { Authorization: `Bearer ${TOKEN}` }
  let pass = 0
  const total = 7
  console.log('\n=== VGC automation API verification ===')

  const ping = await fetch(`${base}/ping`)
  const pingOk = ping.status === 200 && (await ping.json()).ok === true
  console.log(`${pingOk ? 'PASS' : 'FAIL'}  GET /ping (no auth) → ${ping.status}`)
  if (pingOk) pass++

  const noAuth = await fetch(`${base}/profiles`)
  const noAuthOk = noAuth.status === 401
  console.log(`${noAuthOk ? 'PASS' : 'FAIL'}  GET /profiles (no token) → ${noAuth.status}`)
  if (noAuthOk) pass++

  const list = await fetch(`${base}/profiles`, { headers: auth })
  const arr = await list.json()
  const listOk = list.status === 200 && Array.isArray(arr) && arr[0]?.id === 'p1'
  console.log(`${listOk ? 'PASS' : 'FAIL'}  GET /profiles (token) → ${JSON.stringify(arr)}`)
  if (listOk) pass++

  const start = await fetch(`${base}/profiles/p1/start`, { method: 'POST', headers: auth })
  const sj = await start.json()
  const startOk = start.status === 200 && typeof sj.ws === 'string' && sj.ws.startsWith('ws://')
  console.log(`${startOk ? 'PASS' : 'FAIL'}  POST /profiles/p1/start → ${JSON.stringify(sj)}`)
  if (startOk) pass++

  const stop = await fetch(`${base}/profiles/p1/stop`, { method: 'POST', headers: auth })
  const stopOk = stop.status === 200 && (await stop.json()).ok === true
  console.log(`${stopOk ? 'PASS' : 'FAIL'}  POST /profiles/p1/stop → ${stop.status}`)
  if (stopOk) pass++

  const create = await fetch(`${base}/profiles`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Made via API' })
  })
  const cj = await create.json()
  const createOk = create.status === 200 && cj.id === 'newid'
  console.log(`${createOk ? 'PASS' : 'FAIL'}  POST /profiles (create) → ${JSON.stringify(cj)}`)
  if (createOk) pass++

  const del = await fetch(`${base}/profiles/newid`, { method: 'DELETE', headers: auth })
  const delOk = del.status === 200 && (await del.json()).ok === true
  console.log(`${delOk ? 'PASS' : 'FAIL'}  DELETE /profiles/newid → ${del.status}`)
  if (delOk) pass++

  h.close()
  console.log(`\n${pass}/${total} checks passed.`)
  process.exitCode = pass === total ? 0 : 1
}

main().catch((e) => {
  console.error('api verify error:', e)
  process.exitCode = 2
})
