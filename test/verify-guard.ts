// Verify that the guard uses browser policies without injecting fingerprint JavaScript.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { ensureNativeGuardExtension } from '../src/main/webrtc-guard'
import { generateFingerprint } from '../src/shared/fingerprint'

const fp = generateFingerprint('windows')
fp.webrtc = 'proxy'
fp.webrtcPublicIp = '203.0.113.7'
const dir = mkdtempSync(join(tmpdir(), 'vgc-guard-'))
const out = ensureNativeGuardExtension(dir, fp)
const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as {
  content_scripts?: unknown
  permissions?: string[]
}
const js = readFileSync(join(out, 'background.js'), 'utf8')
try {
  new vm.Script(js)
  const noPageInjection = !manifest.content_scripts && !existsSync(join(out, 'guard.js'))
  const permissions =
    manifest.permissions?.includes('privacy') === true &&
    manifest.permissions.includes('contentSettings')
  const policies =
    js.includes('disable_non_proxied_udp') &&
    js.includes('webRTCMultipleRoutesEnabled') &&
    js.includes("setting:'block'")
  console.log((noPageInjection ? 'PASS' : 'FAIL') + ': no page-level fingerprint injection')
  console.log((permissions && policies ? 'PASS' : 'FAIL') + ': native WebRTC/location policies')
  process.exit(noPageInjection && permissions && policies ? 0 : 1)
} catch (e) {
  console.log('FAIL: background.js syntax error:', (e as Error).message)
  process.exit(1)
}
