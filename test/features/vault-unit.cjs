// Kiểm thử sao lưu passkey (bản sao tự động + file .vgcpk) và két theo tài khoản (hai máy giả lập
// dùng chung một cloud giả áp ĐÚNG chính sách RLS thật của bucket `profiles`).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { build } = require('esbuild')
const here = __dirname
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkv-'))
const UD_A = path.join(root, 'A'), UD_B = path.join(root, 'B')
fs.mkdirSync(UD_A); fs.mkdirSync(UD_B)
process.env.PK_UD = UD_A
const W = (n, c) => fs.writeFileSync(path.join(here, n), c)
W('stub-electron.cjs', "module.exports = { app: { getPath: () => process.env.PK_UD } }\n")
W('stub-secret.cjs', `const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto')
const MAGIC = Buffer.from('VGCENC1\\0', 'latin1')
const keyFor = (s, c) => createHash('sha256').update(s + ':' + c).digest()
module.exports = {
  getAccountSecret: async () => (global.__secret === undefined ? 'ab'.repeat(32) : global.__secret),
  isEncryptedBytes: (b) => b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC),
  encryptBytes: (s, c, d) => { const iv = randomBytes(12); const k = createCipheriv('aes-256-gcm', keyFor(s, c), iv); const e = Buffer.concat([k.update(d), k.final()]); return Buffer.concat([MAGIC, iv, k.getAuthTag(), e]) },
  decryptBytes: (s, c, b) => { try { const body = b.subarray(MAGIC.length); const d = createDecipheriv('aes-256-gcm', keyFor(s, c), body.subarray(0, 12)); d.setAuthTag(body.subarray(12, 28)); return Buffer.concat([d.update(body.subarray(28)), d.final()]) } catch { return null } }
}\n`)
W('stub-cloud.cjs', `const RE = new RegExp('^[0-9a-f-]{36}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\\\.(zip|cookies\\\\.json|passwords\\\\.json|cookiesdb\\\\.json)$')
module.exports = { accountObject: async (op, name, body) => {
  const c = global.__cloud; c.calls.push(op)
  if (!RE.test('11111111-2222-3333-4444-555555555555/' + name)) { c.denied = (c.denied || 0) + 1; return { ok: false, status: 403 } }
  if (c.fail) return { ok: false, status: 0 }
  if (op === 'get') return c.map.has(name) ? { ok: true, status: 200, data: c.map.get(name) } : { ok: true, status: 404 }
  if (op === 'put') { c.map.set(name, Buffer.from(body)); return { ok: true, status: 200 } }
  c.map.delete(name); return { ok: true, status: 200 }
} }\n`)
W('stub-session.cjs', "module.exports = { getCloudSession: () => global.__session === undefined ? ({ uid: '11111111-2222-3333-4444-555555555555', accessToken: 't' }) : global.__session }\n")
W('stub-store.cjs', "module.exports = { listProfiles: async () => global.__profiles.map((id) => ({ id })) }\n")
W('stub-dbg.cjs', "module.exports = { dbg: () => {} }\n")
W('entry-vault.ts', "export * from '../../src/main/passkeys'\nexport * from '../../src/main/passkey-vault'\n")

const out = { steps: [], fails: [] }
const check = (n, c, x) => { out.steps.push((c ? 'PASS ' : 'FAIL ') + n + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); if (!c) out.fails.push(n) }
const stubs = { electron: 'stub-electron.cjs', './account-secret': 'stub-secret.cjs', './cloud-data': 'stub-cloud.cjs', './session': 'stub-session.cjs', './store': 'stub-store.cjs', './dbg': 'stub-dbg.cjs' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const VAULT_NAME = '00000000-0000-4000-8000-706b7661756c.cookiesdb.json'

;(async () => {
  await build({ entryPoints: [path.join(here, 'entry-vault.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(here, 'bundle-vault.cjs'), logLevel: 'warning',
    plugins: [{ name: 's', setup(b) { b.onResolve({ filter: /^(electron|\.\/account-secret|\.\/cloud-data|\.\/session|\.\/store|\.\/dbg)$/ }, (a) => ({ path: path.join(here, stubs[a.path]) })) } }] })
  const m = require('./bundle-vault.cjs')
  const P1 = crypto.randomUUID(), P2 = crypto.randomUUID(), GONE = crypto.randomUUID()
  global.__cloud = { map: new Map(), calls: [], fail: false }
  global.__profiles = [P1, P2]
  const mk = (origin, name) => ({ origin, challenge: crypto.randomBytes(32).toString('base64url'), user: { id: crypto.randomBytes(16).toString('base64url'), name, displayName: name } })
  const onA = () => { process.env.PK_UD = UD_A }
  const onB = () => { process.env.PK_UD = UD_B }

  // ===== PHẦN 1: sao lưu cục bộ tự động + file .vgcpk =====
  onA()
  const a1 = await m.pkCreate(P1, mk('https://github.com', 'alice'))
  await m.pkCreate(P1, mk('https://example.com', 'bob'))
  await m.pkCreate(P2, mk('https://accounts.google.com', 'carol'))
  await m.pkCreate(GONE, mk('https://gone.example', 'erin'))
  for (let i = 0; i < 8; i++) await m.pkCreate(P2, mk('https://site' + i + '.example', 'u' + i))
  const bdir = path.join(UD_A, 'passkey-backups')
  check('sao luu tu dong: giu dung 5 ban gan nhat/profile', fs.readdirSync(bdir).filter((f) => f.startsWith(P2 + '-')).length === 5)
  const bak = fs.readFileSync(path.join(bdir, fs.readdirSync(bdir)[0]))
  check('ban sao tu dong duoc ma hoa', bak.subarray(0, 7).toString('latin1') === 'VGCENC1' && !bak.toString('latin1').includes('pkcs8'))
  let short = null; try { await m.exportPasskeys(null, 'ngan', [P1, P2, GONE]) } catch (e) { short = e.message }
  check('mat khau sao luu < 8 ky tu bi tu choi', !!short)
  const exp = await m.exportPasskeys(null, 'mat-khau-sao-luu-1', [P1, P2, GONE])
  check('xuat tat ca: 3 profile', exp.profiles === 3, { p: exp.profiles, c: exp.creds })
  check('file .vgcpk duoc ma hoa', exp.data.subarray(0, 6).toString('latin1') === 'VGCPK1' && !exp.data.toString('latin1').includes('pkcs8') && !exp.data.toString('latin1').includes('alice'))
  let bad = null; try { await m.importPasskeys(exp.data, 'sai-mat-khau-123', new Set([P1, P2, GONE])) } catch (e) { bad = e.message }
  check('sai mat khau khoi phuc -> tu choi', !!bad && bad.includes('Sai mật khẩu'))
  fs.rmSync(path.join(UD_A, 'profiles'), { recursive: true, force: true })
  check('mat sach du lieu: kho rong', (await m.listPasskeys(P1)).length === 0)
  const imp = await m.importPasskeys(exp.data, 'mat-khau-sao-luu-1', new Set([P1, P2]))
  check('khoi phuc: 2 profile, bo qua profile da xoa', imp.profiles === 2 && imp.skipped === 1, imp)
  const g = await m.pkGet(P1, { origin: 'https://github.com', challenge: crypto.randomBytes(32).toString('base64url') })
  const signed = Buffer.concat([Buffer.from(g.authenticatorData, 'base64url'), crypto.createHash('sha256').update(Buffer.from(g.clientDataJSON, 'base64url')).digest()])
  const pubA = crypto.createPublicKey({ key: Buffer.from(a1.publicKey, 'base64url'), format: 'der', type: 'spki' })
  check('sau khoi phuc: chu ky van xac minh dung bang khoa cong khai cu', crypto.verify('sha256', signed, { key: pubA, dsaEncoding: 'der' }, Buffer.from(g.signature, 'base64url')) === true)
  await m.importPasskeys(exp.data, 'mat-khau-sao-luu-1', new Set([P1, P2]))
  check('khoi phuc lan 2 khong nhan doi', (await m.listPasskeys(P1)).length === 2)

  // Dọn trạng thái để sang phần két
  fs.rmSync(path.join(UD_A, 'profiles'), { recursive: true, force: true }); fs.rmSync(bdir, { recursive: true, force: true })
  global.__cloud.map = new Map()

  // ===== PHẦN 2: két theo tài khoản, hai máy =====
  onA()
  const b1 = await m.pkCreate(P1, mk('https://github.com', 'alice'))
  await m.pkCreate(P1, mk('https://example.com', 'bob'))
  await m.pkCreate(P2, mk('https://accounts.google.com', 'carol'))
  await sleep(3800)
  check('may A: tao passkey -> TU DONG co ket tren cloud', global.__cloud.map.has(VAULT_NAME))
  const raw = global.__cloud.map.get(VAULT_NAME)
  check('ket tren cloud duoc ma hoa', raw.subarray(0, 7).toString('latin1') === 'VGCENC1' && !raw.toString('latin1').includes('pkcs8') && !raw.toString('latin1').includes('alice'))
  onB()
  check('may B truoc dong bo: kho rong', (await m.listPasskeys(P1)).length === 0)
  const s1 = await m.syncPasskeyVault()
  check('may B dong bo: keo ve 3 passkey', s1.ok && s1.pulled === 3, s1)
  const g2 = await m.pkGet(P1, { origin: 'https://github.com', challenge: crypto.randomBytes(32).toString('base64url') })
  const signed2 = Buffer.concat([Buffer.from(g2.authenticatorData, 'base64url'), crypto.createHash('sha256').update(Buffer.from(g2.clientDataJSON, 'base64url')).digest()])
  const pubB = crypto.createPublicKey({ key: Buffer.from(b1.publicKey, 'base64url'), format: 'der', type: 'spki' })
  check('B dang nhap bang passkey tao o A: chu ky dung', crypto.verify('sha256', signed2, { key: pubB, dsaEncoding: 'der' }, Buffer.from(g2.signature, 'base64url')) === true)
  const delId = (await m.listPasskeys(P1)).find((k) => k.rpId === 'example.com').id
  await m.deletePasskey(P1, delId); await sleep(3800)
  onA(); const s2 = await m.syncPasskeyVault()
  check('A dong bo: go passkey da xoa o B (bia mo)', s2.ok && s2.removed === 1, s2)
  onB(); await m.syncPasskeyVault()
  check('passkey da xoa KHONG song lai sau nhieu vong', (await m.listPasskeys(P1)).every((k) => k.id !== delId))
  onA(); const cA = await m.pkCreate(P2, mk('https://site-a.example', 'ua'))
  onB(); const cB = await m.pkCreate(P2, mk('https://site-b.example', 'ub'))
  await sleep(300)
  onA(); await m.syncPasskeyVault(); onB(); await m.syncPasskeyVault(); onA(); await m.syncPasskeyVault()
  const idsA = (await m.listPasskeys(P2)).map((k) => k.id).sort(); onB()
  const idsB = (await m.listPasskeys(P2)).map((k) => k.id).sort()
  check('hai may cung them: ca hai du passkey cua nhau (P2 = 3)', idsA.length === 3 && JSON.stringify(idsA) === JSON.stringify(idsB) && idsA.includes(cA.id) && idsA.includes(cB.id))
  const before = global.__cloud.map.get(VAULT_NAME)
  global.__cloud.fail = true; onA(); const sf = await m.syncPasskeyVault(); global.__cloud.fail = false
  check('mat mang: bao loi, KHONG ghi de ket', sf.ok === false && global.__cloud.map.get(VAULT_NAME).equals(before))
  global.__secret = 'cd'.repeat(32); const sd = await m.syncPasskeyVault(); global.__secret = undefined
  check('sai khoa ma hoa: bao loi, KHONG ghi de ket', sd.ok === false && global.__cloud.map.get(VAULT_NAME).equals(before))
  global.__session = null; const sn = await m.syncPasskeyVault(); global.__session = undefined
  check('chua dang nhap cloud: khong lam gi', sn.ok === false)
  onA()
  const bd2 = path.join(UD_A, 'passkey-backups')
  check('truoc khi huy: A co ban sao cuc bo cua P2', fs.existsSync(bd2) && fs.readdirSync(bd2).some((f) => f.startsWith(P2 + '-')))
  check('huy P2: wipePasskeysFor tra true', (await m.wipePasskeysFor([P2])) === true)
  check('huy P2: ban sao cuc bo cua P2 bi xoa, P1 con', !fs.readdirSync(bd2).some((f) => f.startsWith(P2 + '-')) && fs.readdirSync(bd2).some((f) => f.startsWith(P1 + '-')))
  fs.rmSync(path.join(UD_A, 'profiles', P2), { recursive: true, force: true })
  onB(); const sb = await m.syncPasskeyVault()
  check('may B dong bo sau huy P2: passkey P2 bi go', sb.ok && (await m.listPasskeys(P2)).length === 0, sb)
  onA(); await m.syncPasskeyVault()
  check('P2 khong song lai o A; P1 con o ca hai may', (await m.listPasskeys(P2)).length === 0 && (await m.listPasskeys(P1)).length === 1)
  check('huy TAT CA: tra true', (await m.wipePasskeysFor(null)) === true && fs.readdirSync(bd2).length === 0)
  fs.rmSync(path.join(UD_A, 'profiles'), { recursive: true, force: true })
  onB(); await m.syncPasskeyVault()
  check('huy tat ca: may B tu go sach', (await m.listPasskeys(P1)).length === 0)
  onA(); await m.syncPasskeyVault()
  check('huy tat ca: khong gi song lai o A', (await m.listPasskeys(P1)).length === 0)
  check('khong thao tac nao bi chinh sach RLS thuc te tu choi', !global.__cloud.denied, global.__cloud.denied)

  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length ? 1 : 0)
})().catch((e) => { out.error = String(e && e.stack || e); console.log(JSON.stringify(out, null, 1)); process.exit(1) })
