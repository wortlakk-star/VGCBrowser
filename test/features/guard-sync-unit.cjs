// Kiểm thử đồng bộ cấu hình KHOÁ theo tài khoản (guard.ts + guard-sync.ts), mỗi "máy" là một TIẾN TRÌNH
// riêng (userData riêng) dùng chung một cloud giả áp ĐÚNG chính sách RLS thật của bucket `profiles`.
// Chạy: node guard-sync-unit.cjs   (cần `npm i` trong thư mục này để có esbuild)
const fs = require('fs'), os = require('os'), path = require('path')
const { spawnSync } = require('child_process')
const here = __dirname
const BUNDLE = path.join(here, 'bundle-gs.cjs')

// ───────────────────────── CHẾ ĐỘ "MÁY" (tiến trình con) ─────────────────────────
if (process.argv[2] === 'machine') {
  const [, , , UD, CLOUD, UID, OPS] = process.argv
  process.env.PK_UD = UD
  global.__UID = UID === '-' ? null : UID
  global.__CLOUD = CLOUD
  const m = require(BUNDLE)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  ;(async () => {
    const out = []
    for (const o of JSON.parse(OPS)) {
      let r
      switch (o.op) {
        case 'checkAdmin': r = await m.checkAdmin(o.pw); break
        case 'setMaster': r = await m.setMaster(o.pw, o.auth); break
        case 'setSos': r = await m.setSos(o.pw, o.auth); break
        case 'setProfileLock': r = await m.setProfileLock(o.id, o.locked, o.limit); break
        case 'setGroupLock': r = await m.setGroupLock(o.name, o.code, o.limit); break
        case 'setLimits': r = await m.setLimits(o.per, o.glob, o.auth); break
        case 'isLocked': r = await m.isLocked(o.id); break
        case 'lockedIds': r = await m.lockedIds(); break
        case 'lockedGroups': r = await m.lockedGroupNames(); break
        case 'unlock': r = await m.unlock(o.id, o.pw, false); break
        case 'unlockGroup': r = await m.unlockGroup(o.code); break
        case 'status': r = await m.guardStatus(); break
        case 'sync': r = await m.syncGuardConfig(); break
        case 'wait': await sleep(o.ms); r = true; break
        case 'events': { const f = path.join(UD, 'events.log'); r = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; break }
        case 'files': r = fs.readdirSync(UD).filter((f) => f.startsWith('profile-guard')); break
        default: r = { error: 'op?' + o.op }
      }
      out.push(r)
    }
    process.stdout.write('@@' + JSON.stringify(out) + '@@')
    setTimeout(() => process.exit(0), 50)
  })().catch((e) => { process.stdout.write('@@' + JSON.stringify([{ crash: String(e && e.stack || e) }]) + '@@'); process.exit(1) })
  return
}

// ───────────────────────── CHẾ ĐỘ ĐIỀU PHỐI ─────────────────────────
const { build } = require('esbuild')
const W = (n, c) => fs.writeFileSync(path.join(here, n), c)
W('stub-gs-electron.cjs', `const fs = require('fs'), path = require('path')
module.exports = {
  app: { getPath: () => process.env.PK_UD },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (ch) => fs.appendFileSync(path.join(process.env.PK_UD, 'events.log'), ch + '\\n') } }] }
}\n`)
W('stub-gs-secure.cjs', `const fs = require('fs')
module.exports = {
  readSecureJson: async (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } },
  writeSecureJson: async (f, v) => { fs.writeFileSync(f, JSON.stringify(v)) }
}\n`)
W('stub-gs-store.cjs', "module.exports = { deleteProfile: async () => {}, listProfiles: async () => [], removeMany: async () => {} }\n")
W('stub-gs-cloud.cjs', `const fs = require('fs'), path = require('path')
const RE = new RegExp('^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\\\.(zip|cookies\\\\.json|passwords\\\\.json|cookiesdb\\\\.json)$')
module.exports = {
  deleteProfileCloudData: async () => false,
  accountObject: async (op, name, body) => {
    const uid = global.__UID; const root = global.__CLOUD
    if (!uid) return { ok: false, status: 0 }
    if (!RE.test(uid + '/' + name)) { fs.appendFileSync(path.join(root, 'denied.log'), name + '\\n'); return { ok: false, status: 403 } }
    if (fs.existsSync(path.join(root, 'FAIL'))) return { ok: false, status: 0 }
    const file = path.join(root, uid + '__' + name)
    if (op === 'get') return fs.existsSync(file) ? { ok: true, status: 200, data: fs.readFileSync(file) } : { ok: true, status: 404 }
    if (op === 'put') { fs.writeFileSync(file, Buffer.from(body)); return { ok: true, status: 200 } }
    try { fs.unlinkSync(file) } catch {}; return { ok: true, status: 200 }
  }
}\n`)
W('stub-gs-vault.cjs', "module.exports = { wipePasskeysFor: async () => true }\n")
W('stub-gs-session.cjs', "module.exports = { getCloudSession: () => (global.__UID ? { uid: global.__UID, accessToken: 't' } : null) }\n")
W('stub-gs-secret.cjs', `const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto')
const MAGIC = Buffer.from('VGCENC1\\0', 'latin1')
const keyFor = (s, c) => createHash('sha256').update(s + ':' + c).digest()
const fs = require('fs'), path = require('path')
module.exports = {
  getAccountSecret: async () => (fs.existsSync(path.join(global.__CLOUD, 'SECRET')) ? fs.readFileSync(path.join(global.__CLOUD, 'SECRET'), 'utf8').trim() : 'ab'.repeat(32)),
  isEncryptedBytes: (b) => b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC),
  encryptBytes: (s, c, d) => { const iv = randomBytes(12); const k = createCipheriv('aes-256-gcm', keyFor(s, c), iv); const e = Buffer.concat([k.update(d), k.final()]); return Buffer.concat([MAGIC, iv, k.getAuthTag(), e]) },
  decryptBytes: (s, c, b) => { try { const body = b.subarray(MAGIC.length); const d = createDecipheriv('aes-256-gcm', keyFor(s, c), body.subarray(0, 12)); d.setAuthTag(body.subarray(12, 28)); return Buffer.concat([d.update(body.subarray(28)), d.final()]) } catch { return null } }
}\n`)
W('stub-gs-dbg.cjs', "module.exports = { dbg: () => {} }\n")
W('stub-gs-pm.cjs', "module.exports = { stopProfile: () => {} }\n")
W('entry-gs.ts', "export * from '../../src/main/guard'\nexport * from '../../src/main/guard-sync'\n")

const out = { steps: [], fails: [] }
const check = (n, c, x) => { out.steps.push((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); if (!c) out.fails.push(n) }
const stubs = { electron: 'stub-gs-electron.cjs', './secure-store': 'stub-gs-secure.cjs', './store': 'stub-gs-store.cjs', './cloud-data': 'stub-gs-cloud.cjs', './passkey-vault': 'stub-gs-vault.cjs', './session': 'stub-gs-session.cjs', './account-secret': 'stub-gs-secret.cjs', './dbg': 'stub-gs-dbg.cjs', './profile-manager': 'stub-gs-pm.cjs' }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'))
const cloudDir = path.join(root, 'cloud'); fs.mkdirSync(cloudDir)
const mach = (n) => { const d = path.join(root, n); fs.mkdirSync(d, { recursive: true }); return d }
const UID1 = '11111111-2222-3333-4444-555555555555', UID2 = '22222222-2222-3333-4444-555555555555', UID3 = '33333333-2222-3333-4444-555555555555', UID4 = '44444444-2222-3333-4444-555555555555'
const P1 = '9a111111-1111-4111-8111-111111111111', P2 = '9a222222-2222-4222-8222-222222222222', PX = '9a999999-9999-4999-8999-999999999999', P9 = '9a888888-8888-4888-8888-888888888888'
const run = (ud, uid, ops, cloud = cloudDir) => {
  const r = spawnSync(process.execPath, [__filename, 'machine', ud, cloud, uid || '-', JSON.stringify(ops)], { encoding: 'utf8', timeout: 90_000 })
  const m = /@@(.*)@@/s.exec(r.stdout || '')
  if (!m) throw new Error('may khong tra ket qua: ' + (r.stderr || r.stdout || '').slice(0, 400))
  const arr = JSON.parse(m[1])
  if (arr[0] && arr[0].crash) throw new Error(arr[0].crash)
  return arr
}
const cloudFile = (uid) => path.join(cloudDir, uid + '__00000000-0000-4000-8000-677561726430.cookiesdb.json')

;(async () => {
  await build({ entryPoints: [path.join(here, 'entry-gs.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: BUNDLE, logLevel: 'warning',
    plugins: [{ name: 's', setup(b) { b.onResolve({ filter: /^(electron|\.\/secure-store|\.\/store|\.\/cloud-data|\.\/passkey-vault|\.\/session|\.\/account-secret|\.\/dbg|\.\/profile-manager)$/ }, (a) => ({ path: path.join(here, stubs[a.path]) })) } }] })

  const A = mach('A'), B = mach('B'), C = mach('C')

  // ── 1) MÁY A: đặt khoá → TỰ ĐẨY lên cloud (không bấm gì) ──
  const a1 = run(A, UID1, [
    { op: 'checkAdmin', pw: 'x' },
    { op: 'setMaster', pw: 'master123' }, { op: 'setSos', pw: 'sos999' },
    { op: 'setProfileLock', id: P1, locked: true, limit: 4 }, { op: 'setProfileLock', id: P2, locked: true, limit: 3 },
    { op: 'setGroupLock', name: 'Ads', code: 'adscode', limit: 3 }, { op: 'setLimits', per: 4, glob: 7 },
    { op: 'wait', ms: 3200 }, { op: 'files' }
  ])
  check('may A: dat master/SOS/khoa profile/khoa nhom/gioi han deu OK', a1.slice(0, 7).every((x) => x === true || x.ok === true), a1.slice(0, 7))
  check('may A: cau hinh TU DONG len cloud sau vai giay (khong bam dong bo)', fs.existsSync(cloudFile(UID1)))
  const raw = fs.readFileSync(cloudFile(UID1)).toString('latin1')
  check('cau hinh tren cloud duoc MA HOA (khong lo hash/ten nhom)', raw.startsWith('VGCENC1') && !raw.includes('salt') && !raw.includes('Ads') && !raw.includes(P1))
  check('may A luu file rieng theo tai khoan', a1[8].includes('profile-guard-' + UID1 + '.enc'), a1[8])

  // ── 2) MÁY B (mới tinh) đăng nhập cùng tài khoản → NHẬN ĐỦ ──
  const b1 = run(B, UID1, [
    { op: 'sync' }, { op: 'lockedIds' }, { op: 'lockedGroups' }, { op: 'status' },
    { op: 'checkAdmin', pw: 'sai' }, { op: 'checkAdmin', pw: 'master123' },
    { op: 'unlock', id: P1, pw: 'khong-phai' }, { op: 'unlock', id: P1, pw: 'master123' },
    { op: 'unlockGroup', code: 'adscode' }, { op: 'unlockGroup', code: 'sai-nhom' }, { op: 'events' }
  ])
  check('may B: dong bo -> NHAN cau hinh tu cloud (adopted)', b1[0].ok && b1[0].action === 'adopted', b1[0])
  check('may B: thay P1, P2 dang KHOA (truoc day hien het)', b1[1].includes(P1) && b1[1].includes(P2) && b1[1].length === 2, b1[1])
  check('may B: nhom Ads dang KHOA (an)', JSON.stringify(b1[2]) === JSON.stringify(['Ads']), b1[2])
  check('may B: nhan dung mat khau chu + gioi han (4/7)', b1[3].hasMaster === true && b1[3].hasSos === true && b1[3].perProfileLimit === 4 && b1[3].globalLimit === 7, b1[3])
  check('may B: mat khau bao mat SAI bi tu choi, DUNG duoc mo', b1[4] === false && b1[5] === true)
  check('may B: nhap sai khoa P1 -> dem rieng cua may B (con 3/4)', b1[6].action === 'wrong' && b1[6].remainingProfile === 3, b1[6])
  check('may B: mat khau chu mo duoc P1', b1[7].ok === true && b1[7].action === 'master')
  check('may B: ma nhom dung mo duoc Ads, sai thi khong', b1[8].ok === true && b1[8].group === 'Ads' && b1[9].ok === false, [b1[8], b1[9]])
  check('may B: giao dien duoc bao lam moi (guard:changed)', b1[10].includes('guard:changed'), b1[10])

  // ── 3) Bộ đếm sai chỉ riêng từng máy ──
  const a3 = run(A, UID1, [{ op: 'status' }])
  check('bo dem sai KHONG lan sang may khac (A van 0)', a3[0].globalWrong === 0, a3[0])

  // ── 4) A gỡ khoá P1 → B nhận ──
  run(A, UID1, [{ op: 'checkAdmin', pw: 'master123' }, { op: 'setProfileLock', id: P1, locked: false }, { op: 'wait', ms: 3200 }])
  const b4 = run(B, UID1, [{ op: 'sync' }, { op: 'lockedIds' }])
  check('A go khoa P1 -> may B cung go (con P2)', b4[0].ok && JSON.stringify(b4[1]) === JSON.stringify([P2]), b4)

  // ── 5) B thêm khoá nhóm → A nhận (bản mới hơn thắng, hai chiều) ──
  run(B, UID1, [{ op: 'checkAdmin', pw: 'master123' }, { op: 'setGroupLock', name: 'Bank', code: 'bankcode' }, { op: 'wait', ms: 3200 }])
  const a5 = run(A, UID1, [{ op: 'sync' }, { op: 'lockedGroups' }])
  check('B them khoa nhom Bank -> may A nhan (Ads + Bank)', a5[0].ok && JSON.stringify(a5[1].slice().sort()) === JSON.stringify(['Ads', 'Bank']), a5)

  // ── 6) Máy C mới cũng nhận đủ trạng thái mới nhất ──
  const c6 = run(C, UID1, [{ op: 'sync' }, { op: 'lockedIds' }, { op: 'lockedGroups' }])
  check('may C moi: nhan dung trang thai moi nhat (P2 khoa; Ads+Bank)', c6[0].action === 'adopted' && c6[1][0] === P2 && c6[1].length === 1 && c6[2].length === 2, c6)

  // ── 7) Lỗi mạng / sai khoá giải mã: KHÔNG ghi đè, KHÔNG nhận bậy ──
  const before = fs.readFileSync(cloudFile(UID1))
  fs.writeFileSync(path.join(cloudDir, 'FAIL'), '1')
  const f1 = run(B, UID1, [{ op: 'checkAdmin', pw: 'master123' }, { op: 'setProfileLock', id: P1, locked: true }, { op: 'wait', ms: 2800 }, { op: 'sync' }, { op: 'lockedIds' }])
  fs.unlinkSync(path.join(cloudDir, 'FAIL'))
  check('mat mang: dong bo bao loi, cloud KHONG bi ghi de', f1[3].ok === false && fs.readFileSync(cloudFile(UID1)).equals(before), f1[3])
  check('mat mang: thay doi cuc bo van giu tren may B (P1 + P2)', f1[4].length === 2, f1[4])
  const f2 = run(B, UID1, [{ op: 'sync' }])   // mạng lại: B mới hơn → đẩy
  check('co mang lai: tu dong day thay doi da luu', f2[0].ok && f2[0].action === 'pushed', f2[0])
  const bef2 = fs.readFileSync(cloudFile(UID1))
  fs.writeFileSync(path.join(cloudDir, 'SECRET'), 'cd'.repeat(32))
  const f3 = run(A, UID1, [{ op: 'sync' }, { op: 'lockedIds' }])
  fs.unlinkSync(path.join(cloudDir, 'SECRET'))
  check('sai khoa ma hoa: bao loi, khong nhan, khong ghi de', f3[0].ok === false && fs.readFileSync(cloudFile(UID1)).equals(bef2), f3[0])

  // ── 8) Hai tài khoản trên cùng máy KHÔNG lẫn cấu hình ──
  const i1 = run(A, UID2, [{ op: 'lockedIds' }, { op: 'lockedGroups' }, { op: 'status' }, { op: 'sync' }])
  check('dang nhap tai khoan KHAC tren may A: khong thay khoa cua tai khoan 1', i1[0].length === 0 && i1[1].length === 0 && i1[2].hasMaster === false && i1[3].action === 'none', i1)
  const i2 = run(A, UID1, [{ op: 'lockedIds' }])
  check('quay lai tai khoan 1: khoa cua rieng may A van con nguyen (P2)', i2[0].length === 1 && i2[0][0] === P2, i2[0])

  // ── 9) Cấu hình cũ một-máy (trước khi có đồng bộ) → NHẬN cho tài khoản đầu tiên rồi đẩy lên ──
  const L = mach('L')
  run(L, null, [{ op: 'setMaster', pw: 'oldmaster' }, { op: 'setProfileLock', id: PX, locked: true }])  // chưa đăng nhập = file cũ dùng chung
  // setProfileLock cần phiên admin → khi chưa đăng nhập vẫn qua checkAdmin
  const l0 = run(L, null, [{ op: 'checkAdmin', pw: 'oldmaster' }, { op: 'setProfileLock', id: PX, locked: true }, { op: 'files' }])
  const l1 = run(L, UID3, [{ op: 'lockedIds' }, { op: 'sync' }, { op: 'files' }])
  check('cau hinh cu cua may duoc NHAN cho tai khoan dau tien dang nhap', l1[0].includes(PX) && l1[1].ok && l1[1].action === 'pushed', l1)
  check('file cu duoc doi ten (khong ai nhan lai)', l1[2].some((f) => f.startsWith('profile-guard.enc.claimed-' + UID3)) && !l1[2].includes('profile-guard.enc'), l1[2])
  const l2 = run(L, UID4, [{ op: 'lockedIds' }, { op: 'sync' }])
  check('tai khoan thu hai tren may do: bat dau SACH (khong nhan cau hinh cu lan nua)', l2[0].length === 0 && l2[1].action === 'none', l2)
  const l3 = run(mach('L3'), UID3, [{ op: 'sync' }, { op: 'lockedIds' }, { op: 'checkAdmin', pw: 'oldmaster' }])
  check('cau hinh cu da len cloud: may khac cung tai khoan nhan duoc', l3[0].action === 'adopted' && l3[1].includes(PX) && l3[2] === true, l3)

  // ── 10) Gộp khi máy có cấu hình cũ chưa đồng bộ mà cloud đã có bản khác ──
  const SRC = mach('SRC'), U = mach('U')
  const dsrc = run(SRC, UID4, [{ op: 'checkAdmin', pw: 'x' }, { op: 'setMaster', pw: 'cloudmaster' }, { op: 'setProfileLock', id: P9, locked: true }, { op: 'wait', ms: 3200 }])
  const du = run(U, null, [{ op: 'checkAdmin', pw: 'x' }, { op: 'setMaster', pw: 'localold' }, { op: 'checkAdmin', pw: 'localold' }, { op: 'setProfileLock', id: PX, locked: true }, { op: 'lockedIds' }])
  const u1 = run(U, UID4, [{ op: 'sync' }, { op: 'lockedIds' }, { op: 'checkAdmin', pw: 'cloudmaster' }])
  check('may co cau hinh cu + cloud co ban khac: GOP khoa (khong mat khoa nao), mat khau chu theo cloud', u1[0].ok && u1[1].includes(P9) && u1[1].includes(PX) && u1[2] === true, u1)
  const u2 = run(mach('U2'), UID4, [{ op: 'sync' }, { op: 'lockedIds' }])
  check('ban gop duoc day len: may khac nhan du ca hai khoa', u2[1].includes(P9) && u2[1].includes(PX), u2)

  check('khong thao tac nao bi chinh sach RLS thuc te tu choi', !fs.existsSync(path.join(cloudDir, 'denied.log')))
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length ? 1 : 0)
})().catch((e) => { out.error = String(e && e.stack || e); console.log(JSON.stringify(out, null, 1)); process.exit(1) })
