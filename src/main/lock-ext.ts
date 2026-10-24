// ── VGC Browser — khoá cửa sổ trình duyệt của profile (extension + máy chủ cục bộ) ──
// Profile đã bật khoá được nạp thêm một extension "VGC Lock": khi hệ thống không có thao
// tác trong N phút (cấu hình ở Cài đặt) hoặc màn hình Windows bị khoá, extension THU NHỎ mọi
// cửa sổ của profile và hiện một hộp nhập mật khẩu; nhập đúng mới khôi phục. Mật khẩu KHÔNG
// nằm trong extension — nó hỏi app qua máy chủ HTTP 127.0.0.1 (token riêng mỗi lần mở profile),
// nên việc đếm sai / tự huỷ vẫn do guard.ts quyết định như khi mở profile.
//
// Extension nằm NGOÀI Default/ (cloud chỉ nén Default/) và được ghi lại mỗi lần mở.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getRelockMinutes, isLocked, unlock } from './guard'

// ── Máy chủ cục bộ ────────────────────────────────────────────────────────────
const tokens = new Map<string, string>() // token -> profileId
let server: Server | null = null
let serverPort = 0
let starting: Promise<number> | null = null

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > 4096) throw new Error('too large')
    chunks.push(chunk as Buffer)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    send(res, 204, {})
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (req.method === 'GET' && url.pathname === '/cfg') {
      const id = tokens.get(url.searchParams.get('t') ?? '')
      if (!id) return send(res, 403, { error: 'forbidden' })
      // Profile đã được gỡ khoá khi đang chạy → extension không cần khoá nữa.
      const idleMin = (await isLocked(id)) ? await getRelockMinutes() : 0
      return send(res, 200, { idleMin })
    }
    if (req.method === 'POST' && url.pathname === '/unlock') {
      const body = await readJson(req)
      const id = tokens.get(String(body.t ?? ''))
      if (!id) return send(res, 403, { error: 'forbidden' })
      if (!(await isLocked(id))) return send(res, 200, { ok: true, action: 'ok' })
      // grant=false: đây là mở lại cửa sổ đang chạy, không cấp vé mở profile.
      const r = await unlock(id, String(body.pw ?? '').slice(0, 1024), false)
      // Mật khẩu SOS đã kích hoạt xoá nền — trả về như "sai" để không lộ gì.
      if (r.action === 'sos') return send(res, 200, { ok: false, action: 'wrong' })
      return send(res, 200, r)
    }
    return send(res, 404, { error: 'not found' })
  } catch {
    return send(res, 400, { error: 'bad request' })
  }
}

function ensureServer(): Promise<number> {
  if (server && serverPort) return Promise.resolve(serverPort)
  if (starting) return starting
  starting = new Promise<number>((resolve, reject) => {
    const s = createServer((req, res) => void handle(req, res))
    s.once('error', (e) => {
      starting = null
      reject(e)
    })
    s.listen(0, '127.0.0.1', () => {
      server = s
      serverPort = (s.address() as { port: number }).port
      starting = null
      resolve(serverPort)
    })
  })
  return starting
}

/** Huỷ mọi token của profile (khi engine thoát) để extension cũ không còn hỏi được nữa. */
export function releaseLockTokens(profileId: string): void {
  for (const [t, id] of tokens) if (id === profileId) tokens.delete(t)
}

// ── Mã nguồn extension ───────────────────────────────────────────────────────
const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'VGC Lock',
  version: '1.0',
  permissions: ['idle', 'storage', 'alarms'],
  host_permissions: ['http://127.0.0.1/*'],
  background: { service_worker: 'background.js' }
})

const BACKGROUND_JS = String.raw`importScripts('config.js');
var BASE = 'http://127.0.0.1:' + VGC.port;
var ss = chrome.storage.session;

async function st() { return await ss.get(['locked', 'prev', 'lockWin']); }

async function showLock() {
  var w = await chrome.windows.create({
    url: chrome.runtime.getURL('lock.html'), type: 'popup', width: 400, height: 330, focused: true
  });
  await ss.set({ lockWin: w.id });
}

async function minimizeOthers() {
  var s = await st();
  var wins = await chrome.windows.getAll();
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    if (w.id !== s.lockWin && w.state !== 'minimized') {
      try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch (e) {}
    }
  }
}

async function lock() {
  var s = await st();
  if (s.locked) return;
  var wins = await chrome.windows.getAll();
  var prev = {};
  for (var i = 0; i < wins.length; i++) prev[wins[i].id] = wins[i].state;
  await ss.set({ locked: true, prev: prev });
  await showLock();
  await minimizeOthers();
}

async function unlockNow() {
  var s = await st();
  await ss.set({ locked: false });
  var prev = s.prev || {};
  var ids = Object.keys(prev);
  for (var i = 0; i < ids.length; i++) {
    var state = prev[ids[i]];
    if (state === 'minimized') continue;
    try { await chrome.windows.update(Number(ids[i]), { state: state || 'normal' }); } catch (e) {}
  }
  if (s.lockWin) { try { await chrome.windows.remove(s.lockWin); } catch (e) {} }
  await ss.set({ lockWin: null, prev: {} });
}

chrome.windows.onFocusChanged.addListener(async function (id) {
  var s = await st();
  if (!s.locked || id === chrome.windows.WINDOW_ID_NONE || id === s.lockWin) return;
  try { await chrome.windows.update(id, { state: 'minimized' }); } catch (e) {}
  if (s.lockWin) { try { await chrome.windows.update(s.lockWin, { focused: true }); } catch (e) {} }
});
chrome.windows.onCreated.addListener(async function (w) {
  var s = await st();
  if (!s.locked || w.id === s.lockWin) return;
  try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch (e) {}
});
chrome.windows.onBoundsChanged.addListener(async function (w) {
  var s = await st();
  if (!s.locked || w.id === s.lockWin || w.state === 'minimized') return;
  try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch (e) {}
});
chrome.windows.onRemoved.addListener(async function (id) {
  var s = await st();
  if (s.locked && id === s.lockWin) {
    setTimeout(async function () {
      var s2 = await st();
      if (s2.locked) { await showLock(); await minimizeOthers(); }
    }, 250);
  }
});

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || msg.type !== 'unlock') return;
  (async function () {
    try {
      var r = await fetch(BASE + '/unlock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: VGC.token, pw: String(msg.pw || '') })
      });
      var j = await r.json();
      if (j && j.ok) await unlockNow();
      sendResponse(j);
    } catch (e) {
      sendResponse({ ok: false, action: 'error' });
    }
  })();
  return true;
});

async function arm() {
  var m = 0;
  try {
    var r = await fetch(BASE + '/cfg?t=' + VGC.token);
    var j = await r.json();
    m = Number(j.idleMin) || 0;
  } catch (e) { return; }
  chrome.idle.setDetectionInterval(m > 0 ? Math.max(15, Math.round(m * 60)) : 86400);
  await ss.set({ armed: m > 0 });
}
chrome.idle.onStateChanged.addListener(async function (state) {
  var s = await ss.get('armed');
  if (!s.armed) return;
  if (state === 'idle' || state === 'locked') lock();
});
chrome.alarms.create('vgc-rearm', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'vgc-rearm') arm(); });
chrome.runtime.onStartup.addListener(arm);
chrome.runtime.onInstalled.addListener(arm);
arm();
`

const LOCK_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>VGC Browser — Đã khoá</title>
<style>
  html,body{margin:0;height:100%;background:#0e1120;color:#eef0f7;font-family:Segoe UI,Inter,system-ui,sans-serif}
  .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px;box-sizing:border-box}
  .ic{font-size:38px}
  h1{margin:0;font-size:18px}
  p{margin:0;color:#9aa3bd;font-size:13px;text-align:center}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;border:1px solid #2b3354;background:#161a2e;color:#eef0f7;font-size:15px;outline:none}
  input:focus{border-color:#18c0ad}
  button{width:100%;padding:10px;border:none;border-radius:9px;background:linear-gradient(90deg,#2563eb,#06b6d4);color:#fff;font-weight:700;font-size:14px;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  #msg{min-height:18px;color:#ff7b72;font-weight:600;font-size:13px;text-align:center}
</style></head>
<body><div class="box">
  <div class="ic">🔒</div>
  <h1>Profile đã khoá</h1>
  <p>Nhập mật khẩu để tiếp tục dùng trình duyệt.</p>
  <input id="pw" type="password" placeholder="Mật khẩu" autocomplete="off" autofocus>
  <button id="go">Mở khoá</button>
  <div id="msg"></div>
</div><script src="lock.js"></script></body></html>`

const LOCK_JS = String.raw`var pw = document.getElementById('pw');
var go = document.getElementById('go');
var msg = document.getElementById('msg');
async function submit() {
  if (!pw.value) return;
  go.disabled = true; msg.textContent = '';
  var r;
  try { r = await chrome.runtime.sendMessage({ type: 'unlock', pw: pw.value }); } catch (e) { r = { ok: false, action: 'error' }; }
  go.disabled = false;
  if (r && r.ok) return;
  pw.value = ''; pw.focus();
  if (!r || r.action === 'error') msg.textContent = 'Không kết nối được VGC Browser.';
  else if (r.action === 'wiped-profile') msg.textContent = 'Nhập sai quá số lần — profile đã bị xoá vĩnh viễn.';
  else if (r.action === 'wiped-all') msg.textContent = 'Nhập sai quá số lần — TẤT CẢ profile đã bị xoá vĩnh viễn.';
  else {
    var t = 'Sai mật khẩu.';
    if (typeof r.remainingProfile === 'number') t += ' Còn ' + r.remainingProfile + ' lần trước khi xoá profile này.';
    msg.textContent = t;
  }
}
go.addEventListener('click', submit);
pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
`

/**
 * Ghi extension khoá vào thư mục profile và trả về đường dẫn để --load-extension.
 * Trả null khi tính năng tự khoá đang tắt (relockMinutes = 0) hoặc không dựng được máy chủ.
 */
export async function ensureLockExtension(userDataDir: string, profileId: string): Promise<string | null> {
  try {
    if ((await getRelockMinutes()) <= 0) return null
    const port = await ensureServer()
    releaseLockTokens(profileId)
    const token = randomBytes(24).toString('hex')
    tokens.set(token, profileId)
    const dir = join(userDataDir, 'vgc-lock-ext')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const write = (name: string, content: string): void =>
      writeFileSync(join(dir, name), content, { encoding: 'utf8', mode: 0o600 })
    write('manifest.json', MANIFEST)
    write('config.js', `var VGC = ${JSON.stringify({ port, token })};\n`)
    write('background.js', BACKGROUND_JS)
    write('lock.html', LOCK_HTML)
    write('lock.js', LOCK_JS)
    return dir
  } catch {
    return null // không chặn việc mở profile nếu không dựng được khoá cửa sổ
  }
}
