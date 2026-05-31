import { useEffect, useMemo, useState } from 'react'
import type { HostInfo, PermissionMode, SessionListItem } from '../../../shared/protocol'
import { clearHistory, loadHistory, pushHistory, removeFromHistory } from '../state/history'
import { loadCwdHistory, pushCwdHistory, removeFromCwdHistory } from '../state/cwdHistory'

interface Props {
  open: boolean
  initialMode?: 'new' | 'resume'
  onClose: () => void
  onCreate: (input: {
    hostId: string
    name: string
    color: string
    cwd: string
    permissionMode: PermissionMode
    model?: string
    initialPrompt?: string
    resume?: string
  }) => void
}

const COLORS = [
  '#3b82f6', // blue
  '#0ea5e9', // sky
  '#06b6d4', // cyan
  '#14b8a6', // teal
  '#10b981', // emerald
  '#22c55e', // green
  '#84cc16', // lime
  '#eab308', // yellow
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#f43f5e', // rose
  '#ec4899', // pink
  '#d946ef', // fuchsia
  '#a855f7', // purple
  '#8b5cf6', // violet
  '#6366f1' // indigo
]
const randomColor = (): string => COLORS[Math.floor(Math.random() * COLORS.length)]
const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Default', hint: 'Prompt for tool use' },
  { value: 'acceptEdits', label: 'Accept Edits', hint: 'Auto-approve edits + safe ops' },
  { value: 'plan', label: 'Plan', hint: 'Read-only, plan first' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'No prompts (be careful)' }
]

const FIELDS_KEY = 'hb.lastFields.v1'
type Mode = 'new' | 'resume'

interface SavedFields {
  hostId?: string
  cwd?: string
  permissionMode?: PermissionMode
  // color intentionally not persisted — re-rolled randomly per session for variety.
}

function loadFields(): SavedFields {
  try {
    const raw = localStorage.getItem(FIELDS_KEY)
    return raw ? (JSON.parse(raw) as SavedFields) : {}
  } catch {
    return {}
  }
}
function saveFields(f: SavedFields): void {
  try {
    localStorage.setItem(FIELDS_KEY, JSON.stringify(f))
  } catch {
    // ignore
  }
}

function relativeTime(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return 'just now'
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

export default function NewTabModal({
  open,
  initialMode = 'new',
  onClose,
  onCreate
}: Props): React.JSX.Element | null {
  const [mode, setMode] = useState<Mode>('new')
  const [hosts, setHosts] = useState<HostInfo[]>([])
  const [hostId, setHostId] = useState<string>('windows')
  const [name, setName] = useState<string>('')
  const [color, setColor] = useState<string>(randomColor)
  const [cwd, setCwd] = useState<string>('')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [prompt, setPrompt] = useState<string>('')
  const [history, setHistory] = useState<string[]>([])
  const [historyOpen, setHistoryOpen] = useState<boolean>(false)
  const [cwdHistory, setCwdHistory] = useState<string[]>([])
  const [cwdHistoryOpen, setCwdHistoryOpen] = useState<boolean>(false)
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [filter, setFilter] = useState<string>('')

  useEffect(() => {
    if (!open) return
    const saved = loadFields()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form fields each time the modal opens
    setMode(initialMode)
    setName('')
    setPrompt('')
    setHistory(loadHistory())
    setHistoryOpen(false)
    setCwdHistory(loadCwdHistory())
    setCwdHistoryOpen(false)
    setFilter('')
    if (saved.hostId) setHostId(saved.hostId)
    if (saved.cwd) setCwd(saved.cwd)
    if (saved.permissionMode) setPermissionMode(saved.permissionMode)
    // Roll a fresh color each time the modal opens.
    setColor(randomColor())
  }, [open, initialMode])

  useEffect(() => {
    if (!open) return
    window.api.listHosts().then((hs) => {
      setHosts(hs)
      if (hs.length > 0 && !hs.find((h) => h.id === hostId)) setHostId(hs[0].id)
    })
  }, [open, hostId])

  // Lazy-load the session list the first time the user clicks Resume.
  useEffect(() => {
    if (!open || mode !== 'resume') return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- lazy-load session list on first Resume
    setSessionsLoading(true)
    window.api
      .listSessions({ limit: 100 })
      .then((items) => {
        items.sort((a, b) => b.lastModified - a.lastModified)
        setSessions(items)
      })
      .finally(() => setSessionsLoading(false))
  }, [open, mode])

  const filteredSessions = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => {
      const hay = [s.summary, s.customTitle, s.firstPrompt, s.cwd, s.gitBranch]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [sessions, filter])

  const deleteOne = async (s: SessionListItem): Promise<void> => {
    const label = s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8)
    if (!window.confirm(`Delete session "${label}"? This is permanent.`)) return
    const r = await window.api.deleteSession(s.sessionId, s.cwd)
    if (r.ok) {
      setSessions((cur) => cur.filter((x) => x.sessionId !== s.sessionId))
    } else {
      window.alert(`Failed to delete: ${r.error}`)
    }
  }

  const deleteAll = async (): Promise<void> => {
    const visible = filteredSessions
    if (visible.length === 0) return
    const noun = filter.trim()
      ? `${visible.length} matching session${visible.length > 1 ? 's' : ''}`
      : `all ${visible.length} session${visible.length > 1 ? 's' : ''}`
    if (!window.confirm(`Delete ${noun}? This is permanent.`)) return
    const ids = new Set<string>()
    let failed = 0
    for (const s of visible) {
      const r = await window.api.deleteSession(s.sessionId, s.cwd)
      if (r.ok) ids.add(s.sessionId)
      else failed++
    }
    setSessions((cur) => cur.filter((x) => !ids.has(x.sessionId)))
    if (failed > 0) {
      window.alert(`${failed} session${failed > 1 ? 's' : ''} could not be deleted.`)
    }
  }

  const submitNew = (): void => {
    if (mode !== 'new') return
    if (!cwd.trim() || !prompt.trim()) return
    pushHistory(prompt)
    pushCwdHistory(cwd.trim())
    saveFields({ hostId, cwd: cwd.trim(), permissionMode })
    onCreate({
      hostId,
      name: name.trim() || prompt.slice(0, 32),
      color,
      cwd: cwd.trim(),
      permissionMode,
      initialPrompt: prompt
    })
  }

  // Esc closes; Ctrl+Enter submits. Capture so input handlers can't swallow.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        e.stopPropagation()
        submitNew()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, mode, cwd, prompt, hostId, color, permissionMode, name])

  if (!open) return null

  const resumeSession = (s: SessionListItem): void => {
    const tabName = (s.customTitle || s.summary || s.firstPrompt || s.sessionId.slice(0, 8)).slice(
      0,
      48
    )
    const resumedCwd = s.cwd ?? cwd
    if (resumedCwd) pushCwdHistory(resumedCwd)
    saveFields({ hostId, cwd: resumedCwd, permissionMode })
    onCreate({
      hostId,
      name: tabName,
      color,
      cwd: resumedCwd,
      permissionMode,
      resume: s.sessionId
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__tabs">
          <button
            className={`modal__tab ${mode === 'new' ? 'modal__tab--active' : ''}`}
            onClick={() => setMode('new')}
          >
            New session
          </button>
          <button
            className={`modal__tab ${mode === 'resume' ? 'modal__tab--active' : ''}`}
            onClick={() => setMode('resume')}
          >
            Resume existing
          </button>
        </div>

        {mode === 'new' && (
          <>
            <label className="field">
              <span className="field__label">Name</span>
              <input
                className="field__input"
                placeholder="(auto from prompt)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Host</span>
              <select
                className="field__input"
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id} disabled={!h.available}>
                    {h.label}
                    {!h.available
                      ? ` — ${h.reason ?? 'unavailable'}`
                      : h.reason
                        ? ` (setup needed: ${h.reason})`
                        : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">Working directory</span>
              <div className="field__row">
                <input
                  className="field__input"
                  placeholder="C:\path\to\project"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const dir = await window.api.pickDirectory()
                    if (dir) setCwd(dir)
                  }}
                >
                  Browse…
                </button>
                {cwdHistory.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setCwdHistoryOpen((o) => !o)}
                    title="Recent folders"
                  >
                    Recent ({cwdHistory.length}) {cwdHistoryOpen ? '▴' : '▾'}
                  </button>
                )}
              </div>
              {cwdHistoryOpen && cwdHistory.length > 0 && (
                <div className="history">
                  {cwdHistory.map((p, i) => (
                    <div key={i} className="history__row">
                      <button
                        type="button"
                        className="history__item"
                        onClick={() => {
                          setCwd(p)
                          setCwdHistoryOpen(false)
                        }}
                        title="Use this folder"
                      >
                        <span className="history__text">{p}</span>
                      </button>
                      <button
                        type="button"
                        className="history__delete"
                        onClick={(e) => {
                          e.stopPropagation()
                          setCwdHistory(removeFromCwdHistory(p))
                        }}
                        title="Remove from history"
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </label>

            <div className="field">
              <span className="field__label">Permission mode</span>
              <div className="chip-row">
                {MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className={`chip ${permissionMode === m.value ? 'chip--active' : ''}`}
                    onClick={() => setPermissionMode(m.value)}
                    title={m.hint}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="field__label">Color</span>
              <div className="chip-row">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`swatch ${color === c ? 'swatch--active' : ''}`}
                    onClick={() => setColor(c)}
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>

            <div className="field">
              <div className="field__label-row">
                <span className="field__label">First prompt</span>
                {history.length > 0 && (
                  <button type="button" className="link" onClick={() => setHistoryOpen((o) => !o)}>
                    Recent ({history.length}) {historyOpen ? '▴' : '▾'}
                  </button>
                )}
              </div>
              {historyOpen && (
                <div className="history">
                  {history.length > 1 && (
                    <div className="history__toolbar">
                      <button
                        type="button"
                        className="link link--danger"
                        onClick={() => {
                          if (!window.confirm(`Clear all ${history.length} recent prompts?`)) return
                          clearHistory()
                          setHistory([])
                          setHistoryOpen(false)
                        }}
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  {history.map((p, i) => (
                    <div key={i} className="history__row">
                      <button
                        type="button"
                        className="history__item"
                        onClick={() => {
                          setPrompt(p)
                          setHistoryOpen(false)
                        }}
                        title="Use this prompt"
                      >
                        <span className="history__text">{p}</span>
                      </button>
                      <button
                        type="button"
                        className="history__delete"
                        onClick={(e) => {
                          e.stopPropagation()
                          setHistory(removeFromHistory(p))
                        }}
                        title="Remove from history"
                        aria-label="Remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="field__input field__textarea"
                placeholder="What should Claude do?"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                autoFocus
              />
            </div>

            <div className="modal__actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={submitNew}
                disabled={!cwd.trim() || !prompt.trim()}
              >
                Create
              </button>
            </div>
          </>
        )}

        {mode === 'resume' && (
          <>
            <div className="field session-list__toolbar">
              <input
                className="field__input"
                placeholder="Filter by title, prompt, path, branch…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                autoFocus
              />
              {filteredSessions.length > 0 && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={deleteAll}
                  title={
                    filter.trim()
                      ? `Delete ${filteredSessions.length} matching session${filteredSessions.length > 1 ? 's' : ''}`
                      : `Delete all ${filteredSessions.length} session${filteredSessions.length > 1 ? 's' : ''}`
                  }
                >
                  {filter.trim() ? `Delete ${filteredSessions.length} matching` : 'Clear all'}
                </button>
              )}
            </div>

            <div className="session-list">
              {sessionsLoading && <div className="session-list__empty">Loading…</div>}
              {!sessionsLoading && filteredSessions.length === 0 && (
                <div className="session-list__empty">
                  {sessions.length === 0
                    ? 'No saved sessions found.'
                    : 'No sessions match that filter.'}
                </div>
              )}
              {filteredSessions.map((s) => {
                const title = s.customTitle || s.summary || s.firstPrompt || s.sessionId
                return (
                  <div
                    key={s.sessionId}
                    className="session-row session-row--clickable"
                    onClick={() => resumeSession(s)}
                    title={`Resume ${s.sessionId}`}
                  >
                    <div className="session-row__main">
                      <div className="session-row__title">{title}</div>
                      <div className="session-row__meta">
                        {s.cwd && <span className="session-row__cwd">{s.cwd}</span>}
                        {s.gitBranch && <span className="pill pill--mute">{s.gitBranch}</span>}
                        <span className="session-row__time">{relativeTime(s.lastModified)}</span>
                        <span className="session-row__sid">{s.sessionId.slice(0, 8)}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="session-row__delete"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteOne(s)
                      }}
                      title="Delete this session"
                      aria-label="Delete session"
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>

            <div className="modal__actions">
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
