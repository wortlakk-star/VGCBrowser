// VGC — dịch vụ chuyển dữ liệu từ Supabase cloud (NGUỒN) sang máy chủ riêng Xeon (ĐÍCH).
// Chạy trên Xeon, Node 22, không thư viện ngoài.
//
// Nhân viên bấm "Chuyển dữ liệu" trong app → app gửi email + mật khẩu VGC tới đây (qua cổng
// vgc-gate). Dịch vụ:
//   1. đăng nhập cloud bằng chính email/mật khẩu đó (chứng minh chủ tài khoản, lấy quyền đọc
//      ĐÚNG dữ liệu của người đó theo RLS — không cần khoá bí mật của cloud);
//   2. tạo/cập nhật tài khoản trên Xeon với CÙNG mã tài khoản (UID), email, mật khẩu;
//   3. chép nguyên từng dòng (profile, proxy, khoá tài khoản, nhóm) và nguyên từng byte mọi file
//      trong kho `profiles/<uid>/` (phiên, két passkey, cấu hình khoá);
//   4. đối chiếu: từng dòng so JSON, từng file so SHA-256 ĐỌC LẠI TỪ ĐÍCH; ghi biên bản.
// Cloud chỉ bị ĐỌC. Dữ liệu đã mã hoá ở máy nhân viên được chép nguyên khối, không giải mã.

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const env = (k, d) => {
  const v = process.env[k] ?? d
  if (v === undefined) throw new Error(`thiếu biến môi trường ${k}`)
  return v
}
const SRC = { url: env('SRC_URL').replace(/\/$/, ''), anon: env('SRC_ANON') }
const DST = { url: env('DST_URL', 'http://127.0.0.1:8000'), key: env('DST_SERVICE_KEY') }
const OPEN = env('MIGRATE_OPEN', '1') === '1'
const PUBLIC_PORT = Number(env('PUBLIC_PORT', '8300'))
const ADMIN_PORT = Number(env('ADMIN_PORT', '8301'))
const BUCKET = 'profiles'
const CONCURRENCY = 4

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function req(url, init = {}, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) })
      if (res.status >= 500 && i < tries - 1) {
        last = new Error(`${res.status} ${await res.text().catch(() => '')}`)
        await sleep(800 * (i + 1))
        continue
      }
      return res
    } catch (e) {
      last = e
      await sleep(800 * (i + 1))
    }
  }
  throw last
}
async function json(res, what) {
  const text = await res.text()
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
const dstHeaders = (extra = {}) => ({ apikey: DST.key, Authorization: `Bearer ${DST.key}`, ...extra })

// Phiên cloud của nhân viên — tự làm mới khi gần hết hạn (job lớn có thể chạy > 1 giờ).
class SrcSession {
  constructor(tok) {
    this.set(tok)
  }
  set(tok) {
    this.access = tok.access_token
    this.refresh = tok.refresh_token
    this.expiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000
    this.user = tok.user ?? this.user
  }
  async headers(extra = {}) {
    if (Date.now() > this.expiresAt - 5 * 60_000) {
      const r = await req(`${SRC.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: SRC.anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.refresh })
      })
      this.set(await json(r, 'làm mới phiên cloud'))
    }
    return { apikey: SRC.anon, Authorization: `Bearer ${this.access}`, ...extra }
  }
}

async function srcLogin(email, password) {
  const r = await req(`${SRC.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SRC.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  if (r.status === 400 || r.status === 401) return null
  return new SrcSession(await json(r, 'đăng nhập cloud'))
}

// ── Tài khoản trên đích: CÙNG UID ───────────────────────────────────────────
async function ensureDstUser(user, password) {
  const g = await req(`${DST.url}/auth/v1/admin/users/${user.id}`, { headers: dstHeaders() })
  const body = {
    email: user.email,
    password,
    email_confirm: true,
    user_metadata: user.user_metadata ?? {}
  }
  if (g.status === 404) {
    const c = await req(`${DST.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: dstHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: user.id, ...body })
    })
    const created = await json(c, 'tạo tài khoản trên máy chủ')
    if (created.id !== user.id) throw new Error('máy chủ tạo tài khoản sai mã UID')
    return 'created'
  }
  const existing = await json(g, 'đọc tài khoản trên máy chủ')
  if (existing.id !== user.id) throw new Error('máy chủ trả sai tài khoản')
  const u = await req(`${DST.url}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: dstHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  })
  await json(u, 'cập nhật tài khoản trên máy chủ')
  return 'updated'
}

// ── Bảng ─────────────────────────────────────────────────────────────────────
const TABLES = [
  { name: 'account_secrets', pk: ['owner'], filter: (uid) => `owner=eq.${uid}` },
  { name: 'profiles_cloud', pk: ['id'], filter: (uid) => `owner=eq.${uid}` },
  { name: 'proxies_cloud', pk: ['id'], filter: (uid) => `owner=eq.${uid}` },
  { name: 'teams', pk: ['id'], filter: (uid) => `owner=eq.${uid}` },
  {
    name: 'team_members',
    pk: ['team_id', 'user_id'],
    filter: (uid, ctx) =>
      ctx.teamIds.length
        ? `or=(user_id.eq.${uid},team_id.in.(${ctx.teamIds.join(',')}))`
        : `user_id=eq.${uid}`
  }
]
const pkOf = (t, row) => t.pk.map((k) => String(row[k])).join('|')

// Viết JSON theo thứ tự khoá cố định để so 2 bên chính xác.
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

async function fetchAll(base, table, filter, headersFn, order) {
  const out = []
  const step = 500
  for (let from = 0; ; from += step) {
    const r = await req(`${base}/rest/v1/${table}?select=*&${filter}&order=${order}`, {
      headers: await headersFn({ Range: `${from}-${from + step - 1}`, 'Range-Unit': 'items' })
    })
    const rows = await json(r, `đọc bảng ${table}`)
    out.push(...rows)
    if (rows.length < step) break
  }
  return out
}

async function dstUpsert(t, rows) {
  // Gói theo dung lượng (~4 MB) — một profile có thể vài MB.
  let batch = []
  let size = 0
  const failed = []
  const flush = async () => {
    if (!batch.length) return
    const r = await req(`${DST.url}/rest/v1/${t.name}?on_conflict=${t.pk.join(',')}`, {
      method: 'POST',
      headers: dstHeaders({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(batch)
    })
    if (!r.ok) {
      const text = await r.text()
      if (batch.length === 1) failed.push({ row: batch[0], error: text.slice(0, 400) })
      else {
        // Ghi từng dòng để chỉ ra đúng dòng hỏng.
        const rows1 = batch
        batch = []
        size = 0
        for (const row of rows1) {
          batch = [row]
          await flush()
        }
      }
    }
    batch = []
    size = 0
  }
  for (const row of rows) {
    const n = JSON.stringify(row).length
    if (size + n > 4_000_000) await flush()
    batch.push(row)
    size += n
  }
  await flush()
  return failed
}

async function dstDeleteByPk(t, pks) {
  for (let i = 0; i < pks.length; i += 100) {
    const chunk = pks.slice(i, i + 100)
    if (t.pk.length === 1) {
      const r = await req(`${DST.url}/rest/v1/${t.name}?${t.pk[0]}=in.(${chunk.join(',')})`, {
        method: 'DELETE',
        headers: dstHeaders({ Prefer: 'return=minimal' })
      })
      await json(r, `xoá dòng thừa ${t.name}`)
    } else {
      for (const pk of chunk) {
        const parts = pk.split('|')
        const q = t.pk.map((k, j) => `${k}=eq.${parts[j]}`).join('&')
        const r = await req(`${DST.url}/rest/v1/${t.name}?${q}`, {
          method: 'DELETE',
          headers: dstHeaders({ Prefer: 'return=minimal' })
        })
        await json(r, `xoá dòng thừa ${t.name}`)
      }
    }
  }
}

async function savePending(t, row, error) {
  const r = await req(`${DST.url}/rest/v1/vgc_migration_pending?on_conflict=tbl,pk`, {
    method: 'POST',
    headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ tbl: t.name, pk: pkOf(t, row), row })
  })
  await json(r, 'lưu dòng chờ')
  log('pending', t.name, pkOf(t, row), error.slice(0, 120))
}

/** Thử lại các dòng đang chờ (của mọi tài khoản) — chạy sau mỗi lần chuyển. */
async function retryPending() {
  const rows = await json(
    await req(`${DST.url}/rest/v1/vgc_migration_pending?select=*`, { headers: dstHeaders() }),
    'đọc dòng chờ'
  )
  let fixed = 0
  for (const p of rows) {
    const t = TABLES.find((x) => x.name === p.tbl)
    if (!t) continue
    const failed = await dstUpsert(t, [p.row])
    if (!failed.length) {
      await req(`${DST.url}/rest/v1/vgc_migration_pending?tbl=eq.${p.tbl}&pk=eq.${encodeURIComponent(p.pk)}`, {
        method: 'DELETE',
        headers: dstHeaders({ Prefer: 'return=minimal' })
      })
      fixed++
    }
  }
  return { fixed, left: rows.length - fixed }
}

// ── Kho file ─────────────────────────────────────────────────────────────────
async function listObjects(base, headersFn, uid) {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const r = await req(`${base}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: await headersFn({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefix: `${uid}/`, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    })
    const items = await json(r, 'liệt kê file')
    for (const it of items) if (it.id) out.push({ ...it, path: `${uid}/${it.name}` })
    if (items.length < 1000) break
  }
  return out
}

async function download(base, headers, path) {
  const r = await req(`${base}/storage/v1/object/${BUCKET}/${path}`, { headers })
  if (!r.ok) throw new Error(`tải ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
  const buf = Buffer.from(await r.arrayBuffer())
  buf.etag = r.headers.get('etag') ?? ''
  return buf
}

async function getManifest(path) {
  const rows = await json(
    await req(`${DST.url}/rest/v1/vgc_migration_objects?name=eq.${encodeURIComponent(path)}&select=*`, {
      headers: dstHeaders()
    }),
    'đọc sổ file'
  )
  return rows[0] ?? null
}

async function copyObject(src, obj, full, dstNames) {
  const etag = obj.metadata?.eTag ?? null
  const size = Number(obj.metadata?.size ?? -1)
  const prev = await getManifest(obj.path)
  if (!full && prev && etag && prev.src_etag === etag && dstNames.has(obj.path)) {
    return { path: obj.path, sha256: prev.sha256, size: Number(prev.size), skipped: true, ok: true }
  }
  const buf = await download(SRC.url, await src.headers(), obj.path)
  if (size >= 0 && buf.length !== size) throw new Error(`${obj.path}: tải về ${buf.length} byte, cloud báo ${size}`)
  const h = sha256(buf)
  const up = await req(`${DST.url}/storage/v1/object/${BUCKET}/${obj.path}`, {
    method: 'POST',
    headers: dstHeaders({
      'Content-Type': obj.metadata?.mimetype || 'application/octet-stream',
      'x-upsert': 'true',
      'Cache-Control': obj.metadata?.cacheControl || 'no-cache'
    }),
    body: buf
  })
  await json(up, `ghi ${obj.path}`)
  // Đối chiếu bằng cách ĐỌC LẠI từ đích.
  const back = await download(DST.url, dstHeaders(), obj.path)
  const h2 = sha256(back)
  if (h2 !== h) throw new Error(`${obj.path}: SHA-256 lệch sau khi chép (${h} ≠ ${h2})`)
  const m = await req(`${DST.url}/rest/v1/vgc_migration_objects?on_conflict=name`, {
    method: 'POST',
    headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      name: obj.path, sha256: h, size: buf.length, src_etag: etag,
      src_etag_hdr: buf.etag || etag, dst_etag: back.etag || null, verified_at: new Date().toISOString()
    })
  })
  await json(m, 'ghi sổ file')
  return { path: obj.path, sha256: h, size: buf.length, skipped: false, ok: true }
}

async function pool(items, n, fn) {
  const results = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++
        results[k] = await fn(items[k], k)
      }
    })
  )
  return results
}

// ── Danh sách nhân viên ─────────────────────────────────────────────────────
const OLD_LICENSE = env('OLD_LICENSE_URL', 'https://vgcbrowser.com/quanly/check.php')
const normEmail = (e) => String(e ?? '').trim().toLowerCase()
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function staffGet(email) {
  const rows = await json(
    await req(`${DST.url}/rest/v1/vgc_staff?email=eq.${encodeURIComponent(email)}&select=*`, { headers: dstHeaders() }),
    'đọc danh sách nhân viên'
  )
  return rows[0] ?? null
}
async function staffUpsert(row) {
  const r = await req(`${DST.url}/rest/v1/vgc_staff?on_conflict=email`, {
    method: 'POST',
    headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() })
  })
  await json(r, 'ghi danh sách nhân viên')
}
/** Nhân viên được duyệt trên trang cũ (/quanly) → duyệt luôn trên máy chủ. Không bao giờ
 *  ghi đè quyết định chủ đã đặt trên máy chủ (vd đã gỡ quyền). */
async function copyApproval(email) {
  const e = normEmail(email)
  const existing = await staffGet(e)
  if (existing && existing.source !== 'hostinger') return existing.approved ? 'đã có trên máy chủ' : 'chủ đã gỡ quyền'
  try {
    const r = await req(`${OLD_LICENSE}?email=${encodeURIComponent(e)}`, { redirect: 'error' })
    const j = await json(r, 'hỏi danh sách cũ')
    await staffUpsert({ email: e, approved: j.approved === true, expires: j.expires || null, source: 'hostinger' })
    return j.approved === true ? 'đã duyệt (chép từ trang cũ)' : `chưa được duyệt trên trang cũ (${j.reason ?? 'không rõ'})`
  } catch (err) {
    return `không hỏi được trang cũ: ${err.message}`
  }
}
function verdict(row) {
  if (!row) return { approved: false, reason: 'not-approved', expires: null }
  if (!row.approved) return { approved: false, reason: 'not-approved', expires: row.expires }
  if (row.expires && new Date(row.expires).getTime() < Date.now()) return { approved: false, reason: 'expired', expires: row.expires }
  return { approved: true, reason: 'ok', expires: row.expires }
}

/** Kiểm tra token máy chủ của người gọi → uid. */
async function dstUserFromToken(authz) {
  if (!/^Bearer [A-Za-z0-9._-]{20,}$/.test(authz ?? '')) return null
  const r = await req(`${DST.url}/auth/v1/user`, { headers: { apikey: DST.key, Authorization: authz } }, 1)
  if (!r.ok) return null
  return r.json()
}

// ── Chuyển hẳn (cutover) ────────────────────────────────────────────────────────
async function getCutover(email) {
  const rows = await json(await req(`${DST.url}/rest/v1/vgc_cutover?email=eq.${encodeURIComponent(email)}&select=*`, { headers: dstHeaders() }), 'đọc chuyển hẳn')
  return rows[0] ?? null
}
async function setCutover(email, uid, runId) {
  const r = await req(`${DST.url}/rest/v1/vgc_cutover?on_conflict=email`, {
    method: 'POST',
    headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ email, uid, run_id: runId, at: new Date().toISOString() })
  })
  await json(r, 'ghi chuyển hẳn')
}

// ── Huỷ khẩn cấp ─────────────────────────────────────────────────────────────
async function getKill() {
  const rows = await json(await req(`${DST.url}/rest/v1/vgc_control?key=eq.kill&select=value`, { headers: dstHeaders() }), 'đọc lệnh')
  return rows[0]?.value ?? { kill: false }
}
async function setKill(v) {
  const r = await req(`${DST.url}/rest/v1/vgc_control?on_conflict=key`, {
    method: 'POST',
    headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: 'kill', value: v, updated_at: new Date().toISOString() })
  })
  await json(r, 'ghi lệnh')
}

// ── Một lần chuyển ───────────────────────────────────────────────────────────
const jobs = new Map() // jobId → job
const runningByUid = new Map() // uid → jobId

async function runJob(job, src, password, full, cutover = false) {
  const uid = src.user.id
  const report = { uid, email: src.user.email, account: null, tables: {}, files: null, pending: null, errors: [] }
  job.report = report
  const step = (s) => {
    job.step = s
    log(uid, s)
  }
  const runRow = await json(
    await req(`${DST.url}/rest/v1/vgc_migration_runs`, {
      method: 'POST',
      headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ uid, email: src.user.email, full_verify: full })
    }),
    'ghi biên bản'
  )
  const runId = runRow[0].id
  try {
    step('Tạo tài khoản trên máy chủ (giữ nguyên mã tài khoản)')
    report.account = await ensureDstUser(src.user, password)
    step('Chép trạng thái duyệt nhân viên')
    report.staff = await copyApproval(src.user.email)

    const ctx = { teamIds: [] }
    for (const t of TABLES) {
      step(`Chép bảng ${t.name}`)
      const rows = await fetchAll(SRC.url, t.name, t.filter(uid, ctx), (h) => src.headers(h), t.pk.join(','))
      if (t.name === 'teams') ctx.teamIds = rows.map((r) => r.id)
      const failed = await dstUpsert(t, rows)
      let pendingN = 0
      for (const f of failed) {
        if (/23503|foreign key/i.test(f.error)) {
          await savePending(t, f.row, f.error)
          pendingN++
        } else report.errors.push(`${t.name} ${pkOf(t, f.row)}: ${f.error}`)
      }
      // Mirror: dòng trên đích của tài khoản này mà cloud không còn → xoá.
      const dstRows = await fetchAll(DST.url, t.name, t.filter(uid, ctx), async (h) => dstHeaders(h), t.pk.join(','))
      const srcKeys = new Set(rows.map((r) => pkOf(t, r)))
      const extra = dstRows.filter((r) => !srcKeys.has(pkOf(t, r))).map((r) => pkOf(t, r))
      if (extra.length) await dstDeleteByPk(t, extra)
      // Đối chiếu từng dòng.
      const after = await fetchAll(DST.url, t.name, t.filter(uid, ctx), async (h) => dstHeaders(h), t.pk.join(','))
      const dstMap = new Map(after.map((r) => [pkOf(t, r), canon(r)]))
      let match = 0
      const mismatch = []
      for (const r of rows) {
        const k = pkOf(t, r)
        if (dstMap.get(k) === canon(r)) match++
        else if (!failed.some((f) => pkOf(t, f.row) === k)) mismatch.push(k)
      }
      for (const k of mismatch) report.errors.push(`${t.name} ${k}: dữ liệu trên máy chủ KHÁC cloud`)
      report.tables[t.name] = { cloud: rows.length, server: after.length, match, pending: pendingN, removed: extra.length }
    }

    step('Liệt kê file trên cloud')
    const srcObjs = await listObjects(SRC.url, (h) => src.headers(h), uid)
    const dstObjs = await listObjects(DST.url, async (h) => dstHeaders(h), uid)
    const dstNames = new Set(dstObjs.map((o) => o.path))
    let done = 0
    job.total = srcObjs.length
    const results = await pool(srcObjs, CONCURRENCY, async (o) => {
      try {
        return await copyObject(src, o, full, dstNames)
      } catch (e) {
        report.errors.push(String(e.message ?? e))
        return { path: o.path, ok: false }
      } finally {
        job.done = ++done
        job.step = `Chép file ${done}/${srcObjs.length}`
      }
    })
    const srcPaths = new Set(srcObjs.map((o) => o.path))
    const extraObjs = dstObjs.filter((o) => !srcPaths.has(o.path)).map((o) => o.path)
    if (extraObjs.length) {
      const r = await req(`${DST.url}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: dstHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: extraObjs })
      })
      await json(r, 'xoá file thừa')
    }
    const okFiles = results.filter((r) => r.ok)
    report.files = {
      cloud: srcObjs.length,
      copied: okFiles.filter((r) => !r.skipped).length,
      unchanged: okFiles.filter((r) => r.skipped).length,
      verified: okFiles.length,
      bytes: okFiles.reduce((s, r) => s + (r.size ?? 0), 0),
      removed: extraObjs.length,
      passkeyVault: srcObjs.some((o) => o.name === '00000000-0000-4000-8000-706b7661756c.cookiesdb.json'),
      guardConfig: srcObjs.some((o) => o.name === '00000000-0000-4000-8000-677561726430.cookiesdb.json'),
      list: okFiles.map((r) => ({ path: r.path, sha256: r.sha256, size: r.size }))
    }

    step('Ghép dữ liệu đang chờ')
    report.pending = await retryPending()

    const tablesOk = Object.values(report.tables).every((t) => t.match + t.pending === t.cloud)
    const filesOk = report.files.verified === report.files.cloud
    job.ok = report.errors.length === 0 && tablesOk && filesOk
    if (job.ok && cutover) {
      await setCutover(normEmail(src.user.email), uid, runId)
      report.cutover = true
      log(uid, 'CUTOVER done — cloud will never be copied again for this account')
    }
  } catch (e) {
    job.ok = false
    report.errors.push(String(e.message ?? e))
  } finally {
    job.state = 'done'
    job.step = job.ok ? 'Xong — khớp 100%' : 'Có lỗi — xem chi tiết'
    runningByUid.delete(uid)
    const slim = { ...report, files: report.files && { ...report.files, list: undefined } }
    await req(`${DST.url}/rest/v1/vgc_migration_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: dstHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({ finished_at: new Date().toISOString(), ok: job.ok, report: { ...slim, filesList: report.files?.list }, error: report.errors.join('\n') || null })
    }).catch((e) => log('không ghi được biên bản', e.message))
    log(uid, 'done ok=', job.ok)
  }
}

function startJob(src, password, full, cutover) {
  const uid = src.user.id
  const running = runningByUid.get(uid)
  if (running) return running
  const id = randomBytes(18).toString('base64url')
  const job = { id, uid, state: 'running', step: 'Bắt đầu', done: 0, total: 0, ok: null, report: null, at: Date.now() }
  jobs.set(id, job)
  runningByUid.set(uid, id)
  void runJob(job, src, password, full, cutover)
  return id
}

// ── HTTP: cổng công khai (qua vgc-gate) ──────────────────────────────────────
function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}
async function readBody(req0, max = 16 * 1024) {
  let n = 0
  const chunks = []
  for await (const c of req0) {
    n += c.length
    if (n > max) throw new Error('quá lớn')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const failures = new Map() // email → {n, until}

http
  .createServer(async (rq, rs) => {
    try {
      const u = new URL(rq.url, 'http://x')
      if (rq.method === 'POST' && u.pathname === '/vgc/v1/migrate/start') {
        if (!OPEN) return send(rs, 410, { error: 'Đã chuyển xong, chức năng chuyển dữ liệu đã đóng.' })
        const b = await readBody(rq)
        const email = String(b.email ?? '').trim().toLowerCase()
        const password = String(b.password ?? '')
        if (!email || !password || password.length > 512) return send(rs, 400, { error: 'Thiếu email hoặc mật khẩu' })
        const f = failures.get(email)
        if (f && f.until > Date.now()) return send(rs, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' })
        const src = await srcLogin(email, password)
        if (!src) {
          const n = (f?.n ?? 0) + 1
          failures.set(email, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 })
          return send(rs, 401, { error: 'Sai email hoặc mật khẩu VGC' })
        }
        failures.delete(email)
        if (await getCutover(email)) return send(rs, 409, { error: 'Tài khoản này đã chuyển hẳn sang máy chủ công ty — hãy cập nhật VGC lên bản mới nhất.' })
        return send(rs, 200, { job: startJob(src, password, b.full === true, false) })
      }
      if (rq.method === 'POST' && u.pathname === '/vgc/v1/migrate/cutover') {
        // Bản 2.2.0, lần đăng nhập đầu: chuyển lần cuối từ cloud rồi khoá — mỗi tài khoản đúng một lần.
        const b = await readBody(rq)
        const email = String(b.email ?? '').trim().toLowerCase()
        const password = String(b.password ?? '')
        if (!email || !password || password.length > 512) return send(rs, 400, { error: 'Thiếu email hoặc mật khẩu' })
        if (await getCutover(email)) return send(rs, 200, { state: 'done' })
        if (!OPEN) return send(rs, 200, { state: 'skip' })
        const f = failures.get(email)
        if (f && f.until > Date.now()) return send(rs, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' })
        const src = await srcLogin(email, password)
        if (!src) {
          // Không có tài khoản cloud (nhân viên mới) hoặc sai mật khẩu: để đăng nhập máy chủ tự báo.
          const n = (f?.n ?? 0) + 1
          failures.set(email, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 })
          return send(rs, 200, { state: 'skip' })
        }
        failures.delete(email)
        return send(rs, 200, { state: 'running', job: startJob(src, password, false, true) })
      }
      if (rq.method === 'GET' && u.pathname === '/vgc/v1/migrate/status') {
        const job = jobs.get(u.searchParams.get('job') ?? '')
        if (!job) return send(rs, 404, { error: 'Không thấy lượt chuyển này' })
        const r = job.report
        return send(rs, 200, {
          state: job.state,
          step: job.step,
          done: job.done,
          total: job.total,
          ok: job.ok,
          report: r && { ...r, files: r.files && { ...r.files, list: undefined } }
        })
      }
      if (rq.method === 'GET' && u.pathname === '/vgc/v1/license/check') {
        const e = normEmail(u.searchParams.get('email'))
        if (!EMAIL_RE.test(e)) return send(rs, 200, { approved: false, reason: 'invalid-email', expires: null })
        return send(rs, 200, verdict(await staffGet(e)))
      }
      if (rq.method === 'POST' && u.pathname === '/vgc/v1/license/register') {
        const b = await readBody(rq)
        const e = normEmail(b.email)
        const row = EMAIL_RE.test(e) ? await staffGet(e) : null
        if (row) {
          await staffUpsert({
            ...row,
            last_seen: new Date().toISOString(),
            machine_name: String(b.machineName ?? '').slice(0, 255),
            machine_id: String(b.machineId ?? '').slice(0, 128),
            os: String(b.os ?? '').slice(0, 32)
          })
        }
        return send(rs, 200, { ok: true })
      }
      if (rq.method === 'GET' && u.pathname === '/vgc/v1/migrate/etags') {
        const user = await dstUserFromToken(rq.headers.authorization)
        if (!user?.id) return send(rs, 401, { error: 'Chưa đăng nhập máy chủ' })
        const rows = await json(
          await req(`${DST.url}/rest/v1/vgc_migration_objects?name=like.${user.id}/*&select=name,src_etag_hdr,dst_etag`, { headers: dstHeaders() }),
          'đọc bảng đối chiếu'
        )
        return send(rs, 200, { map: rows.filter((r) => r.src_etag_hdr && r.dst_etag).map((r) => ({ name: r.name, src: r.src_etag_hdr, dst: r.dst_etag })) })
      }
      if (rq.method === 'GET' && u.pathname === '/vgc/v1/state') {
        const k = await getKill()
        return send(rs, 200, { kill: k.kill === true, at: k.at ?? null })
      }
      if (u.pathname === '/vgc/v1/health') return send(rs, 200, { ok: true, open: OPEN })
      send(rs, 404, { error: 'not found' })
    } catch (e) {
      log('lỗi', e)
      send(rs, 500, { error: 'Lỗi máy chủ' })
    }
  })
  .listen(PUBLIC_PORT, '127.0.0.1', () => log(`migrate public :${PUBLIC_PORT} open=${OPEN} src=${SRC.url}`))

// Dọn job cũ sau 24 giờ.
setInterval(() => {
  for (const [id, j] of jobs) if (j.state === 'done' && Date.now() - j.at > 86_400_000) jobs.delete(id)
}, 3_600_000).unref()

// ── HTTP: trang quản trị (chỉ 127.0.0.1 — chủ mở bằng đường hầm SSH, xem server/admin.sh) ─
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmt = (d) => (d ? new Date(d).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '–')
async function readForm(rq) {
  let body = ''
  for await (const c of rq) {
    body += c
    if (body.length > 65536) throw new Error('quá lớn')
  }
  return Object.fromEntries(new URLSearchParams(body))
}
function sameOrigin(rq) {
  // Chống trang web lạ gửi lệnh vào trang quản trị (CSRF): chỉ nhận form từ chính trang này.
  const o = rq.headers.origin ?? ''
  return o === '' || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o)
}

async function adminPage(msg = '') {
  const runs = await json(
    await req(`${DST.url}/rest/v1/vgc_migration_runs?select=id,uid,email,started_at,finished_at,ok,full_verify,report,error&order=started_at.desc&limit=2000`, { headers: dstHeaders() }),
    'đọc biên bản'
  )
  const pending = await json(await req(`${DST.url}/rest/v1/vgc_migration_pending?select=tbl,pk`, { headers: dstHeaders() }), 'đọc dòng chờ')
  const staff = await json(await req(`${DST.url}/rest/v1/vgc_staff?select=*&order=email`, { headers: dstHeaders() }), 'đọc nhân viên')
  const killState = await getKill()
  const cut = new Map((await json(await req(`${DST.url}/rest/v1/vgc_cutover?select=email,at`, { headers: dstHeaders() }), 'đọc chuyển hẳn')).map((c) => [c.email, c.at]))
  const latest = new Map()
  for (const r of runs) if (!latest.has(r.email)) latest.set(r.email, r)
  const staffRows = staff
    .map((m) => {
      const v = verdict(m)
      const run = latest.get(m.email)
      return `<tr><td>${esc(m.email)}</td><td>${v.approved ? '<b class=ok>Được dùng</b>' : `<b class=bad>${v.reason === 'expired' ? 'Hết hạn' : 'Bị chặn'}</b>`}</td>
<td>${m.expires ? esc(fmt(m.expires)) : 'không hạn'}</td><td>${esc(m.note ?? '')}</td><td>${esc(m.machine_name ?? '')}<br><small>${esc(fmt(m.last_seen))}</small></td>
<td>${cut.has(m.email) ? `<b class=ok>✓ ĐÃ CHUYỂN HẲN</b><br><small>${esc(fmt(cut.get(m.email)))}</small>` : run ? (run.finished_at ? (run.ok ? '<span class=ok>✓ đã chép (chưa lên 2.2.0)</span>' : '<span class=bad>✗ lỗi</span>') : '…') : '<span class=warn>chưa chuyển</span>'}</td>
<td><form method=post action=/staff/toggle><input type=hidden name=email value="${esc(m.email)}"><button>${m.approved ? 'Chặn' : 'Cho dùng'}</button></form></td></tr>`
    })
    .join('')
  const runRows = [...latest.values()]
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((r) => {
      const t = r.report?.tables ?? {}
      const f = r.report?.files ?? {}
      const status = r.finished_at ? (r.ok ? '<b class=ok>✓ Khớp 100%</b>' : '<b class=bad>✗ Lỗi</b>') : '<b>… đang chạy</b>'
      return `<tr><td>${esc(r.email)}</td><td>${status}</td><td>${esc(fmt(r.started_at))}</td>
<td>${t.profiles_cloud ? `${t.profiles_cloud.match}/${t.profiles_cloud.cloud}` : '–'}</td>
<td>${t.proxies_cloud ? `${t.proxies_cloud.match}/${t.proxies_cloud.cloud}` : '–'}</td>
<td>${f.cloud != null ? `${f.verified}/${f.cloud}` : '–'}</td><td>${f.passkeyVault ? 'có, khớp' : f.cloud != null ? 'không có' : '–'}</td>
<td>${f.bytes != null ? (f.bytes / 1048576).toFixed(1) + ' MB' : '–'}</td><td class=err>${esc((r.error ?? '').slice(0, 400))}</td></tr>`
    })
    .join('')
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>VGC — Quản trị máy chủ</title>
<style>body{font:14px system-ui;margin:24px;background:#0b0d14;color:#e8eaf2}table{border-collapse:collapse;width:100%;margin-bottom:28px}td,th{padding:7px 9px;border-bottom:1px solid #222838;text-align:left;vertical-align:top}th{color:#9aa3bd;font-weight:600}.ok{color:#5ee38f}.bad{color:#ff7a76}.warn{color:#f5c26b}.err{color:#ff9a96;font-size:12px;max-width:380px;white-space:pre-wrap}input,button{font:inherit;padding:6px 9px;border-radius:7px;border:1px solid #2a3146;background:#141826;color:#e8eaf2}button{cursor:pointer;background:#18c0ad;color:#05201c;border:0;font-weight:700}.msg{padding:10px 14px;background:#132a24;border-radius:9px;margin:10px 0}small{color:#9aa3bd}</style>
<h2>VGC — Quản trị máy chủ công ty</h2>${msg ? `<div class=msg>${esc(msg)}</div>` : ''}
<h3>Nhân viên được dùng VGC (${staff.filter((m) => verdict(m).approved).length}/${staff.length}) · đã chuyển hẳn ${cut.size}</h3>
<form method=post action=/staff/add style="margin:8px 0 14px;display:flex;gap:8px;flex-wrap:wrap"><input name=email placeholder="email nhân viên" required size=30><input name=note placeholder="ghi chú (tên, bộ phận)"><input name=expires type=date title="hết hạn (bỏ trống = không hạn)"><button>Thêm / cập nhật</button></form>
<table><tr><th>Email</th><th>Quyền</th><th>Hết hạn</th><th>Ghi chú</th><th>Máy dùng gần nhất</th><th>Chuyển dữ liệu</th><th></th></tr>${staffRows}</table>
<h3 style="color:#ff7a76">Huỷ khẩn cấp</h3>
<p>${killState.kill ? `<b class=bad>LỆNH HUỶ ĐANG BẬT từ ${esc(fmt(killState.at))}</b> — app nhân viên xoá dữ liệu trên máy khi kết nối.` : 'Chưa có lệnh huỷ.'}</p>
<form method=post action=/kill style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><input name=confirm placeholder="gõ HUY để xác nhận" size=18><button style="background:#ff4d4d;color:#fff">HUỶ KHẨN CẤP — xoá dữ liệu VGC trên mọi máy nhân viên</button></form>
${killState.kill ? '<form method=post action=/unkill><input type=hidden name=email value=x@x.x><button>Gỡ lệnh huỷ (sau khi đã khôi phục)</button></form>' : ''}
<p><small>Dữ liệu trên máy chủ KHÔNG bị xoá ở bước này. Khoá/huỷ máy chủ: chạy <code>server/kill.sh</code> trên Mac của chủ. Khôi phục: <code>server/restore.sh</code>.</small></p>
<h3>Chuyển dữ liệu từ cloud</h3><p>${latest.size} tài khoản đã bấm chuyển · ${pending.length} dòng đang chờ ghép · nguồn: ${esc(SRC.url)} · ${OPEN ? 'đang MỞ nhận chuyển' : 'ĐÃ ĐÓNG'}</p>
<table><tr><th>Tài khoản</th><th>Kết quả</th><th>Lần cuối</th><th>Profile</th><th>Proxy</th><th>File</th><th>Két passkey</th><th>Dung lượng</th><th>Lỗi</th></tr>${runRows}</table>`
}

http
  .createServer(async (rq, rs) => {
    try {
      const u = new URL(rq.url, 'http://x')
      if (u.pathname === '/api/runs') {
        const runs = await json(await req(`${DST.url}/rest/v1/vgc_migration_runs?select=*&order=started_at.desc&limit=2000`, { headers: dstHeaders() }), 'đọc biên bản')
        return send(rs, 200, { runs })
      }
      if (rq.method === 'POST') {
        if (!sameOrigin(rq)) {
          rs.writeHead(403)
          return rs.end('forbidden')
        }
        const f = await readForm(rq)
        if (u.pathname === '/kill' || u.pathname === '/unkill') {
          let msg
          if (u.pathname === '/kill') {
            if (String(f.confirm ?? '').trim().toUpperCase() !== 'HUY') msg = 'Chưa huỷ: phải gõ đúng chữ HUY để xác nhận.'
            else {
              await setKill({ kill: true, at: new Date().toISOString() })
              msg = 'ĐÃ PHÁT LỆNH HUỶ: mọi app nhân viên sẽ xoá dữ liệu trên máy trong ~30 giây. Chạy server/kill.sh để khoá máy chủ.'
              log('KILL issued from admin page')
            }
          } else {
            await setKill({ kill: false, at: new Date().toISOString() })
            msg = 'Đã gỡ lệnh huỷ — nhân viên đăng nhập lại là dùng được.'
          }
          rs.writeHead(303, { Location: `/?msg=${encodeURIComponent(msg)}` })
          return rs.end()
        }
        const e = normEmail(f.email)
        let msg = ''
        if (!EMAIL_RE.test(e)) msg = 'Email không hợp lệ'
        else if (u.pathname === '/staff/add') {
          const prev = await staffGet(e)
          await staffUpsert({
            ...(prev ?? {}),
            email: e,
            approved: true,
            note: f.note ? String(f.note).slice(0, 200) : (prev?.note ?? null),
            expires: f.expires ? new Date(`${f.expires}T23:59:59+07:00`).toISOString() : null,
            source: 'admin'
          })
          msg = `Đã cho ${e} dùng VGC`
        } else if (u.pathname === '/staff/toggle') {
          const prev = await staffGet(e)
          if (prev) {
            await staffUpsert({ ...prev, approved: !prev.approved, source: 'admin' })
            msg = `${e}: ${prev.approved ? 'ĐÃ CHẶN' : 'đã cho dùng lại'}`
          }
        }
        rs.writeHead(303, { Location: `/?msg=${encodeURIComponent(msg)}` })
        return rs.end()
      }
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" })
      rs.end(await adminPage(u.searchParams.get('msg') ?? ''))
    } catch (e) {
      rs.writeHead(500)
      rs.end(String(e.message ?? e))
    }
  })
  .listen(ADMIN_PORT, '127.0.0.1', () => log(`admin :${ADMIN_PORT}`))
