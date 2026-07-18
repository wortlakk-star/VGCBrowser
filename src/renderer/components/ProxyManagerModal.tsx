import { useEffect, useState, type CSSProperties } from 'react'
import type { Profile, ProxyProviderId, ProxyType, SavedProxy } from '../../shared/types'
import { deleteCloudProxy } from '../cloud'
import { parseLine } from '../lib/proxy-parse'

// Providers that support "Tạo proxy qua API" in this screen.
const PROVIDERS: Array<[ProxyProviderId, string]> = [
  ['iproyal', 'iProyal'],
  ['evomi', 'Evomi'],
  ['cliproxy', 'Cliproxy']
]

// Cliproxy sticky lifetimes (value in s/m/h → nhãn). Cliproxy caps sticky at 120 phút.
const CLIPROXY_LIFETIMES: Array<[string, string]> = [
  ['', 'Mặc định (tối đa 120 phút)'],
  ['15m', '15 phút'],
  ['30m', '30 phút'],
  ['1h', '1 giờ'],
  ['2h', '2 giờ (tối đa)']
]

// Evomi products (code → tên hiển thị) — the API param `product`. Only the products
// whose code is identical across Evomi's generate + balance endpoints are listed, so a
// pick always works (datacenter uses conflicting codes in Evomi's own docs — omitted).
const EVOMI_PRODUCTS: Array<[string, string]> = [
  ['rpc', 'Residential (Core)'],
  ['rp', 'Residential (Premium)'],
  ['mp', 'Mobile']
]

// Evomi sticky lifetimes (value in s/m/h → nhãn). Max is 24h (Evomi caps sticky at
// 1440 minutes); to hold an IP longer, use the "Giữ lâu nhất" (hard) session instead.
const EVOMI_LIFETIMES: Array<[string, string]> = [
  ['', 'Mặc định (30 phút)'],
  ['10m', '10 phút'],
  ['30m', '30 phút'],
  ['1h', '1 giờ'],
  ['6h', '6 giờ'],
  ['12h', '12 giờ'],
  ['24h', '24 giờ (tối đa)']
]

const genId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

// Common iProyal residential countries for the generate dropdown (ISO-2 code → tên).
const IP_COUNTRIES: Array<[string, string]> = [
  ['', 'Bất kỳ (toàn cầu)'],
  ['us', 'Hoa Kỳ'],
  ['gb', 'Anh'],
  ['ca', 'Canada'],
  ['au', 'Úc'],
  ['de', 'Đức'],
  ['fr', 'Pháp'],
  ['nl', 'Hà Lan'],
  ['it', 'Ý'],
  ['es', 'Tây Ban Nha'],
  ['vn', 'Việt Nam'],
  ['sg', 'Singapore'],
  ['jp', 'Nhật Bản'],
  ['kr', 'Hàn Quốc'],
  ['th', 'Thái Lan'],
  ['my', 'Malaysia'],
  ['ph', 'Philippines'],
  ['id', 'Indonesia'],
  ['in', 'Ấn Độ'],
  ['hk', 'Hồng Kông'],
  ['tw', 'Đài Loan'],
  ['br', 'Brazil']
]

// iProyal sticky lifetimes in the API-accepted format (s/h — the minutes unit 'm'
// is rejected). Value → nhãn. '' = bỏ trống (iProyal chọn mặc định). Tối đa 7 ngày.
const IP_LIFETIMES: Array<[string, string]> = [
  ['', 'Mặc định (bỏ trống)'],
  ['600s', '10 phút'],
  ['1800s', '30 phút'],
  ['1h', '1 giờ'],
  ['6h', '6 giờ'],
  ['12h', '12 giờ'],
  ['24h', '24 giờ (1 ngày)'],
  ['72h', '3 ngày'],
  ['168h', '7 ngày (tối đa)']
]


export function ProxyManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [proxies, setProxies] = useState<SavedProxy[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [checking, setChecking] = useState<Set<string>>(new Set())
  const [paste, setPaste] = useState('')
  const [importType, setImportType] = useState<ProxyType>('socks5')
  const [importName, setImportName] = useState('')
  const [msg, setMsg] = useState('')
  // Profiles whose proxy is DEAD (found by "Check proxy tất cả profile") — drives the
  // "Thay mới đồng loạt" button.
  const [deadProfiles, setDeadProfiles] = useState<Profile[]>([])
  const [scanning, setScanning] = useState(false)

  // Provider API — generate options (credentials live in Settings → Nhà cung cấp Proxy)
  const [genProvider, setGenProvider] = useState<ProxyProviderId>('iproyal')
  const [genProduct, setGenProduct] = useState('rpc') // Evomi product
  const [genCountry, setGenCountry] = useState('')
  const [genProtocol, setGenProtocol] = useState<'http' | 'socks5'>('http')
  const [genSticky, setGenSticky] = useState(true)
  const [genHard, setGenHard] = useState(false) // Evomi "hard" session (keep IP longest)
  const [genLifetime, setGenLifetime] = useState('24h')
  const [genCount, setGenCount] = useState(5)
  const [genLabel, setGenLabel] = useState('')
  const [generating, setGenerating] = useState(false)
  const [balance, setBalance] = useState<{ availableGb: number; subusers: number } | null>(null)
  const [loadingBal, setLoadingBal] = useState(false)

  const providerName = (p: ProxyProviderId): string =>
    PROVIDERS.find(([id]) => id === p)?.[1] ?? p

  // Remaining traffic/balance (GB) on the selected provider account.
  const checkBalance = async (): Promise<void> => {
    setLoadingBal(true)
    setBalance(null)
    try {
      const b = await window.vgc.getProviderBalance(
        genProvider,
        genProvider === 'evomi' ? genProduct : undefined
      )
      setBalance(b)
      setMsg(`✓ ${providerName(genProvider)} còn ${b.availableGb.toFixed(2)} GB traffic.`)
    } catch (e) {
      setMsg(`Lỗi xem GB: ${(e as Error).message}`)
    } finally {
      setLoadingBal(false)
    }
  }

  const refresh = async (): Promise<void> => {
    const [px, profs] = await Promise.all([
      window.vgc.listProxies(),
      window.vgc.listProfiles()
    ])
    // Sync each pool proxy's "đang dùng cho" with the profiles' ACTUAL proxy config
    // (the source of truth): if a profile currently routes through this proxy's IP, mark
    // it assigned to that profile; otherwise leave it blank ("trống"). Keeps the pool in
    // sync even when a proxy was set on a profile outside this modal (import, generate…).
    // Match the FULL proxy (incl. password) — iProyal rotating proxies share the same
    // host/port/username and differ ONLY by the password (session), so matching without
    // the password would assign every US-x proxy to the one profile that uses that
    // gateway. The password uniquely identifies each proxy's exit IP.
    // A profile uses exactly ONE proxy, so a profile may be claimed by at most one pool
    // entry — otherwise N fully-identical proxies (rotating, or a double import) would all
    // show "đang dùng cho" the same profile and the used/free counts would be wrong. Claim
    // each profile once, in pool order.
    const claimed = new Set<string>()
    const usedByProfile = (p: SavedProxy): string => {
      const m = profs.find(
        (pr) =>
          !claimed.has(pr.id) &&
          pr.proxy &&
          pr.proxy.type !== 'none' &&
          (pr.proxy.host || '') === (p.host || '') &&
          Number(pr.proxy.port) === Number(p.port) &&
          (pr.proxy.username || '') === (p.username || '') &&
          (pr.proxy.password || '') === (p.password || '')
      )
      if (m) {
        claimed.add(m.id)
        return m.id
      }
      return ''
    }
    const changed: SavedProxy[] = []
    const synced = px.map((p) => {
      const to = usedByProfile(p)
      if ((p.assignedTo || '') !== to) {
        // Stamp updatedAt so this local assignment-sync WINS over a stale cloud copy in
        // saveManyProxies' newer-wins merge (else a concurrent cloud pull could drop it).
        const np = { ...p, assignedTo: to, updatedAt: new Date().toISOString() }
        changed.push(np)
        return np
      }
      return p
    })
    if (changed.length) await window.vgc.saveManyProxies(changed)
    setProxies(synced)
    setProfiles(profs)
  }
  useEffect(() => {
    void refresh()
  }, [])

  const generate = async (): Promise<void> => {
    const creds = await window.vgc.getProviderCreds()
    if (genProvider === 'evomi') {
      if (!creds.evomi?.apiKey) {
        setMsg('Lỗi: chưa có API key Evomi. Vào Cài đặt → Nhà cung cấp Proxy để nhập API key.')
        return
      }
    } else if (genProvider === 'cliproxy') {
      const cp = creds.cliproxy
      if (!cp?.username || !cp?.password || !cp?.port) {
        setMsg('Lỗi: chưa có tài khoản Cliproxy. Vào Cài đặt → Nhà cung cấp Proxy để nhập host/port + user/pass.')
        return
      }
    } else {
      const ip = creds.iproyal
      if (!ip?.apiToken || !ip?.username || !ip?.password) {
        setMsg('Lỗi: chưa có tài khoản iProyal. Vào Cài đặt → Nhà cung cấp Proxy để nhập token + user/pass.')
        return
      }
    }
    setGenerating(true)
    setMsg(`Đang tạo ${genCount} proxy qua API ${providerName(genProvider)}…`)
    try {
      const created = await window.vgc.generateProviderProxies({
        provider: genProvider,
        product: genProvider === 'evomi' ? genProduct : undefined,
        count: genCount,
        country: genCountry,
        protocol: genProtocol,
        sticky: genSticky,
        hard: genProvider === 'evomi' ? genHard : undefined,
        lifetime: genSticky && !genHard ? genLifetime : undefined,
        label: genLabel.trim() || undefined
      })
      await window.vgc.saveManyProxies(created)
      setMsg(`✓ Đã tạo ${created.length} proxy ${providerName(genProvider)} và thêm vào pool.`)
      await refresh()
    } catch (e) {
      setMsg(`Lỗi: ${(e as Error).message}`)
    } finally {
      setGenerating(false)
    }
  }

  const profileName = (id?: string): string =>
    id ? profiles.find((p) => p.id === id)?.name ?? '(đã xoá)' : ''

  const toggle = (id: string): void =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const tickAll = (): void => setChecked(new Set(proxies.map((p) => p.id)))
  const untick = (): void => setChecked(new Set())

  // Probe one proxy → return the updated record (does NOT save, to avoid racing
  // parallel writes; callers persist via saveProxy/saveManyProxies).
  const probe = async (p: SavedProxy): Promise<SavedProxy> => {
    setChecking((s) => new Set(s).add(p.id))
    try {
      const res = await window.vgc.checkProxy({
        type: p.type,
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.password
      })
      return {
        ...p,
        lastStatus: res.ok ? 'ok' : 'error',
        lastIp: res.ip,
        lastCountry: res.country,
        lastCountryCode: res.countryCode,
        latencyMs: res.latencyMs
      }
    } finally {
      setChecking((s) => {
        const n = new Set(s)
        n.delete(p.id)
        return n
      })
    }
  }

  const checkOne = async (p: SavedProxy): Promise<void> => {
    await window.vgc.saveProxy(await probe(p))
    await refresh()
  }

  // Check many in parallel (cap 8 concurrent), save ALL at once at the end.
  const checkMany = async (list: SavedProxy[]): Promise<void> => {
    if (!list.length) return
    setMsg(`Đang check ${list.length} proxy…`)
    const CONC = 8
    const out: SavedProxy[] = []
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < list.length) {
        const idx = i++
        out.push(await probe(list[idx]))
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, () => worker()))
    await window.vgc.saveManyProxies(out)
    const ok = out.filter((p) => p.lastStatus === 'ok').length
    setMsg(`✓ Xong: ${ok} sống / ${out.length - ok} lỗi`)
    await refresh()
  }

  const assign = async (proxy: SavedProxy, profileId: string): Promise<void> => {
    try {
      // If this proxy was on a different profile, clear that profile's proxy first.
      // That profile may have been DELETED while the modal was open (stale state) →
      // updateProfile would throw "không tìm thấy profile"; ignore it so we don't abort
      // mid-assign and leave the pool desynced.
      if (proxy.assignedTo && proxy.assignedTo !== profileId) {
        await window.vgc
          .updateProfile(proxy.assignedTo, { proxy: { type: 'none' } })
          .catch(() => {})
      }
      if (profileId) {
        await window.vgc.updateProfile(profileId, {
          proxy: { type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
        })
        // ensure 1 proxy ↔ 1 profile: clear other proxies pointing at this profile
        for (const x of proxies) {
          if (x.id !== proxy.id && x.assignedTo === profileId) {
            await window.vgc.saveProxy({ ...x, assignedTo: '' })
          }
        }
      }
      await window.vgc.saveProxy({ ...proxy, assignedTo: profileId || '' })
      setMsg(profileId ? `✓ Đã gán "${proxy.label}" cho "${profileName(profileId)}"` : 'Đã bỏ gán.')
    } catch (e) {
      setMsg(`Lỗi gán proxy: ${(e as Error).message}`)
    }
    await refresh()
  }

  // Class a proxy by host: raw-IPv4 = a dedicated STATIC proxy; anything else (a domain
  // gateway like rp.evomi.com) = ROTATING RESIDENTIAL. A replacement must match class so a
  // PayPal account on a static IP never lands on a rotating residential one, and a Gmail
  // account on residential isn't handed a scarce dedicated static.
  const proxyClass = (host?: string): 'static' | 'res' =>
    host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? 'static' : 'res'

  // STEP 1 — check EVERY profile's own proxy (the embedded config, the source of truth the
  // list's "proxy lỗi" badge comes from) and list which profiles are DEAD. Fills
  // `deadProfiles`, which reveals the "Thay mới đồng loạt" button. Non-destructive.
  const scanDeadProfiles = async (): Promise<void> => {
    const withProxy = profiles.filter((p) => p.proxy && p.proxy.type !== 'none' && p.proxy.host)
    if (!withProxy.length) {
      setDeadProfiles([])
      setMsg('Không có profile nào đang dùng proxy.')
      return
    }
    setScanning(true)
    const dead: Profile[] = []
    let done = 0
    setMsg(`Đang kiểm tra proxy của ${withProxy.length} profile… (0/${withProxy.length})`)
    let i = 0
    const worker = async (): Promise<void> => {
      while (i < withProxy.length) {
        const prof = withProxy[i++]
        let ok = false
        try {
          ok = (await window.vgc.checkProxy(prof.proxy)).ok
        } catch {
          ok = false
        }
        done++
        if (done % 5 === 0 || done === withProxy.length)
          setMsg(`Đang kiểm tra proxy… (${done}/${withProxy.length})`)
        if (!ok) dead.push(prof)
      }
    }
    await Promise.all(Array.from({ length: Math.min(10, withProxy.length) }, () => worker()))
    setScanning(false)
    setDeadProfiles(dead)
    if (!dead.length) {
      setMsg(`✓ Đã check ${withProxy.length} profile — TẤT CẢ proxy còn SỐNG.`)
      return
    }
    const show = dead.slice(0, 25).map((d) => `• ${d.name}`).join('\n')
    setMsg(
      `⚠️ ${dead.length}/${withProxy.length} profile proxy CHẾT:\n${show}` +
        (dead.length > 25 ? `\n…và ${dead.length - 25} nữa` : '') +
        `\n\n→ Bấm "🔧 Thay mới đồng loạt (${dead.length})" để đổi hết sang proxy rảnh cùng nước, cùng loại.`
    )
  }

  // STEP 2 — for every DEAD profile (from step 1), assign a free, same-country, same-CLASS,
  // still-alive proxy from the pool, all at once. Each dead profile's proxy is re-verified
  // first (skip any that recovered). Reuses assign() so profile.proxy + pool assignedTo update
  // exactly like a manual assign. A candidate is committed only after a live check confirms it
  // is alive AND (when we know the dead one's country) the same country.
  // Core replace: give each profile in `deadList` a free, same-CLASS, same-country, alive
  // proxy from the pool. Reuses assign() (updateProfile + pool assignedTo). Does NOT re-check
  // the dead proxy — the caller already decided the list (a live scan, or the "proxy lỗi"
  // badge); it only live-verifies the NEW proxy so a dead replacement is never assigned.
  const doReplaceProfiles = async (deadList: Profile[]): Promise<void> => {
    const profById = new Map(profiles.map((p) => [p.id, p]))
    // free candidates = pool proxies not currently assigned to an existing profile
    const free = proxies.filter((p) => !p.assignedTo || !profById.has(p.assignedTo))
    const usedIds = new Set<string>()
    const replaced: string[] = []
    const unresolved: string[] = []
    let done = 0

    for (const prof of deadList) {
      done++
      setMsg(`Đang thay… (${done}/${deadList.length})`)
      const wantCls = proxyClass(prof.proxy.host)
      const wantCC = prof.proxyCheck?.countryCode || ''
      // A STATIC profile (dedicated IP — PayPal/Stripe) MUST stay on a static IP: never hand it
      // a rotating residential. A RESIDENTIAL profile (e.g. Gmail) prefers residential but will
      // accept a static too (a dedicated IP is even more stable for it) — so a batch of new
      // proxies of the "wrong" class still gets used instead of leaving the profile unfixed.
      const classOk = (fCls: 'static' | 'res'): boolean =>
        wantCls === 'static' ? fCls === 'static' : true
      const cands = free
        .filter(
          (f) =>
            !usedIds.has(f.id) &&
            classOk(proxyClass(f.host)) &&
            (!wantCC || !f.lastCountryCode || f.lastCountryCode === wantCC)
        )
        .sort((a, b) => {
          // prefer SAME class first, then SAME country
          const ac = proxyClass(a.host) === wantCls ? 0 : 1
          const bc = proxyClass(b.host) === wantCls ? 0 : 1
          if (ac !== bc) return ac - bc
          return (a.lastCountryCode === wantCC ? 0 : 1) - (b.lastCountryCode === wantCC ? 0 : 1)
        })
      let picked: SavedProxy | null = null
      for (const cand of cands) {
        const probed = await probe(cand)
        await window.vgc.saveProxy(probed)
        if (probed.lastStatus !== 'ok') continue
        if (wantCC && probed.lastCountryCode && probed.lastCountryCode !== wantCC) continue
        picked = probed
        break
      }
      if (!picked) {
        unresolved.push(prof.name)
        continue
      }
      usedIds.add(picked.id)
      await assign(picked, prof.id) // updateProfile(proxy) + saveProxy(assignedTo)
      // Clear the profile's "proxy lỗi" badge right away by writing a fresh proxyCheck from the
      // new proxy (which we already live-verified). Otherwise the badge — set only when a profile
      // is opened — would keep showing red after a successful replace and look like it failed.
      await window.vgc.updateProfile(prof.id, {
        proxyCheck: {
          status: 'ok',
          ip: picked.lastIp,
          country: picked.lastCountry,
          countryCode: picked.lastCountryCode,
          latencyMs: picked.latencyMs,
          at: new Date().toISOString()
        }
      })
      replaced.push(`${prof.name} → ${picked.lastIp || picked.host}`)
    }

    setDeadProfiles([])
    await refresh()
    let m = `✓ Đã thay ${replaced.length}/${deadList.length} profile.`
    if (replaced.length)
      m +=
        '\n• ' +
        replaced.slice(0, 30).join('\n• ') +
        (replaced.length > 30 ? `\n…và ${replaced.length - 30} nữa` : '')
    if (unresolved.length)
      m += `\n⚠️ ${unresolved.length} chưa thay được (hết proxy rảnh cùng nước/loại): ${unresolved
        .slice(0, 15)
        .join(', ')}${unresolved.length > 15 ? '…' : ''}`
    setMsg(m)
  }

  // Replace the proxies found DEAD by the live scan (deadProfiles).
  const replaceDeadAll = async (): Promise<void> => {
    if (!deadProfiles.length) {
      setMsg('Chưa có profile chết — bấm "🔎 Check proxy tất cả profile" trước.')
      return
    }
    if (
      !window.confirm(
        `Đổi proxy mới cho ${deadProfiles.length} profile có proxy CHẾT (proxy rảnh cùng nước + cùng loại)? ` +
          `Tài khoản PayPal/Stripe sẽ đổi IP.`
      )
    )
      return
    await doReplaceProfiles(deadProfiles)
  }

  // ONE-CLICK: replace the proxy on EVERY profile currently flagged "proxy lỗi" (the list's
  // badge = profile.proxyCheck.status==='error'), no separate scan needed. Use this after you've
  // deleted the dead proxies + added new ones and just want to reassign the whole batch fast.
  const replaceAllErrorProfiles = async (): Promise<void> => {
    const errored = profiles.filter(
      (p) => p.proxyCheck?.status === 'error' && p.proxy && p.proxy.type !== 'none' && p.proxy.host
    )
    if (!errored.length) {
      setMsg('Không có profile nào đang báo "proxy lỗi".')
      return
    }
    if (
      !window.confirm(
        `Thay proxy MỚI cho ${errored.length} profile đang báo proxy lỗi (dùng proxy rảnh trong kho, ` +
          `cùng loại + cùng nước)? Tài khoản PayPal/Stripe sẽ đổi IP.`
      )
    )
      return
    await doReplaceProfiles(errored)
  }

  // Delete a proxy both locally AND in the cloud (tombstone) so it doesn't come
  // back on "Làm mới" or on the account's other machines.
  const delOne = async (id: string): Promise<void> => {
    await window.vgc.deleteProxy(id)
    try {
      await deleteCloudProxy(id)
    } catch (e) {
      console.error('[cloud-delete-proxy]', e)
    }
  }
  const del = async (id: string): Promise<void> => {
    await delOne(id)
    await refresh()
  }
  const rename = async (p: SavedProxy, label: string): Promise<void> => {
    const l = label.trim()
    if (!l || l === p.label) return
    await window.vgc.saveProxy({ ...p, label: l })
    await refresh()
  }
  const delSelected = async (): Promise<void> => {
    for (const id of checked) await delOne(id)
    setChecked(new Set())
    await refresh()
  }
  const delErrors = async (): Promise<void> => {
    for (const p of proxies.filter((p) => p.lastStatus === 'error')) await delOne(p.id)
    await refresh()
  }
  const dedupe = async (): Promise<void> => {
    const seen = new Set<string>()
    for (const p of proxies) {
      // Include the password: iProyal rotating/sticky proxies share host/port/username
      // and differ ONLY by the password (session = exit IP), so omitting it would delete
      // valid distinct-IP proxies as "duplicates".
      const key = `${p.type}://${p.host}:${p.port}:${p.username ?? ''}:${p.password ?? ''}`
      if (seen.has(key)) await delOne(p.id)
      else seen.add(key)
    }
    await refresh()
  }

  const importPaste = async (): Promise<void> => {
    const items: SavedProxy[] = paste
      .split('\n')
      .map((l) => parseLine(l, importType))
      .filter((x): x is Omit<SavedProxy, 'id' | 'label'> => !!x && !!x.host && !!x.port)
      .map((x, idx) => ({
        ...x,
        id: genId(),
        label: importName.trim() ? `${importName.trim()} ${idx + 1}` : `${x.host}:${x.port}`
      }))
    if (items.length) {
      await window.vgc.saveManyProxies(items)
      setPaste('')
      setMsg(`Đã thêm ${items.length} proxy vào pool.`)
      await refresh()
    } else {
      setMsg('Không đọc được dòng proxy nào.')
    }
  }

  const used = proxies.filter((p) => p.assignedTo).length
  // Profiles the list currently flags "proxy lỗi" (badge = proxyCheck.status==='error').
  const erroredCount = profiles.filter((p) => p.proxyCheck?.status === 'error').length

  const inp = (w: number): CSSProperties => ({
    width: w,
    padding: '8px 10px',
    background: 'var(--panel-2)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    color: 'var(--text)',
    outline: 'none'
  })
  const lbl: CSSProperties = { fontSize: 12, color: 'var(--dim)' }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 1000, maxWidth: '96vw' }}>
        <header className="modal-head">
          <h2>📡 Pool Proxy IP</h2>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <section className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>⚡ Lấy proxy qua API</h3>
              <select
                className="group-select"
                value={genProvider}
                onChange={(e) => {
                  const prov = e.target.value as ProxyProviderId
                  setGenProvider(prov)
                  setBalance(null)
                  if (prov === 'evomi') {
                    // Evomi caps sticky at 24h — clamp an iProyal-only value (e.g. 7 ngày).
                    if (!EVOMI_LIFETIMES.some(([v]) => v === genLifetime)) setGenLifetime('24h')
                  } else if (prov === 'cliproxy') {
                    setGenHard(false) // "hard" session is Evomi-only
                    // Cliproxy caps sticky at 120 phút — clamp any longer value.
                    if (!CLIPROXY_LIFETIMES.some(([v]) => v === genLifetime)) setGenLifetime('')
                  } else {
                    setGenHard(false) // "hard" session is Evomi-only
                  }
                }}
                title="Chọn nhà cung cấp proxy"
              >
                {PROVIDERS.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              {genProvider !== 'cliproxy' && (
                <>
                  <button className="btn" onClick={() => void checkBalance()} disabled={loadingBal}>
                    {loadingBal ? '⏳ Đang kiểm tra…' : '📊 Xem GB còn lại'}
                  </button>
                  {balance && (
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      Còn <b>{balance.availableGb.toFixed(2)} GB</b>
                      {genProvider === 'iproyal' ? ` · ${balance.subusers} sub-user` : ''}
                    </span>
                  )}
                </>
              )}
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              {genProvider === 'evomi' ? (
                <>
                  API key Evomi nhập ở <b>Cài đặt → Nhà cung cấp Proxy</b>. Chọn sản phẩm + thông số
                  rồi bấm <b>Tạo proxy</b>.
                </>
              ) : genProvider === 'cliproxy' ? (
                <>
                  Tài khoản Cliproxy (host + port + username/password) nhập ở{' '}
                  <b>Cài đặt → Nhà cung cấp Proxy</b>. Mỗi proxy tạo ra là 1 IP sticky riêng (tối đa
                  120 phút). Chọn thông số rồi bấm <b>Tạo proxy</b>.
                </>
              ) : (
                <>
                  Tài khoản iProyal (API token + username/password) nhập ở{' '}
                  <b>Cài đặt → Nhà cung cấp Proxy</b>. Ở đây chỉ cần chọn thông số rồi bấm{' '}
                  <b>Tạo proxy</b>.
                </>
              )}
            </p>
            <div
              className="proxy-check"
              style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}
            >
              {genProvider === 'evomi' && (
                <>
                  <span style={lbl}>Sản phẩm</span>
                  <select
                    className="group-select"
                    value={genProduct}
                    onChange={(e) => setGenProduct(e.target.value)}
                  >
                    {EVOMI_PRODUCTS.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <span style={lbl}>Quốc gia</span>
              <select
                className="group-select"
                value={genCountry}
                onChange={(e) => setGenCountry(e.target.value)}
              >
                {IP_COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
              <span style={lbl}>Giao thức</span>
              <select
                className="group-select"
                value={genProtocol}
                onChange={(e) => setGenProtocol(e.target.value as 'http' | 'socks5')}
              >
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
              <span style={lbl}>Phiên</span>
              <select
                className="group-select"
                value={genHard ? 'hard' : genSticky ? 'sticky' : 'rotating'}
                onChange={(e) => {
                  const v = e.target.value
                  setGenSticky(v !== 'rotating')
                  setGenHard(v === 'hard')
                }}
              >
                <option value="rotating">Xoay (đổi IP mỗi lần)</option>
                <option value="sticky">Sticky (giữ IP theo thời gian)</option>
                {genProvider === 'evomi' && (
                  <option value="hard">Giữ lâu nhất (đến khi IP rớt)</option>
                )}
              </select>
              {genSticky && !genHard && (
                <>
                  <span style={lbl}>Giữ IP</span>
                  <select
                    className="group-select"
                    value={genLifetime}
                    onChange={(e) => setGenLifetime(e.target.value)}
                  >
                    {(genProvider === 'evomi'
                      ? EVOMI_LIFETIMES
                      : genProvider === 'cliproxy'
                        ? CLIPROXY_LIFETIMES
                        : IP_LIFETIMES
                    ).map(([val, name]) => (
                      <option key={val} value={val}>
                        {name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {genProvider === 'evomi' && genHard && (
                <span style={{ ...lbl, color: 'var(--green)' }}>
                  giữ IP đến khi rớt (lâu nhất)
                </span>
              )}
              <span style={lbl}>Số lượng</span>
              <input
                type="number"
                min={1}
                max={100}
                value={genCount}
                onChange={(e) => setGenCount(Number(e.target.value) || 1)}
                style={inp(70)}
              />
              <input
                placeholder="Tên (tuỳ chọn)"
                value={genLabel}
                onChange={(e) => setGenLabel(e.target.value)}
                style={inp(140)}
              />
              <button className="btn primary" disabled={generating} onClick={() => void generate()}>
                {generating ? 'Đang tạo…' : '⚡ Tạo proxy'}
              </button>
            </div>
            <p className="hint">
              Proxy tạo ra được thêm thẳng vào pool bên dưới — bấm <b>Kiểm tra</b> để xác nhận sống,
              rồi <b>Gán cho profile</b>.
            </p>
          </section>

          <section className="card">
            <h3>Dán / Import proxy</h3>
            <textarea
              rows={3}
              placeholder={'Mỗi dòng 1 proxy (nhiều định dạng đều nhận):\nhost:port@user:pass\nuser:pass@host:port\nhost:port:user:pass\nsocks5://user:pass@host:port'}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              style={{ width: '100%' }}
            />
            <div className="proxy-check" style={{ alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <input
                placeholder="Tên proxy (tuỳ chọn)"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                style={{
                  width: 200,
                  padding: '8px 10px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 7,
                  color: 'var(--text)',
                  outline: 'none'
                }}
              />
              <span style={{ fontSize: 12, color: 'var(--dim)' }}>Loại</span>
              <select
                className="group-select"
                value={importType}
                onChange={(e) => setImportType(e.target.value as ProxyType)}
              >
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>
              <button className="btn primary" onClick={importPaste}>
                ↧ Import vào pool
              </button>
            </div>
            <p className="hint">
              Đặt <b>Tên proxy</b> để các proxy import được đánh tên (Tên 1, Tên 2…) cho dễ quản lý — bỏ trống thì lấy
              host:port. Loại áp cho dòng không ghi scheme; dòng có <code>socks5://…</code>/<code>:SOCKS5</code> tự nhận đúng loại.
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                Pool ({proxies.length}) · đang dùng: {used} · trống: {proxies.length - used}
              </h3>
            </div>
            <div className="proxy-check" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
              <button className="btn primary" onClick={() => void checkMany(proxies)}>✓ Check tất cả</button>
              <button className="btn" onClick={() => void checkMany(proxies.filter((p) => checked.has(p.id)))}>✓ Check đã chọn</button>
              <button
                className="btn"
                title="Đồng bộ: cập nhật proxy nào đang dùng cho profile nào"
                onClick={() => void refresh().then(() => setMsg('✓ Đã đồng bộ proxy với profile.'))}
              >
                🔄 Đồng bộ profile
              </button>
              {erroredCount > 0 && (
                <button
                  className="btn primary"
                  title="Thay proxy mới cho MỌI profile đang báo 'proxy lỗi' — không cần check lại"
                  onClick={() => void replaceAllErrorProfiles()}
                >
                  🔧 Thay proxy {erroredCount} profile lỗi
                </button>
              )}
              <button
                className="btn"
                title="Kiểm tra LẠI proxy của TẤT CẢ profile (chậm hơn), liệt kê profile nào proxy chết"
                onClick={() => void scanDeadProfiles()}
                disabled={scanning}
              >
                {scanning ? '⏳ Đang check…' : '🔎 Check lại proxy tất cả'}
              </button>
              {deadProfiles.length > 0 && (
                <button
                  className="btn primary"
                  title="Đổi hết proxy chết sang proxy rảnh cùng nước, cùng loại còn sống"
                  onClick={() => void replaceDeadAll()}
                >
                  🔧 Thay mới đồng loạt ({deadProfiles.length})
                </button>
              )}
              <button className="btn" onClick={delErrors}>🧹 Xoá proxy lỗi</button>
              <button className="btn" onClick={dedupe}>⎘ Xoá trùng lặp</button>
              <button className="btn danger" onClick={delSelected}>🗑 Xoá đã chọn</button>
              <button className="btn" onClick={tickAll}>Tích tất cả</button>
              <button className="btn ghost" onClick={untick}>Bỏ tích</button>
            </div>

            {proxies.length === 0 ? (
              <p className="hint">Pool trống. Tạo từ nhà cung cấp hoặc import ở trên.</p>
            ) : (
              <div style={{ overflow: 'auto' }}>
                <table className="profiles pool">
                  <colgroup>
                    <col style={{ width: 34 }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '6%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '19%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: 56 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="check-col"></th>
                      <th>Tên</th>
                      <th>Host</th>
                      <th>Port</th>
                      <th>User</th>
                      <th>Loại</th>
                      <th>Trạng thái</th>
                      <th>IP · Country · Latency</th>
                      <th>Gán cho profile</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {proxies.map((p) => (
                      <tr key={p.id}>
                        <td className="check-col">
                          <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
                        </td>
                        <td>
                          <input
                            key={p.id}
                            defaultValue={p.label}
                            title="Sửa tên proxy (rời ô để lưu)"
                            onBlur={(e) => void rename(p, e.target.value)}
                            style={{
                              width: '100%',
                              background: 'var(--panel-2)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              color: 'var(--text)',
                              padding: '5px 7px',
                              fontSize: 12,
                              outline: 'none'
                            }}
                          />
                        </td>
                        <td className="mono small">{p.host}</td>
                        <td className="mono small">{p.port}</td>
                        <td className="mono small">{p.username || '—'}</td>
                        <td className="mono small">{p.type}</td>
                        <td className="small">
                          {p.assignedTo ? (
                            <span style={{ color: 'var(--accent)' }}>● {profileName(p.assignedTo)}</span>
                          ) : (
                            <span className="dim">Trống</span>
                          )}
                        </td>
                        <td className="mono small">
                          {checking.has(p.id) ? (
                            'đang check…'
                          ) : p.lastStatus === 'ok' ? (
                            <span style={{ color: 'var(--green)' }}>
                              {p.lastIp} · {(p.lastCountryCode || '').toUpperCase()} {p.lastCountry} · {p.latencyMs}ms
                            </span>
                          ) : p.lastStatus === 'error' ? (
                            <span style={{ color: 'var(--red)' }}>✗ lỗi</span>
                          ) : (
                            <button className="btn" onClick={() => void checkOne(p)}>Kiểm tra</button>
                          )}
                        </td>
                        <td>
                          <select
                            className="group-select"
                            value={p.assignedTo ?? ''}
                            onChange={(e) => void assign(p, e.target.value)}
                          >
                            <option value="">— Trống (bỏ gán)</option>
                            {profiles.map((pr) => (
                              <option key={pr.id} value={pr.id}>
                                {pr.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button className="btn danger" onClick={() => void del(p.id)}>
                            Xoá
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {msg && (
              <p
                className="hint"
                style={{
                  color: msg.startsWith('Lỗi') ? 'var(--red)' : 'var(--green)',
                  whiteSpace: 'pre-line'
                }}
              >
                {msg}
              </p>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Đóng
          </button>
        </footer>
      </div>
    </div>
  )
}
