import { useState } from 'react'
import type { ExternalSessionInfo } from '../../../shared/protocol'
import { useTabsStore } from '../state/tabs'

interface Props {
  info: ExternalSessionInfo
  onTakenOver?: (newTabId: string) => void
}

function hostLabel(hostId: string): string {
  if (hostId === 'windows') return 'Win'
  if (hostId === 'wsl') return 'WSL'
  return hostId
}

function ago(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}

export default function ExternalCard({ info, onTakenOver }: Props): React.JSX.Element {
  const hide = useTabsStore((s) => s.hideExternal)
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const displayName = info.customTitle || info.summary || info.firstPrompt || 'External session'

  const takeOver = async (): Promise<void> => {
    setWorking(true)
    setError(null)
    try {
      const r = await window.api.takeOverExternal(info.sessionId)
      if (r.ok) {
        onTakenOver?.(r.tab.id)
      } else {
        setError(r.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
      setConfirming(false)
    }
  }

  const openDetail = useTabsStore((s) => s.setActiveExternal)

  return (
    <div
      className="card card--external"
      role="button"
      tabIndex={0}
      onClick={() => openDetail(info.sessionId)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openDetail(info.sessionId)
        }
      }}
      style={{ borderTopColor: info.live ? 'var(--accent)' : 'var(--line)' }}
    >
      <div className="card__head">
        <div className="card__title">
          <span
            className="card__dot"
            style={{ background: info.live ? 'var(--accent)' : 'var(--text-mute)' }}
          />
          <span className="card__name" title={displayName}>
            {displayName}
          </span>
        </div>
        <span className={`pill ${info.live ? 'pill--info' : 'pill--mute'}`}>
          {info.live ? 'external · live' : 'external · recent'}
        </span>
      </div>

      <div className="card__meta">
        <span className="card__host">{hostLabel(info.hostId)}</span>
        <span className="card__cwd" title={info.cwd}>
          {info.cwd}
        </span>
      </div>

      {info.lastAssistantSnippet && (
        <div className="card__snippet">{info.lastAssistantSnippet}</div>
      )}

      <div className="card__stats">
        <span className="stat">
          <span className="stat__n">{info.turns}</span>
          <span className="stat__l">turns</span>
        </span>
        <span className="stat">
          <span className="stat__n">{info.tools}</span>
          <span className="stat__l">tools</span>
        </span>
        {info.errors > 0 && (
          <span className="stat stat--err">
            <span className="stat__n">{info.errors}</span>
            <span className="stat__l">errors</span>
          </span>
        )}
        <span className="card__sid" title={`updated ${ago(info.lastModified)}`}>
          {info.sessionId.slice(0, 8)}
        </span>
      </div>

      {error && <div className="card__snippet card__snippet--err">{error}</div>}

      <div className="card__actions" onClick={(e) => e.stopPropagation()}>
        {confirming ? (
          <>
            <span className="card__confirm">
              Kill {info.pid ? `PID ${info.pid}` : 'external claude'}?
            </span>
            <button
              className="btn btn--xs btn--danger"
              onClick={takeOver}
              disabled={working}
              title="Terminate the external process and resume here"
            >
              {working ? 'Taking over…' : 'Confirm'}
            </button>
            <button className="btn btn--xs" onClick={() => setConfirming(false)} disabled={working}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn--xs"
              onClick={() => setConfirming(true)}
              disabled={!info.live}
              title={
                info.live
                  ? 'Terminates the external claude process and resumes the session here'
                  : 'No live process detected — start claude again or wait for the next scan'
              }
            >
              Take over
            </button>
            <button
              className="btn btn--xs"
              onClick={() => hide(info.sessionId)}
              title="Hide this card (until next refresh)"
            >
              Hide
            </button>
          </>
        )}
      </div>
    </div>
  )
}
