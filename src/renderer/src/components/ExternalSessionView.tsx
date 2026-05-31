import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExternalSessionInfo, LogEntry } from '../../../shared/protocol'
import MessageList from './MessageList'

interface Props {
  info: ExternalSessionInfo
  onBack: () => void
  onTakenOver: (newTabId: string) => void
}

const AUTO_REFRESH_MS = 5_000

function hostLabel(hostId: string): string {
  if (hostId === 'windows') return 'Win'
  if (hostId === 'wsl') return 'WSL'
  return hostId
}

export default function ExternalSessionView({
  info,
  onBack,
  onTakenOver
}: Props): React.JSX.Element {
  const [log, setLog] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sessionId = info.sessionId

  // Track the latest sessionId so an in-flight fetch doesn't overwrite state
  // for a different external session if the user navigates away mid-load.
  const latestRef = useRef(sessionId)
  useEffect(() => {
    latestRef.current = sessionId
  }, [sessionId])

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      const next = await window.api.getExternalTranscript(sessionId)
      if (latestRef.current === sessionId) setLog(next)
    } catch (e) {
      if (latestRef.current === sessionId) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (latestRef.current === sessionId) {
        setRefreshing(false)
        setLoading(false)
      }
    }
  }, [sessionId])

  // Initial load + auto-refresh tick. The tick is paused while a refresh is
  // already in flight to avoid pile-up on slow disks.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial transcript load on mount
    void refresh()
    const id = setInterval(() => {
      void refresh()
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  const takeOver = async (): Promise<void> => {
    setTakingOver(true)
    setError(null)
    try {
      const r = await window.api.takeOverExternal(sessionId)
      if (r.ok) {
        onTakenOver(r.tab.id)
      } else {
        setError(r.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTakingOver(false)
      setConfirming(false)
    }
  }

  const displayName = info.customTitle || info.summary || info.firstPrompt || 'External session'

  return (
    <div className="session session--external">
      <div className="session__header" style={{ borderColor: 'var(--accent)' }}>
        <div className="session__title">
          <button
            className="btn btn--xs"
            onClick={onBack}
            title="Back to dashboard"
            style={{ marginRight: 8 }}
          >
            ← Back
          </button>
          <span
            className="session__color-dot"
            style={{ background: info.live ? 'var(--accent)' : 'var(--text-mute)' }}
          />
          <span className="session__name" title={displayName}>
            {displayName}
          </span>
          <span className={`pill ${info.live ? 'pill--info' : 'pill--mute'}`}>
            {info.live ? 'external · live · read-only' : 'external · recent · read-only'}
          </span>
          <span className="session__meta">{info.cwd}</span>
          <span className="card__host">{hostLabel(info.hostId)}</span>
        </div>
        <div className="session__status">
          <button
            className="btn btn--xs"
            onClick={() => void refresh()}
            disabled={refreshing}
            title="Re-read the session file"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {!confirming ? (
            <button
              className="btn btn--xs btn--danger"
              onClick={() => setConfirming(true)}
              disabled={!info.live || takingOver}
              title={
                info.live
                  ? 'Terminate the external process and resume here'
                  : 'No live process detected'
              }
            >
              Take over
            </button>
          ) : (
            <>
              <span className="card__confirm">
                Kill {info.pid ? `PID ${info.pid}` : 'external claude'}?
              </span>
              <button className="btn btn--xs btn--danger" onClick={takeOver} disabled={takingOver}>
                {takingOver ? 'Taking over…' : 'Confirm'}
              </button>
              <button
                className="btn btn--xs"
                onClick={() => setConfirming(false)}
                disabled={takingOver}
              >
                Cancel
              </button>
            </>
          )}
          <span className="session__sid" title="session id">
            {sessionId.slice(0, 8)}
          </span>
        </div>
        <div className={`progress ${info.live ? 'progress--active' : ''}`} />
      </div>

      {error && <div className="external__error">{error}</div>}

      {loading ? (
        <div className="empty">
          <div className="empty__hint">Loading transcript…</div>
        </div>
      ) : log.length === 0 ? (
        <div className="empty">
          <div className="empty__hint">
            No messages in this session yet — or the file format wasn&apos;t recognized.
          </div>
        </div>
      ) : (
        <MessageList log={log} />
      )}

      <div className="external__footer">
        Read-only view. Auto-refreshes every {Math.round(AUTO_REFRESH_MS / 1000)}s. Click{' '}
        <strong>Take over</strong> to terminate the external process and continue the session here.
      </div>
    </div>
  )
}
