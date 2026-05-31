import type { TabState } from '../state/tabs'
import { useTabsStore } from '../state/tabs'
import { loadPinned, pinSession, unpinSession } from '../state/pinned'

interface Props {
  onNewTab: () => void
}

const STATUS_DOT: Record<string, string> = {
  idle: '○',
  starting: '◌',
  streaming: '●',
  awaiting_user: '◉',
  awaiting_approval: '!',
  done: '✓',
  error: '✕',
  aborted: '⊘',
  exited: '·'
}

export default function TabStrip({ onNewTab }: Props): React.JSX.Element {
  const { order, tabs, activeId, setActive, pinnedSessionIds, setPinnedSessionIds } = useTabsStore()

  const togglePin = (t: TabState): void => {
    if (!t.meta.sessionId) {
      // No session id yet — runner hasn't sent system/init. Tell the user.
      return
    }
    const sid = t.meta.sessionId
    const next = new Set(pinnedSessionIds)
    if (next.has(sid)) {
      next.delete(sid)
      unpinSession(sid)
    } else {
      next.add(sid)
      pinSession({
        hostId: t.meta.hostId,
        cwd: t.meta.cwd,
        permissionMode: t.meta.permissionMode,
        model: t.meta.model,
        name: t.meta.name,
        color: t.meta.color,
        sessionId: sid
      })
    }
    setPinnedSessionIds(next)
    // Refresh from storage so we stay in sync (other tabs may have written too).
    setPinnedSessionIds(new Set(loadPinned().map((p) => p.sessionId)))
  }
  return (
    <div className="tab-strip">
      <button
        className={`tab tab--home ${activeId === null ? 'tab--active' : ''}`}
        onClick={() => setActive(null)}
        title="Dashboard (Ctrl+0)"
        aria-label="Dashboard"
      >
        <span className="tab__home-icon">⌂</span>
      </button>
      {order.map((id) => {
        const t: TabState | undefined = tabs[id]
        if (!t) return null
        const active = id === activeId
        const dot = STATUS_DOT[t.meta.status] ?? '○'
        const pending = t.pendingApprovals.length > 0
        return (
          <div
            key={id}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            className={`tab ${active ? 'tab--active' : ''} ${pending ? 'tab--pending' : ''}`}
            style={{ borderBottomColor: active ? t.meta.color : 'transparent' }}
            onClick={() => setActive(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActive(id)
              }
            }}
            title={`${t.meta.name} — ${t.meta.status}`}
          >
            <span className="tab__dot" style={{ color: t.meta.color }}>
              {dot}
            </span>
            <span className="tab__name">{t.meta.name}</span>
            {t.meta.status === 'streaming' && (
              <span
                className="tab__spinner"
                style={{ ['--progress-color' as string]: t.meta.color }}
              />
            )}
            <button
              type="button"
              className={`tab__pin ${
                t.meta.sessionId && pinnedSessionIds.has(t.meta.sessionId) ? 'tab__pin--on' : ''
              }`}
              disabled={!t.meta.sessionId}
              onClick={(e) => {
                e.stopPropagation()
                togglePin(t)
              }}
              aria-label={
                t.meta.sessionId && pinnedSessionIds.has(t.meta.sessionId) ? 'Unpin' : 'Pin'
              }
              title={
                !t.meta.sessionId
                  ? 'No session id yet — wait for the first response'
                  : pinnedSessionIds.has(t.meta.sessionId)
                    ? 'Unpin (won’t restore on next start)'
                    : 'Pin (restore on next start)'
              }
            >
              📌
            </button>
            <button
              type="button"
              className="tab__close"
              onClick={(e) => {
                e.stopPropagation()
                window.api.closeTab(id)
              }}
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
        )
      })}
      <button className="tab tab--new" onClick={onNewTab} title="New session (Ctrl+N)">
        +
      </button>
    </div>
  )
}
