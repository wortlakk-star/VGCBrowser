// E2E khoá profile / tự huỷ trên bản VGC CÁCH LY (userData tạm, không cloud, không đăng nhập).
// Xem README.md trong thư mục này: phải dựng bản cách ly trước (cổng debug 9333).
const fs = require('fs'), path = require('path'), os = require('os')
const UD = process.env.VGC_TEST_UD || path.join(os.tmpdir(), 'vgc-guard-test-ud')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { steps: [], fails: [] }
const check = (name, cond, extra) => { out.steps.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); if (!cond) out.fails.push(name) }

async function connect() {
  const l = await (await fetch('http://127.0.0.1:9333/json/list')).json()
  const page = l.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
  let id = 0; const pend = {}; const errors = []
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pend[d.id]) pend[d.id](d)
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.text + ' ' + ((d.params.exceptionDetails.exception || {}).description || '').slice(0, 160))
  }
  const send = (method, params) => new Promise((res) => { const i = ++id; pend[i] = res; ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Runtime.enable', {})
  const ev = async (expr) => { const d = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return d.result && d.result.exceptionDetails ? { __err: d.result.exceptionDetails.exception && d.result.exceptionDetails.exception.description } : d.result.result.value }
  return { ev, errors }
}
const mkdirProfile = (id) => { const d = path.join(UD, 'profiles', id, 'Default'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'Cookies'), 'x') }
const dirExists = (id) => fs.existsSync(path.join(UD, 'profiles', id))

;(async () => {
  const { ev, errors } = await connect()
  const V = 'window.vgc.'
  const ids = async () => (await ev(`${V}listProfiles().then(l=>l.map(p=>({id:p.id,name:p.name,group:p.group||''})))`)) || []

  check('giao dien tai duoc', (await ev("document.body.innerText.length>0 && document.getElementById('root').children.length>0")) === true)
  const start = await ids()
  check('ban test sach, khong co profile that', Array.isArray(start) && start.length === 0, start.length)
  if (start.length !== 0) throw new Error('KHONG phai ban cach ly — DUNG de bao ve du lieu that')

  const mk = async (name, group) => { const p = await ev(`${V}createProfile({name:${JSON.stringify(name)}${group ? ',group:' + JSON.stringify(group) : ''}})`); mkdirProfile(p.id); return p }
  const A = await mk('TEST-A'), B = await mk('TEST-B'), C = await mk('TEST-C', 'G-TEST')
  check('tao 3 profile nhap', !!(A.id && B.id && C.id))
  check('checkAdmin (chua dat mk chu) mo duoc', (await ev(`${V}guardCheckAdmin('bat-ky')`)) === true)
  check('dat mat khau chu', (await ev(`${V}guardSetMaster('master123')`)).ok === true)
  check('dat thoi gian tu khoa 3 phut', (await ev(`${V}guardSetRelock(3)`)).ok === true && (await ev(`${V}guardStatus()`)).relockMinutes === 3)
  check('khoa A', (await ev(`${V}guardSetProfileLock(${JSON.stringify(A.id)},true,3)`)).ok === true)
  check('khoa B', (await ev(`${V}guardSetProfileLock(${JSON.stringify(B.id)},true,3)`)).ok === true)

  const blocked = await ev(`${V}launchProfile(${JSON.stringify(B.id)}).then(()=> 'OPENED', e=>String(e.message))`)
  check('launch profile khoa khi chua mo khoa bi chan (PROFILE_LOCKED)', typeof blocked === 'string' && blocked.includes('PROFILE_LOCKED'), blocked)

  const r1 = await ev(`${V}guardUnlock(${JSON.stringify(A.id)},'sai1')`)
  check('A sai lan 1 -> con 2', r1.action === 'wrong' && r1.remainingProfile === 2, r1)
  const r2 = await ev(`${V}guardUnlock(${JSON.stringify(A.id)},'sai2')`)
  check('A sai lan 2 -> con 1', r2.action === 'wrong' && r2.remainingProfile === 1, r2)
  check('A van con truoc lan sai thu 3', dirExists(A.id) && (await ids()).some((p) => p.id === A.id))
  const r3 = await ev(`${V}guardUnlock(${JSON.stringify(A.id)},'sai3')`)
  check('A sai lan 3 -> wiped-profile', r3.action === 'wiped-profile', r3)
  await sleep(6000)
  const afterT1 = await ids()
  check('A bi XOA khoi danh sach', !afterT1.some((p) => p.id === A.id))
  check('thu muc du lieu A bi XOA', !dirExists(A.id))
  check('B con nguyen', afterT1.some((p) => p.id === B.id) && dirExists(B.id))
  check('C con nguyen', afterT1.some((p) => p.id === C.id) && dirExists(C.id))
  const locked1 = await ev(`${V}guardLockedIds()`)
  check('chi con B trong danh sach khoa', Array.isArray(locked1) && locked1.length === 1 && locked1[0] === B.id, locked1)
  check('dem chung = 3', (await ev(`${V}guardStatus()`)).globalWrong === 3)
  const m = await ev(`${V}guardUnlock(${JSON.stringify(B.id)},'master123')`)
  check('mat khau chu mo B', m.ok === true && m.action === 'master', m)
  check('mat khau chu reset dem chung', (await ev(`${V}guardStatus()`)).globalWrong === 0)

  check('khoa nhom G-TEST', (await ev(`${V}guardSetGroupLock('G-TEST','gcode',3)`)).ok === true)
  const gw = await ev(`${V}guardUnlockGroup('khong-phai')`)
  check('ma nhom sai -> dem chung tang', gw.action === 'wrong' && gw.remainingGlobal === 4, gw)
  const gok = await ev(`${V}guardUnlockGroup('gcode')`)
  check('ma nhom dung -> mo G-TEST', gok.ok === true && gok.group === 'G-TEST', gok)
  const gm = await ev(`${V}guardUnlockGroup('master123')`)
  check('mat khau chu mo moi nhom', gm.ok === true && gm.group === '*', gm)

  let last = null
  for (let i = 1; i <= 5; i++) last = await ev(`${V}guardUnlockGroup('rac${i}')`)
  check('sai lan thu 5 -> wiped-all', last.action === 'wiped-all', last)
  await sleep(6000)
  check('TAT CA profile bi xoa', (await ids()).length === 0 && !dirExists(B.id) && !dirExists(C.id))

  const D = await mk('TEST-D')
  check('dat mk SOS', (await ev(`${V}guardSetSos('sosword')`)).ok === true)
  check('khoa D', (await ev(`${V}guardSetProfileLock(${JSON.stringify(D.id)},true,3)`)).ok === true)
  const sos = await ev(`${V}guardUnlock(${JSON.stringify(D.id)},'sosword')`)
  check('SOS tra ve nhu sai', sos.ok === false && sos.action === 'sos', sos)
  await sleep(6000)
  check('SOS xoa sach D', (await ids()).length === 0 && !dirExists(D.id))

  // Passkey: bật/tắt theo profile + API quản lý không sập khi chưa đăng nhập
  const P = await mk('TEST-PK')
  check('profile moi: passkeys chua dat (mac dinh BAT)', P.passkeys === undefined)
  check('tat passkey -> false', (await ev(`${V}updateProfile(${JSON.stringify(P.id)},{passkeys:false}).then(x=>x.passkeys)`)) === false)
  check('bat lai -> true', (await ev(`${V}updateProfile(${JSON.stringify(P.id)},{passkeys:true}).then(x=>x.passkeys)`)) === true)
  const pl = await ev(`${V}passkeyList(${JSON.stringify(P.id)})`)
  check('passkeyList khi chua dang nhap -> mang rong', Array.isArray(pl) && pl.length === 0)
  const ex = await ev(`${V}passkeyExport(null,'matkhau-12345')`)
  check('passkeyExport khi chua co khoa ma hoa -> loi an toan', ex && ex.ok === false && typeof ex.error === 'string', ex)
  const sy = await ev(`${V}passkeySyncNow()`)
  check('passkeySyncNow khi chua dang nhap -> loi an toan, khong sap', sy && sy.ok === false, sy)

  check('khong co loi JS trong renderer', errors.length === 0, errors)
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.fails.length ? 1 : 0)
})().catch((e) => { out.error = String(e.message || e); console.log(JSON.stringify(out, null, 1)); process.exit(1) })
