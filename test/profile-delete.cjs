// Deletes the given profile ids from BOTH the local store (window.vgc.deleteProfile)
// AND the cloud (profiles_cloud table + storage zip), so they don't re-sync back.
// Usage: node test/profile-delete.cjs <appWindowWs> <id1,id2,...>
const WebSocket = require('ws')
const ws = new WebSocket(process.argv[2], { perMessageDeflate: false })
const ids = (process.argv[3] || '').split(',').filter(Boolean)
let id = 0
const pending = {}
function send(method, params) {
  return new Promise((res) => {
    const i = ++id
    pending[i] = res
    ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  })
}
ws.on('message', (m) => {
  const o = JSON.parse(m)
  if (o.id && pending[o.id]) { pending[o.id](o); delete pending[o.id] }
})
const expr = `(async () => {
  const ids = ${JSON.stringify(ids)};
  const out = { localDeleted: 0, cloudDeleted: [], errors: [] };
  // 1) local store
  for (const id of ids) { try { await window.vgc.deleteProfile(id); out.localDeleted++; } catch(e){ out.errors.push('local ' + id + ': ' + e); } }
  // 2) cloud (profiles_cloud row + storage zip)
  try {
    const s = await window.vgc.getSettings();
    let token = null, uid = null;
    try {
      const raw = localStorage.getItem('vgc-cloud-auth');
      const sess = raw ? JSON.parse(raw) : null;
      const cur = sess && (sess.currentSession || sess);
      token = cur && cur.access_token;
      uid = cur && cur.user && cur.user.id;
    } catch(e){ out.errors.push('token: ' + e); }
    if (token && s.supabaseUrl && s.supabaseAnonKey) {
      const H = { apikey: s.supabaseAnonKey, Authorization: 'Bearer ' + token };
      for (const id of ids) {
        try {
          const r = await fetch(s.supabaseUrl + '/rest/v1/profiles_cloud?profile_id=eq.' + encodeURIComponent(id), { method:'DELETE', headers: Object.assign({ Prefer:'return=minimal' }, H) });
          out.cloudDeleted.push(id.slice(0,8) + ':' + r.status);
          if (uid) { try { await fetch(s.supabaseUrl + '/storage/v1/object/profiles/' + uid + '/' + id + '.zip', { method:'DELETE', headers: H }); } catch(e){} }
        } catch(e){ out.errors.push('cloud ' + id + ': ' + e); }
      }
    } else { out.errors.push('NO cloud token/config (chua dang nhap?)'); }
  } catch(e){ out.errors.push('cloud setup: ' + e); }
  return out;
})()`
ws.on('open', async () => {
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 60000 })
  const cmd = r.result || {}
  if (cmd.exceptionDetails) console.log('EVAL EXCEPTION: ' + JSON.stringify(cmd.exceptionDetails.exception || cmd.exceptionDetails))
  else console.log(JSON.stringify(cmd.result && cmd.result.value, null, 2))
  ws.close()
  process.exit(0)
})
ws.on('error', (e) => { console.log('WS ERROR: ' + e.message); process.exit(1) })
setTimeout(() => { console.log('timeout'); process.exit(1) }, 70000)
