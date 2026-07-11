import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataSyncState,
  EngineProgress,
  Profile,
  ProfileStatus,
  SavedProxy,
  UpdateStatus
} from '../shared/types'
import { ProfileTable } from './components/ProfileTable'
import { EditProfileModal } from './components/EditProfileModal'
import { CreateProfileModal } from './components/CreateProfileModal'
import { SettingsModal } from './components/SettingsModal'
import { CloudModal } from './components/CloudModal'
import { ProxyManagerModal } from './components/ProxyManagerModal'
import { ShareModal } from './components/ShareModal'
import { Sidebar } from './components/Sidebar'
import { applyTheme, getTheme, type Theme } from './theme'
import logo from './assets/logo.png'
import {
  getCloud,
  pullCloudProfileList,
  pushCloudProfileList,
  pullCloudProxies,
  pushCloudProxies,
  deleteCloudProfile,
  applyCloudTombstones
} from './cloud'

export default function App(): JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [statuses, setStatuses] = useState<Record<string, ProfileStatus>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState('') // '' all, '#ungrouped', else group
  const [groups, setGroups] = useState<string[]>([]) // persisted group names (per account)
  const [proxyPool, setProxyPool] = useState<SavedProxy[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Profile | null>(null)
  const [sharing, setSharing] = useState<Profile | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showCloud, setShowCloud] = useState(false)
  const [showProxyMgr, setShowProxyMgr] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [theme, setTheme] = useState<Theme>(getTheme())
  const [engineProg, setEngineProg] = useState<EngineProgress | null>(null)
  const [dataSync, setDataSync] = useState<DataSyncState | null>(null)
  const [updateReady, setUpdateReady] = useState<UpdateStatus | null>(null)
  const [accountEmail, setAccountEmail] = useState<string>('')
  const [refreshing, setRefreshing] = useState(false)

  // Show the signed-in account in the sidebar.
  useEffect(() => {
    void (async () => {
      const c = await getCloud()
      if (!c) return
      const { data } = await c.auth.getUser()
      setAccountEmail(data.user?.email ?? '')
    })()
  }, [])

  // Sign out → Gate's auth listener swaps back to the login screen (= switch account).
  const signOut = useCallback(async () => {
    const c = await getCloud()
    await c?.auth.signOut()
    await window.vgc.cloudSetSession(null)
  }, [])

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    return window.vgc.onEngineProgress((p) => {
      setEngineProg(p)
      if (p.phase === 'done' || p.phase === 'error') {
        setTimeout(() => setEngineProg(null), 2500)
      }
    })
  }, [])

  // Surface an update banner: Windows shows it once the new version finished
  // downloading (restart to install); macOS can't auto-install an unsigned build,
  // so it shows as soon as a newer version is available, with a manual download link.
  useEffect(() => {
    const show = (s: UpdateStatus): void => {
      if (s.phase === 'downloaded' || (s.phase === 'available' && s.manualDownloadUrl)) {
        setUpdateReady(s)
      }
    }
    void window.vgc.getUpdateStatus().then(show)
    return window.vgc.onUpdateStatus(show)
  }, [])

  // Toast for cloud profile-data sync (download on open / upload on close).
  useEffect(() => {
    return window.vgc.onDataSync((s) => {
      setDataSync(s)
      if (s.phase === 'done' || s.phase === 'error') {
        setTimeout(() => setDataSync(null), 2500)
      }
    })
  }, [])

  const refresh = useCallback(async () => {
    const [list, rs, gs, px] = await Promise.all([
      window.vgc.listProfiles(),
      window.vgc.runtimeStates(),
      window.vgc.listGroups(),
      window.vgc.listProxies()
    ])
    setProfiles(list)
    setGroups(gs)
    setProxyPool(px)
    setStatuses(Object.fromEntries(rs.map((s) => [s.id, s.status])))
    setSelected((prev) => {
      const ids = new Set(list.map((p) => p.id))
      return new Set([...prev].filter((id) => ids.has(id)))
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.vgc.onStatus((s) => {
      setStatuses((prev) => ({ ...prev, [s.id]: s.status }))
      if (s.error) console.error('[profile]', s.id, s.error)
    })
    return off
  }, [refresh])

  // ── Cloud auto-sync (GoLogin-style) ──────────────────────────────────────────
  // Set when an auto-pull just rewrote a local list, so the matching auto-push
  // effect below skips the echo it would otherwise fire for cloud-originated data.
  const justPulledRef = useRef(false)
  const justPulledProxiesRef = useRef(false)
  // True while a local change is waiting to be pushed — the periodic auto-pull skips
  // those windows so it can't overwrite an edit that hasn't reached the cloud yet.
  const pendingPushRef = useRef(false)
  const pullingRef = useRef(false)

  // Auto-PULL: App only mounts once signed in (see Gate), so this runs right after
  // login — fetch the account's profiles AND proxy pool from the cloud so a fresh
  // machine shows everything without a manual "Kéo về". Profile session data still
  // loads lazily on open.
  useEffect(() => {
    void (async () => {
      // allSettled so a proxy-sync hiccup (e.g. proxies_cloud table not created yet)
      // never blocks the profile pull, and vice-versa.
      const [pr, px] = await Promise.allSettled([pullCloudProfileList(), pullCloudProxies()])
      const nProfiles = pr.status === 'fulfilled' ? pr.value : 0
      const nProxies = px.status === 'fulfilled' ? px.value : 0
      if (nProfiles > 0 || nProxies > 0) {
        // Guard ONLY the list that was actually pulled, so e.g. pulling profiles
        // (but 0 proxies) doesn't suppress the first push of local-only proxies.
        if (nProfiles > 0) justPulledRef.current = true
        if (nProxies > 0) justPulledProxiesRef.current = true
        await refresh()
        const parts: string[] = []
        if (nProfiles > 0) parts.push(`${nProfiles} profile`)
        if (nProxies > 0) parts.push(`${nProxies} proxy`)
        setDataSync({ id: '*', phase: 'download', message: `✓ Đã tải ${parts.join(' + ')} từ cloud` })
        setTimeout(() => setDataSync(null), 2500)
      }
      if (px.status === 'rejected') console.warn('[auto-pull:proxies]', px.reason)
      // Only surface the profile pull failure (the critical path) to the user.
      if (pr.status === 'rejected') {
        setDataSync({
          id: '*',
          phase: 'error',
          message:
            'Lỗi tải profile từ cloud: ' +
            (pr.reason instanceof Error ? pr.reason.message : String(pr.reason))
        })
        setTimeout(() => setDataSync(null), 4000)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-PUSH profiles: whenever the local profile list changes (create/edit/delete),
  // upsert the metadata to the cloud — debounced — so other machines see it without a
  // manual push. Skipped during the initial load and right after an auto-pull.
  useEffect(() => {
    if (loading) return
    if (justPulledRef.current) {
      justPulledRef.current = false
      return
    }
    pendingPushRef.current = true // a local edit is in flight — pause the auto-pull
    const t = setTimeout(() => {
      void pushCloudProfileList()
        .catch((e) => console.error('[auto-push]', e))
        .finally(() => {
          pendingPushRef.current = false
        })
    }, 2500)
    return () => clearTimeout(t)
  }, [profiles, loading])

  // Auto-PUSH proxies: same idea for the Proxy Manager pool — adding/editing a proxy
  // (the pool reloads when the modal closes) syncs it to the account's cloud.
  useEffect(() => {
    if (loading) return
    if (justPulledProxiesRef.current) {
      justPulledProxiesRef.current = false
      return
    }
    const t = setTimeout(() => {
      void pushCloudProxies().catch((e) => console.error('[auto-push:proxies]', e))
    }, 2500)
    return () => clearTimeout(t)
  }, [proxyPool, loading])

  // Safety net: re-push on a slow interval in case a change-triggered push was
  // missed or failed transiently. Metadata-only, so it's cheap.
  useEffect(() => {
    const id = setInterval(() => {
      void pushCloudProfileList().catch((e) => console.error('[auto-push:interval]', e))
      void pushCloudProxies().catch((e) => console.error('[auto-push:proxies:interval]', e))
    }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // Auto-PULL on a short interval (the "auto-F5"): re-pull the cloud list so a profile
  // ADDED, EDITED, or DELETED (tombstoned) on another machine shows up here within
  // seconds — no manual "Làm mới" / restart needed. Skipped while a local push is in
  // flight so it can't clobber an unpushed edit; only refreshes the UI when the local
  // list actually changed (by id + updatedAt), so there's no constant re-render.
  useEffect(() => {
    const sig = (list: Profile[]): string =>
      list.map((p) => `${p.id}:${p.updatedAt}`).sort().join('|')
    const id = setInterval(() => {
      if (loading || pullingRef.current) return // a previous pull is still running
      void (async () => {
        pullingRef.current = true
        try {
          // While a local edit-push is in flight we must NOT pull+overwrite live data
          // (it could clobber the unpushed edit). But DELETIONS must still apply, or a
          // profile deleted on another machine lingers forever on a machine that's
          // continuously editing. Apply tombstones only; skip the full pull this tick.
          if (pendingPushRef.current) {
            const removed = await applyCloudTombstones()
            if (removed > 0) {
              justPulledRef.current = true
              await refresh()
            }
            return
          }
          const before = sig(await window.vgc.listProfiles())
          const n = await pullCloudProfileList()
          if (n < 0) return // not signed in / cloud not configured
          const after = sig(await window.vgc.listProfiles())
          if (after !== before) {
            justPulledRef.current = true // the resulting state change isn't a local edit
            await refresh()
          }
        } catch (e) {
          console.error('[auto-sync:pull]', e)
        } finally {
          pullingRef.current = false
        }
      })()
    }, 12 * 1000)
    return () => clearInterval(id)
  }, [loading, refresh])

  const createGroup = useCallback(
    async (name: string) => {
      const n = name.trim()
      if (!n) return
      await window.vgc.createGroup(n)
      await refresh()
    },
    [refresh]
  )

  const deleteGroup = useCallback(
    async (name: string) => {
      if (!window.confirm(`Xoá nhóm "${name}"? Profile trong nhóm sẽ về "Tất cả".`)) return
      // Un-group its profiles, then delete the group.
      for (const p of profiles.filter((p) => p.group === name)) {
        await window.vgc.updateProfile(p.id, { group: '' })
      }
      await window.vgc.deleteGroup(name)
      if (groupFilter === name) setGroupFilter('')
      await refresh()
    },
    [profiles, groupFilter, refresh]
  )

  const moveGroup = useCallback(
    async (id: string, group: string) => {
      await window.vgc.updateProfile(id, { group })
      await refresh()
    },
    [refresh]
  )

  // Auto-check each given profile's proxy and store the result ON THE PROFILE
  // (proxyCheck), so the list shows a fresh IP/country/✓ right after opening — works
  // for inline proxies too, not just pool ones. Checks run in parallel; the writes
  // are applied sequentially (updateProfile is a per-id merge) to avoid racing the
  // profile store. Best-effort: failures just mark the proxy as errored.
  const autoCheckProxies = useCallback(
    async (ids: string[]) => {
      const targets = ids
        .map((id) => profiles.find((x) => x.id === id))
        .filter((p): p is Profile => !!p && p.proxy.type !== 'none' && !!p.proxy.host)
      if (targets.length === 0) return
      const results = await Promise.all(
        targets.map(async (p): Promise<{ id: string; check: NonNullable<Profile['proxyCheck']> }> => {
          const at = new Date().toISOString()
          try {
            const res = await window.vgc.checkProxy(p.proxy)
            return {
              id: p.id,
              check: {
                status: res.ok ? 'ok' : 'error',
                ip: res.ip,
                country: res.country,
                countryCode: res.countryCode,
                latencyMs: res.latencyMs,
                at
              }
            }
          } catch {
            return { id: p.id, check: { status: 'error', at } }
          }
        })
      )
      for (const r of results) {
        await window.vgc.updateProfile(r.id, { proxyCheck: r.check }).catch(() => {})
      }
      await refresh()
    },
    [profiles, refresh]
  )

  const run = useCallback(
    async (id: string) => {
      try {
        await window.vgc.launchProfile(id)
      } catch (e) {
        window.alert(e instanceof Error ? e.message : String(e))
        return
      }
      // Don't block the browser opening — check the proxy in the background.
      void autoCheckProxies([id])
    },
    [autoCheckProxies]
  )
  const loginClean = useCallback(async (id: string) => {
    try {
      await window.vgc.loginClean(id)
      window.alert(
        'Đã mở chế độ ĐĂNG NHẬP SẠCH (Chrome thật, không chống phát hiện).\n\n' +
          '1. Đăng nhập Gmail/Google trong cửa sổ vừa mở.\n' +
          '2. Đăng nhập xong thì ĐÓNG cửa sổ.\n' +
          '3. Mở profile bình thường (nút Mở) — sẽ đã đăng nhập sẵn, không bị chặn.'
      )
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [])
  const stop = useCallback(async (id: string) => {
    await window.vgc.stopProfile(id)
  }, [])
  const check = useCallback(async (id: string) => {
    try {
      await window.vgc.checkFingerprint(id)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [])
  const duplicate = useCallback(
    async (id: string) => {
      await window.vgc.duplicateProfile(id)
      await refresh()
    },
    [refresh]
  )
  const remove = useCallback(
    async (id: string) => {
      if (!window.confirm('Xoá profile này?')) return
      await window.vgc.deleteProfile(id)
      // Also tombstone in the cloud so it doesn't come back on "Làm mới" / other machines.
      try {
        await deleteCloudProfile(id)
      } catch (e) {
        console.error('[cloud-delete]', e)
      }
      await refresh()
    },
    [refresh]
  )

  // ── groups for sidebar ──
  const groupsWithCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const g of groups) m.set(g, 0) // persisted groups show even when empty
    for (const p of profiles) if (p.group) m.set(p.group, (m.get(p.group) ?? 0) + 1)
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name))
  }, [profiles, groups])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return profiles.filter((p) => {
      if (groupFilter === '#ungrouped' && p.group) return false
      if (groupFilter && groupFilter !== '#ungrouped' && p.group !== groupFilter) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.tags.some((t) => t.toLowerCase().includes(q)) ||
        (p.group ?? '').toLowerCase().includes(q)
      )
    })
  }, [profiles, query, groupFilter])

  // ── selection ──
  const allSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev)
      const every = filtered.every((p) => next.has(p.id))
      if (every) filtered.forEach((p) => next.delete(p.id))
      else filtered.forEach((p) => next.add(p.id))
      return next
    })
  }, [filtered])

  // ── bulk + import/export ──
  const bulkRun = useCallback(async () => {
    const ids = [...selected]
    await window.vgc.launchMany(ids)
    void autoCheckProxies(ids)
  }, [selected, autoCheckProxies])
  const bulkStop = useCallback(async () => {
    await window.vgc.stopMany([...selected])
  }, [selected])
  const bulkDelete = useCallback(async () => {
    if (!window.confirm(`Xoá ${selected.size} profile đã chọn?`)) return
    for (const id of selected) {
      await window.vgc.deleteProfile(id)
      // Tombstone each in the cloud so the deletion sticks across machines + "Làm mới".
      try {
        await deleteCloudProfile(id)
      } catch (e) {
        console.error('[cloud-delete]', e)
      }
    }
    setSelected(new Set())
    await refresh()
  }, [selected, refresh])
  const exportSelected = useCallback(async () => {
    const res = await window.vgc.exportProfiles([...selected])
    if (res.count) window.alert(`Đã xuất ${res.count} profile.`)
  }, [selected])
  const exportAll = useCallback(async () => {
    const res = await window.vgc.exportProfiles()
    if (res.count) window.alert(`Đã xuất ${res.count} profile.`)
  }, [])
  const importProfiles = useCallback(async () => {
    const res = await window.vgc.importProfiles()
    if (res.count) {
      window.alert(`Đã nhập ${res.count} profile.`)
      await refresh()
    }
  }, [refresh])

  // "Làm mới" (F5): re-pull the latest profiles + proxies from the cloud so switching
  // between machines shows the newest state. Data is already saved to the cloud on
  // close (sync-on-close), so this is the matching "read the latest" action.
  const syncNow = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    setDataSync({ id: '*', phase: 'download', message: '↻ Đang làm mới từ cloud…' })
    try {
      const [pr, px] = await Promise.allSettled([pullCloudProfileList(), pullCloudProxies()])
      const nP = pr.status === 'fulfilled' && pr.value > 0 ? pr.value : 0
      const nX = px.status === 'fulfilled' && px.value > 0 ? px.value : 0
      if (nP > 0) justPulledRef.current = true
      if (nX > 0) justPulledProxiesRef.current = true
      await refresh()
      const parts: string[] = []
      if (nP > 0) parts.push(`${nP} profile`)
      if (nX > 0) parts.push(`${nX} proxy`)
      setDataSync({
        id: '*',
        phase: 'done',
        message: parts.length ? `✓ Đã làm mới: ${parts.join(' + ')}` : '✓ Đã là bản mới nhất'
      })
    } catch (e) {
      setDataSync({
        id: '*',
        phase: 'error',
        message: 'Lỗi làm mới: ' + (e instanceof Error ? e.message : String(e))
      })
    } finally {
      setRefreshing(false)
      setTimeout(() => setDataSync(null), 2500)
    }
  }, [refreshing, refresh])

  const runningCount = Object.values(statuses).filter(
    (s) => s === 'running' || s === 'starting'
  ).length

  return (
    <div className="app">
      {updateReady && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            padding: '8px 16px',
            fontSize: 13,
            color: '#fff',
            background: 'linear-gradient(135deg,#15803d,#166534)',
            boxShadow: '0 4px 14px rgba(0,0,0,.3)'
          }}
        >
          {updateReady.manualDownloadUrl ? (
            <>
              <span>
                🎉 Có bản mới
                {updateReady.newVersion ? ` v${updateReady.newVersion}` : ''} — tải về để cập nhật (Mac).
              </span>
              <button className="btn primary" onClick={() => void window.vgc.openUpdateDownload()}>
                ⬇ Tải về
              </button>
            </>
          ) : (
            <>
              <span>
                🎉 Đã tải bản mới
                {updateReady.newVersion ? ` v${updateReady.newVersion}` : ''} — khởi động lại để cập nhật.
              </span>
              <button className="btn primary" onClick={() => void window.vgc.installUpdate()}>
                ⟳ Khởi động lại ngay
              </button>
            </>
          )}
          <button className="btn ghost" onClick={() => setUpdateReady(null)}>
            Để sau
          </button>
        </div>
      )}
      <Sidebar
        email={accountEmail}
        profileCount={profiles.length}
        groups={groupsWithCounts}
        allCount={profiles.length}
        active={groupFilter}
        onSelect={setGroupFilter}
        onCreate={() => setShowCreate(true)}
        onProxy={() => setShowProxyMgr(true)}
        onSettings={() => setShowSettings(true)}
        onCreateGroup={createGroup}
        onDeleteGroup={deleteGroup}
      />

      <div className="main">
        <div className="crumbbar">
          <div className="crumb">
            <span className="crumb-acct">{accountEmail || 'VGC'}</span>
            <span className="crumb-sep">›</span>
            <span className="crumb-cur">
              {groupFilter === ''
                ? 'Tất cả hồ sơ'
                : groupFilter === '#ungrouped'
                  ? 'Chưa phân nhóm'
                  : groupFilter}
            </span>
          </div>
          <div className="stats">
            <span className="running-dot" /> {runningCount} chạy
            <span className="dot">·</span> {profiles.length} hồ sơ
          </div>
        </div>
        <div className="toolbar">
          <div className="searchbox">
            <span className="search-ic">⌕</span>
            <input
              className="search"
              placeholder="Tìm theo tên, tag, nhóm…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className="btn"
            onClick={syncNow}
            disabled={refreshing}
            title="Kéo dữ liệu mới nhất từ cloud (đồng bộ giữa 2 máy)"
          >
            {refreshing ? '↻ Đang làm mới…' : '↻ Làm mới'}
          </button>
          <button className="btn" onClick={importProfiles}>
            ↧ Nhập
          </button>
          <button className="btn" onClick={exportAll}>
            ↥ Xuất
          </button>
          <button className="btn primary" onClick={() => setShowCreate(true)}>
            + Tạo profile
          </button>
        </div>

        {selected.size > 0 && (
          <div className="bulkbar">
            <span>{selected.size} đã chọn</span>
            <button className="btn" onClick={bulkRun}>
              Mở
            </button>
            <button className="btn" onClick={bulkStop}>
              Dừng
            </button>
            <button className="btn" onClick={exportSelected}>
              Xuất
            </button>
            <button className="btn danger" onClick={bulkDelete}>
              Xoá
            </button>
            <button className="btn ghost" onClick={() => setSelected(new Set())}>
              Bỏ chọn
            </button>
          </div>
        )}

        <main className="content">
          {loading ? (
            <div className="empty">Đang tải…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              {profiles.length === 0
                ? 'Chưa có profile nào. Bấm “Tạo profile” để bắt đầu.'
                : 'Không có profile khớp.'}
            </div>
          ) : (
            <ProfileTable
              profiles={filtered}
              statuses={statuses}
              proxyPool={proxyPool}
              groups={groupsWithCounts.map((g) => g.name)}
              selected={selected}
              allSelected={allSelected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              onRun={run}
              onStop={stop}
              onCheck={check}
              onCheckProxy={(id) => autoCheckProxies([id])}
              onLoginClean={loginClean}
              onEdit={setEditing}
              onDuplicate={duplicate}
              onShare={setSharing}
              onDelete={remove}
              onMoveGroup={moveGroup}
            />
          )}
        </main>
      </div>

      {sharing && (
        <ShareModal profile={sharing} proxies={proxyPool} onClose={() => setSharing(null)} />
      )}
      {editing && (
        <EditProfileModal profile={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      {showCreate && (
        <CreateProfileModal
          groups={groupsWithCounts.map((g) => g.name)}
          defaultGroup={groupFilter && groupFilter !== '#ungrouped' ? groupFilter : ''}
          defaultName={`Profile ${profiles.length + 1}`}
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          theme={theme}
          onSetTheme={setTheme}
          accountEmail={accountEmail}
          onSignOut={signOut}
          onOpenCloud={() => {
            setShowSettings(false)
            setShowCloud(true)
          }}
        />
      )}
      {showCloud && <CloudModal onClose={() => setShowCloud(false)} onSynced={refresh} />}
      {showProxyMgr && (
        <ProxyManagerModal
          onClose={() => {
            setShowProxyMgr(false)
            void refresh()
          }}
        />
      )}

      {engineProg && (
        <div className="engine-overlay">
          <div className="engine-card">
            <img className="engine-logo" src={logo} alt="VGC" style={{ width: 44, height: 44 }} />
            <h3>VGC Core Engine</h3>
            <p className="hint">{engineProg.message ?? 'Đang chuẩn bị…'}</p>
            <div className="progress">
              <div
                className={`bar ${engineProg.phase === 'extract' ? 'indeterminate' : ''}`}
                style={{
                  width:
                    typeof engineProg.percent === 'number' ? `${engineProg.percent}%` : '100%'
                }}
              />
            </div>
          </div>
        </div>
      )}

      {dataSync && (
        <div
          style={{
            position: 'fixed',
            right: 18,
            bottom: 18,
            zIndex: 9999,
            padding: '10px 16px',
            borderRadius: 10,
            fontSize: 13,
            color: '#fff',
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            background:
              dataSync.phase === 'error'
                ? 'linear-gradient(135deg,#b91c1c,#7f1d1d)'
                : dataSync.phase === 'done'
                  ? 'linear-gradient(135deg,#15803d,#166534)'
                  : 'linear-gradient(135deg,#6d28d9,#4f46e5)'
          }}
        >
          {dataSync.message ??
            (dataSync.phase === 'download'
              ? '↧ Đang tải dữ liệu profile…'
              : dataSync.phase === 'upload'
                ? '↥ Đang lưu phiên lên cloud…'
                : dataSync.phase === 'done'
                  ? '✓ Đã đồng bộ cloud'
                  : 'Đang đồng bộ…')}
        </div>
      )}
    </div>
  )
}
