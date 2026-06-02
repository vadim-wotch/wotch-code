import { useEffect, useState } from 'react'
import type { LogEntry, TabStatus } from '../../../shared/protocol'
import type { TabState } from '../state/tabs'
import { useTabsStore } from '../state/tabs'
import ExternalCard from './ExternalCard'

interface Props {
  onOpen: (id: string) => void
  onNewTab: () => void
}

const EXTERNAL_TOGGLE_KEY = 'hb.showExternal.v1'

function loadExternalToggle(): boolean {
  try {
    return localStorage.getItem(EXTERNAL_TOGGLE_KEY) === '1'
  } catch {
    return false
  }
}
function saveExternalToggle(on: boolean): void {
  try {
    localStorage.setItem(EXTERNAL_TOGGLE_KEY, on ? '1' : '0')
  } catch {
    // ignore
  }
}

const STATUS_LABEL: Record<TabStatus, string> = {
  idle: 'idle',
  starting: 'starting',
  streaming: 'streaming',
  awaiting_user: 'ready',
  awaiting_approval: 'approval needed',
  awaiting_question: 'answer needed',
  done: 'done',
  error: 'error',
  aborted: 'aborted',
  exited: 'exited'
}

const STATUS_CLASS: Record<TabStatus, string> = {
  idle: 'pill--mute',
  starting: 'pill--info',
  streaming: 'pill--info',
  awaiting_user: 'pill--ok',
  awaiting_approval: 'pill--warn',
  awaiting_question: 'pill--warn',
  done: 'pill--ok',
  error: 'pill--err',
  aborted: 'pill--mute',
  exited: 'pill--mute'
}

function lastAssistantSnippet(log: LogEntry[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]
    if (e.kind !== 'assistant') continue
    for (const b of e.blocks) {
      if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        const t = (b as { text: string }).text.trim()
        if (t) return t.length > 240 ? t.slice(0, 240) + '…' : t
      }
    }
  }
  return ''
}

function counts(log: LogEntry[]): { turns: number; tools: number; errors: number } {
  let turns = 0
  let tools = 0
  let errors = 0
  for (const e of log) {
    if (e.kind === 'user') turns++
    else if (e.kind === 'assistant') {
      for (const b of e.blocks) if (b.type === 'tool_use') tools++
    } else if (e.kind === 'error') errors++
  }
  return { turns, tools, errors }
}

function Card({ tab, onOpen }: { tab: TabState; onOpen: (id: string) => void }): React.JSX.Element {
  const { meta, log, pendingApprovals } = tab
  const snippet = lastAssistantSnippet(log)
  const c = counts(log)
  const streaming = meta.status === 'streaming' || meta.status === 'starting'
  const pending = pendingApprovals.length

  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(meta.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(meta.id)
        }
      }}
      style={{ borderTopColor: meta.color }}
    >
      <div className="card__head">
        <div className="card__title">
          <span className="card__dot" style={{ background: meta.color }} />
          <span className="card__name">{meta.name}</span>
        </div>
        <span className={`pill ${STATUS_CLASS[meta.status] ?? 'pill--mute'}`}>
          {pending > 0 ? `${pending} approval${pending > 1 ? 's' : ''}` : STATUS_LABEL[meta.status]}
        </span>
      </div>

      <div
        className={`progress ${streaming ? 'progress--active' : ''} card__progress`}
        style={{ ['--progress-color' as string]: meta.color }}
      />

      <div className="card__meta">
        <span className="card__host">{meta.hostId === 'windows' ? 'Win' : meta.hostId}</span>
        <span className="card__cwd" title={meta.cwd}>
          {meta.cwd}
        </span>
      </div>

      {snippet && <div className="card__snippet">{snippet}</div>}

      <div className="card__stats">
        <span className="stat">
          <span className="stat__n">{c.turns}</span>
          <span className="stat__l">turns</span>
        </span>
        <span className="stat">
          <span className="stat__n">{c.tools}</span>
          <span className="stat__l">tools</span>
        </span>
        {c.errors > 0 && (
          <span className="stat stat--err">
            <span className="stat__n">{c.errors}</span>
            <span className="stat__l">errors</span>
          </span>
        )}
        {meta.sessionId && <span className="card__sid">{meta.sessionId.slice(0, 8)}</span>}
      </div>

      <div className="card__actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn--xs" onClick={() => onOpen(meta.id)} title="Open this session">
          Open
        </button>
        {(meta.status === 'streaming' || meta.status === 'starting') && (
          <button
            className="btn btn--xs"
            onClick={() => window.api.abort(meta.id)}
            title="Interrupt"
          >
            Interrupt
          </button>
        )}
        <button
          className="btn btn--xs"
          onClick={() => window.api.closeTab(meta.id)}
          title="Close tab"
        >
          Close
        </button>
      </div>
    </div>
  )
}

export default function Dashboard({ onOpen, onNewTab }: Props): React.JSX.Element {
  const { order, tabs, external, hiddenExternal, clearHiddenExternal } = useTabsStore()
  const [showExternal, setShowExternal] = useState<boolean>(() => loadExternalToggle())

  // Sync the toggle with the main-side tracker on mount and on change. Main
  // disables the scanner when off to avoid background fs/process work.
  useEffect(() => {
    void window.api.setExternalEnabled(showExternal)
    saveExternalToggle(showExternal)
  }, [showExternal])

  // Attention alerts: whether the Claude Code Notification hook is installed in
  // ~/.claude/settings.json. Opt-in — flipping it edits the user's global
  // settings and only affects sessions started afterwards.
  const [alertsOn, setAlertsOn] = useState(false)
  const [alertsBusy, setAlertsBusy] = useState(false)
  const [alertsError, setAlertsError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.api.getAttentionHook().then((s) => {
      if (!cancelled) setAlertsOn(s.installed)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const toggleAlerts = async (on: boolean): Promise<void> => {
    setAlertsBusy(true)
    setAlertsError(null)
    try {
      const r = await window.api.setAttentionHook(on)
      if (r.ok) setAlertsOn(r.installed)
      else setAlertsError(r.error)
    } catch (e) {
      setAlertsError(e instanceof Error ? e.message : String(e))
    } finally {
      setAlertsBusy(false)
    }
  }

  const grouped = {
    active: [] as TabState[],
    waiting: [] as TabState[],
    idle: [] as TabState[],
    done: [] as TabState[]
  }
  for (const id of order) {
    const t = tabs[id]
    if (!t) continue
    const needsUser =
      t.pendingApprovals.length > 0 ||
      t.pendingQuestions.length > 0 ||
      t.meta.status === 'awaiting_approval' ||
      t.meta.status === 'awaiting_question'
    if (needsUser) grouped.waiting.push(t)
    else if (t.meta.status === 'streaming' || t.meta.status === 'starting') grouped.active.push(t)
    else if (t.meta.status === 'awaiting_user') grouped.idle.push(t)
    else grouped.done.push(t)
  }

  const total = order.length

  const externalEntries = Object.values(external)
    .filter((e) => !hiddenExternal.has(e.sessionId))
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      return b.lastModified - a.lastModified
    })
  const externalAttention = externalEntries.filter((e) => e.attention)
  const externalLive = externalEntries.filter((e) => !e.attention && e.live)
  const externalRecent = externalEntries.filter((e) => !e.attention && !e.live)
  const hiddenCount = Object.keys(external).length - externalEntries.length
  const waitingCount = grouped.waiting.length + externalAttention.length

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <div>
          <h1 className="dashboard__title">Sessions</h1>
          <div className="dashboard__sub">
            {total === 0
              ? 'No sessions yet.'
              : `${total} session${total > 1 ? 's' : ''} · ${grouped.active.length} streaming · ${waitingCount} waiting on you`}
          </div>
        </div>
        <div className="dashboard__actions">
          <label className="toggle" title="Show Claude sessions running outside this app">
            <input
              type="checkbox"
              checked={showExternal}
              onChange={(e) => setShowExternal(e.target.checked)}
            />
            <span>Show external sessions</span>
          </label>
          {showExternal && (
            <label
              className="toggle"
              title={
                'Marks external sessions that are blocked on you (a permission prompt or your turn).\n' +
                'Installs a Notification hook in ~/.claude/settings.json. Only affects sessions started afterwards.'
              }
            >
              <input
                type="checkbox"
                checked={alertsOn}
                disabled={alertsBusy}
                onChange={(e) => void toggleAlerts(e.target.checked)}
              />
              <span>Attention alerts</span>
            </label>
          )}
          <button className="btn btn--primary" onClick={onNewTab}>
            New session
          </button>
        </div>
      </div>

      {total === 0 && !showExternal ? (
        <div className="empty">
          <div className="empty__hint">Create your first session to get started.</div>
        </div>
      ) : (
        <div className="dashboard__sections">
          {grouped.waiting.length > 0 && (
            <Section title="Waiting on you" tone="warn">
              {grouped.waiting.map((t) => (
                <Card key={t.meta.id} tab={t} onOpen={onOpen} />
              ))}
            </Section>
          )}
          {grouped.active.length > 0 && (
            <Section title="Streaming" tone="info">
              {grouped.active.map((t) => (
                <Card key={t.meta.id} tab={t} onOpen={onOpen} />
              ))}
            </Section>
          )}
          {grouped.idle.length > 0 && (
            <Section title="Ready" tone="ok">
              {grouped.idle.map((t) => (
                <Card key={t.meta.id} tab={t} onOpen={onOpen} />
              ))}
            </Section>
          )}
          {grouped.done.length > 0 && (
            <Section title="Finished" tone="mute">
              {grouped.done.map((t) => (
                <Card key={t.meta.id} tab={t} onOpen={onOpen} />
              ))}
            </Section>
          )}
        </div>
      )}

      {showExternal && (
        <>
          {total > 0 && <hr className="dashboard__sep" />}
          <div className="dashboard__external">
            {alertsError && (
              <div className="card__snippet card__snippet--err">
                Attention alerts: {alertsError}
              </div>
            )}
            {externalAttention.length === 0 &&
            externalLive.length === 0 &&
            externalRecent.length === 0 ? (
              <div className="empty">
                <div className="empty__hint">
                  Scanning ~/.claude/projects for sessions running outside this app. None found yet
                  — start <code>claude</code> in a terminal and it will appear here.
                </div>
              </div>
            ) : (
              <>
                {externalAttention.length > 0 && (
                  <Section title="External · needs attention" tone="warn">
                    {externalAttention.map((info) => (
                      <ExternalCard
                        key={info.sessionId}
                        info={info}
                        onTakenOver={(id) => onOpen(id)}
                      />
                    ))}
                  </Section>
                )}
                {externalLive.length > 0 && (
                  <Section title="External · live" tone="info">
                    {externalLive.map((info) => (
                      <ExternalCard
                        key={info.sessionId}
                        info={info}
                        onTakenOver={(id) => onOpen(id)}
                      />
                    ))}
                  </Section>
                )}
                {externalRecent.length > 0 && (
                  <Section title="External · recent" tone="mute">
                    {externalRecent.map((info) => (
                      <ExternalCard
                        key={info.sessionId}
                        info={info}
                        onTakenOver={(id) => onOpen(id)}
                      />
                    ))}
                  </Section>
                )}
              </>
            )}
            {hiddenCount > 0 && (
              <div className="dashboard__hidden-note">
                {hiddenCount} hidden{' '}
                <button className="btn btn--xs btn--link" onClick={() => clearHiddenExternal()}>
                  show all
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone: 'warn' | 'info' | 'ok' | 'mute'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="section">
      <div className={`section__title section__title--${tone}`}>{title}</div>
      <div className="section__grid">{children}</div>
    </section>
  )
}
