import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Sidebar } from './components/Sidebar'
import { applyTheme, getTheme, type Theme } from './theme'
import { getCloud } from './cloud'

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
  const [showSettings, setShowSettings] = useState(false)
  const [showCloud, setShowCloud] = useState(false)
  const [showProxyMgr, setShowProxyMgr] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [theme, setTheme] = useState<Theme>(getTheme())
  const [engineProg, setEngineProg] = useState<EngineProgress | null>(null)
  const [dataSync, setDataSync] = useState<DataSyncState | null>(null)
  const [updateReady, setUpdateReady] = useState<UpdateStatus | null>(null)
  const [accountEmail, setAccountEmail] = useState<string>('')

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

  // When a new version finishes downloading, surface a restart-to-update banner.
  useEffect(() => {
    void window.vgc.getUpdateStatus().then((s) => {
      if (s.phase === 'downloaded') setUpdateReady(s)
    })
    return window.vgc.onUpdateStatus((s) => {
      if (s.phase === 'downloaded') setUpdateReady(s)
    })
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

  const run = useCallback(async (id: string) => {
    try {
      await window.vgc.launchProfile(id)
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
    await window.vgc.launchMany([...selected])
  }, [selected])
  const bulkStop = useCallback(async () => {
    await window.vgc.stopMany([...selected])
  }, [selected])
  const bulkDelete = useCallback(async () => {
    if (!window.confirm(`Xoá ${selected.size} profile đã chọn?`)) return
    for (const id of selected) await window.vgc.deleteProfile(id)
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
          <span>
            🎉 Đã tải bản mới
            {updateReady.newVersion ? ` v${updateReady.newVersion}` : ''} — khởi động lại để cập nhật.
          </span>
          <button className="btn primary" onClick={() => void window.vgc.installUpdate()}>
            ⟳ Khởi động lại ngay
          </button>
          <button className="btn ghost" onClick={() => setUpdateReady(null)}>
            Để sau
          </button>
        </div>
      )}
      <Sidebar
        groups={groupsWithCounts}
        allCount={profiles.length}
        active={groupFilter}
        onSelect={setGroupFilter}
        onProxy={() => setShowProxyMgr(true)}
        onSettings={() => setShowSettings(true)}
        onCreateGroup={createGroup}
        onDeleteGroup={deleteGroup}
      />

      <div className="main">
        <div className="toolbar">
          <input
            className="search"
            placeholder="Tìm theo tên, tag, nhóm…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="stats">
            <span className="running-dot" /> {runningCount} chạy
            <span className="dot">·</span> {profiles.length} profile
          </div>
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
              onEdit={setEditing}
              onDuplicate={duplicate}
              onDelete={remove}
              onMoveGroup={moveGroup}
            />
          )}
        </main>
      </div>

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
            <div className="engine-logo">◆</div>
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
