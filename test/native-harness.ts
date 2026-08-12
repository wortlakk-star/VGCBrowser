import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { CdpConnection } from '../src/main/cdp'

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export function resolveTestEngine(candidate?: string): string {
  if (candidate) return resolve(candidate)
  if (process.env.VGC_ENGINE_PATH) return resolve(process.env.VGC_ENGINE_PATH)
  if (process.platform === 'darwin') {
    return resolve(
      process.cwd(),
      '../vgc-chromium/src/out/vgc/Chromium.app/Contents/MacOS/Chromium'
    )
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'vgc-browser', 'engine', 'chromium', 'chrome.exe')
      : 'D:\\chromium\\src\\out\\vgc\\chrome.exe'
  }
  return resolve(process.cwd(), '../vgc-chromium/src/out/vgc/chrome')
}

export async function createLoopbackPage(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'close'
    })
    response.end('<!doctype html><meta charset="utf-8"><title>VGC fingerprint probe</title>')
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not start the loopback probe page')
  }
  return {
    url: `http://127.0.0.1:${address.port}/probe`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

async function stopProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveExit) => proc.once('exit', () => resolveExit())),
    sleep(3000)
  ])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

async function waitForReady(conn: CdpConnection, sessionId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = (await conn.send(
      'Runtime.evaluate',
      { expression: 'document.readyState', returnByValue: true },
      sessionId
    )) as { result?: { value?: string } }
    if (result.result?.value === 'complete') return
    await sleep(100)
  }
  throw new Error('Probe page did not finish loading')
}

export async function openNativePage(
  engine: string,
  args: string[],
  pageUrl: string
): Promise<{
  conn: CdpConnection
  sessionId: string
  close: () => Promise<void>
}> {
  const env: NodeJS.ProcessEnv = { ...process.env, GOOGLE_API_KEY: 'no-key' }
  delete env.GOOGLE_DEFAULT_CLIENT_ID
  delete env.GOOGLE_DEFAULT_CLIENT_SECRET
  const proc = spawn(engine, ['--remote-debugging-pipe', ...args], {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString('utf8')
  })
  const conn = CdpConnection.connectPipe(
    proc.stdio[3] as Writable,
    proc.stdio[4] as Readable
  )
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    conn.close()
    await stopProcess(proc)
  }
  try {
    await conn.send('Browser.getVersion')
    const created = (await conn.send('Target.createTarget', { url: pageUrl })) as {
      targetId: string
    }
    const attached = (await conn.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true
    })) as { sessionId: string }
    await conn.send('Page.enable', {}, attached.sessionId)
    await conn.send('Runtime.enable', {}, attached.sessionId)
    await waitForReady(conn, attached.sessionId)
    // A freshly loaded unpacked extension can recreate the first renderer once
    // its service worker starts. Let that one-time transition finish before a
    // long async fingerprint probe captures an execution context.
    await sleep(1000)
    await waitForReady(conn, attached.sessionId)
    return { conn, sessionId: attached.sessionId, close }
  } catch (error) {
    await close()
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ''}`
    )
  }
}
