// Generates the native-mode guard extension for a real fingerprint and syntax-checks
// the emitted guard.js (the DEFAULT path — not covered by verify-injection.ts).
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { ensureNativeGuardExtension } from '../src/main/webrtc-guard'
import { generateFingerprint } from '../src/shared/fingerprint'

const fp = generateFingerprint('windows')
fp.webrtc = 'proxy'
fp.webrtcPublicIp = '203.0.113.7'
const dir = mkdtempSync(join(tmpdir(), 'vgc-guard-'))
const out = ensureNativeGuardExtension(dir, fp, 123456789)
if (!out) { console.log('FAIL: ensureNativeGuardExtension returned null'); process.exit(1) }
const js = readFileSync(join(out, 'guard.js'), 'utf8')
try {
  new vm.Script(js) // parse-only: throws on any syntax error in the concatenated body
  console.log('PASS: guard.js parses (' + js.length + ' bytes, MV3 content script)')
  const hasSpoofs =
    /XCFG/.test(js) && /getBoundingClientRect/.test(js) && /MediaDeviceInfo/.test(js) && /availLeft/.test(js)
  console.log((hasSpoofs ? 'PASS' : 'FAIL') + ': contains extra spoofs (rects/screen/media) =', hasSpoofs)
  process.exit(hasSpoofs ? 0 : 1)
} catch (e) {
  console.log('FAIL: guard.js syntax error:', (e as Error).message)
  process.exit(1)
}
