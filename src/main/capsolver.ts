// ── CapSolver client (capsolver.com) ─────────────────────────────────────────
// Minimal REST client used by the bulk Gmail password tool to auto-solve the
// captchas Google throws during sign-in / re-auth:
//   • image "type the characters" captcha → ImageToTextTask (usually instant)
//   • reCAPTCHA v2 (checkbox/invisible)   → ReCaptchaV2TaskProxyLess (poll ~10-30s)
// No SDK — just fetch. The API key lives in AppSettings.capsolverApiKey.

import { dbg } from './dbg'
import { readLimitedResponseJson } from './http-limit'

const BASE = 'https://api.capsolver.com'

interface CapTaskResult {
  errorId: number
  errorCode?: string
  errorDescription?: string
  status?: 'idle' | 'processing' | 'ready'
  taskId?: string
  solution?: { text?: string; gRecaptchaResponse?: string }
}

async function post(path: string, body: unknown): Promise<CapTaskResult> {
  if (path !== '/createTask' && path !== '/getTaskResult') throw new Error('CapSolver path không hợp lệ')
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`CapSolver HTTP ${res.status}`)
  }
  return readLimitedResponseJson<CapTaskResult>(res, 1024 * 1024)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Create a task then poll getTaskResult until ready. Some task types (ImageToText)
 *  already return `solution` from createTask — we use it immediately if present. */
async function solve(
  apiKey: string,
  task: Record<string, unknown>,
  timeoutMs = 120000
): Promise<CapTaskResult['solution']> {
  const created = await post('/createTask', { clientKey: apiKey, task })
  if (created.errorId && created.errorId !== 0) {
    throw new Error(`CapSolver: ${created.errorCode || ''} ${created.errorDescription || ''}`.trim())
  }
  if (created.solution && (created.solution.text || created.solution.gRecaptchaResponse)) {
    return created.solution
  }
  const taskId = created.taskId
  if (!taskId) throw new Error('CapSolver: không có taskId trả về')

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(3000)
    const r = await post('/getTaskResult', { clientKey: apiKey, taskId })
    if (r.errorId && r.errorId !== 0) {
      throw new Error(`CapSolver: ${r.errorCode || ''} ${r.errorDescription || ''}`.trim())
    }
    if (r.status === 'ready') return r.solution
  }
  throw new Error('CapSolver: hết thời gian chờ giải captcha')
}

/** Solve a distorted-text image captcha. `base64` is the raw PNG/JPEG bytes, no
 *  data-URL prefix. Returns the recognised text (or '' on failure). */
export async function solveImageCaptcha(apiKey: string, base64: string): Promise<string> {
  try {
    if (!apiKey || apiKey.length > 4096 || !base64 || base64.length > 8 * 1024 * 1024) return ''
    const sol = await solve(apiKey, { type: 'ImageToTextTask', module: 'common', body: base64 }, 60000)
    return (sol?.text || '').trim()
  } catch (e) {
    dbg(`[capsolver] image solve failed: ${String(e)}`)
    return ''
  }
}

/** Solve a reCAPTCHA v2 (no proxy) and return the g-recaptcha-response token. */
export async function solveRecaptchaV2(
  apiKey: string,
  websiteURL: string,
  websiteKey: string
): Promise<string> {
  try {
    if (!apiKey || apiKey.length > 4096 || websiteKey.length > 2048) return ''
    const url = new URL(websiteURL)
    if (url.protocol !== 'https:' || url.username || url.password || websiteURL.length > 2048) return ''
    const sol = await solve(apiKey, {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey
    })
    return (sol?.gRecaptchaResponse || '').trim()
  } catch (e) {
    dbg(`[capsolver] recaptcha solve failed: ${String(e)}`)
    return ''
  }
}
