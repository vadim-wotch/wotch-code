import { type FSWatcher, promises as fsp, readdirSync, statSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  type ExternalSessionInfo,
  type LogEntry,
  type SdkAssistantContentBlock,
  type TabEvent
} from '../shared/protocol'
import { getHost, listHosts } from './hosts'
import { NOTIFICATIONS_LOG, WOTCH_DIR } from './notification-hook'

/**
 * Scans ~/.claude/projects/* for session JSONL files this app didn't spawn,
 * tails them via fs.watch, and broadcasts read-only summaries to the renderer.
 *
 * Liveness ("is the external claude actually running right now?") is decided
 * by combining a per-host process scan with the session's file mtime:
 *   - WSL: /proc/<pid>/cwd is readable, so we match process cwd → session cwd
 *     precisely and record a pid for take-over.
 *   - Windows: process cwd isn't cheap to query for arbitrary processes, so
 *     we fall back to "any claude process running + recent file activity =
 *     live (uncorrelated)". Take-over then targets the first claude process.
 *
 * The tracker holds no IO toward the external process — fs.watch is a pure
 * observer. Take-over (kill + resume) is a one-off action initiated by the UI.
 */

interface ExternalEntry {
  sessionId: string
  hostId: string
  cwd: string
  projectDir: string
  jsonlPath: string
  offset: number
  size: number
  lastModified: number
  createdAt?: number
  turns: number
  tools: number
  errors: number
  lastSnippet?: string
  firstPrompt?: string
  summary?: string
  customTitle?: string
  gitBranch?: string
  live: boolean
  pid?: number
  watcher?: FSWatcher
  /** Debounce timer for fs.watch flapping (Windows fires many events per write). */
  debounce?: NodeJS.Timeout
  /** Cached info object, equal-checked against new derivation to skip noise updates. */
  lastBroadcast?: string
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SESSION_FILE_RE = /^([0-9a-f-]{36})\.jsonl$/i
/** A session whose file was modified within this window is shown even when
 *  no matching `claude` process is found (recent activity fallback). Widened
 *  from 5 min so an idle-but-still-typed-in-recent-memory terminal session
 *  doesn't disappear between prompts. */
const RECENT_WINDOW_MS = 30 * 60 * 1000
/** When a claude process exists on a host, we'll still adopt sessions on that
 *  host whose mtime is older than RECENT_WINDOW_MS, up to this age. Prevents
 *  surfacing ancient archived sessions even when claude happens to be running
 *  somewhere on the same host. */
const LIVE_FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000
/** Hard cap on adopted sessions to keep fs.watch + UI from exploding when the
 *  user has hundreds of recent sessions on disk. Sorted by mtime desc. */
const MAX_ADOPTED = 30
/** Process scan + dir rescan cadence while enabled. fs.watch handles within-
 *  session updates between ticks; this catches new sessions and PID changes. */
const REFRESH_MS = 5_000
/** Snippet cap on assistant text — mirrors Dashboard.tsx lastAssistantSnippet. */
const SNIPPET_MAX = 240

export interface ExternalTrackerDeps {
  getWebContents: () => WebContents | null
  getManagedSessionIds: () => Set<string>
}

/** Records the latest Claude Code Notification per session, keyed by sessionId.
 *  Written by the bundled notify-hook helper (see notification-hook.ts) and
 *  tailed here to mark sessions that are blocked on the user. */
interface NotifRecord {
  type: 'permission' | 'idle'
  ts: number
}
/** Compact the notifications log once it grows past this — it's append-only, so
 *  a long-lived install would otherwise grow without bound. */
const NOTIF_LOG_COMPACT_BYTES = 256 * 1024

export class ExternalSessionTracker {
  private entries = new Map<string, ExternalEntry>()
  private enabled = false
  private refreshTimer?: NodeJS.Timeout
  private rescanInFlight = false
  /** Latest notification per sessionId, rebuilt from the on-disk log. */
  private notifBySession = new Map<string, NotifRecord>()
  private notifWatcher?: FSWatcher
  private notifDebounce?: NodeJS.Timeout

  constructor(private deps: ExternalTrackerDeps) {}

  isEnabled(): boolean {
    return this.enabled
  }

  getEntry(sessionId: string): ExternalEntry | undefined {
    return this.entries.get(sessionId)
  }

  async enable(): Promise<void> {
    if (this.enabled) return
    this.enabled = true
    await this.refreshNotifications()
    this.openNotifWatcher()
    await this.rescan()
    this.refreshTimer = setInterval(() => {
      void this.rescan()
    }, REFRESH_MS)
  }

  disable(): void {
    if (!this.enabled) return
    this.enabled = false
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = undefined
    }
    this.closeNotifWatcher()
    this.notifBySession.clear()
    for (const e of this.entries.values()) {
      this.closeWatcher(e)
    }
    this.entries.clear()
    this.broadcast({ kind: 'external_cleared' })
  }

  /**
   * Read the full transcript for an external session as LogEntry[]. Used by
   * the read-only detail view in the renderer. Resolves to [] if the file is
   * gone or unreadable — the view shows an empty state rather than erroring.
   */
  async readTranscript(sessionId: string): Promise<LogEntry[]> {
    const entry = this.entries.get(sessionId)
    if (!entry) return []
    let text: string
    try {
      text = await fsp.readFile(entry.jsonlPath, 'utf8')
    } catch {
      return []
    }
    return parseJsonlToLog(text)
  }

  /** Drop one external entry — called by SessionManager after takeOver kills
   *  the process and adopts the session as a managed tab. */
  removeBySessionId(sessionId: string): void {
    const e = this.entries.get(sessionId)
    if (!e) return
    this.closeWatcher(e)
    this.entries.delete(sessionId)
    this.broadcast({ kind: 'external_removed', sessionId })
  }

  // -------------------------------------------------------------------------
  // Scan
  // -------------------------------------------------------------------------

  private async rescan(): Promise<void> {
    if (!this.enabled || this.rescanInFlight) return
    this.rescanInFlight = true
    try {
      // Pick up notifications even if the fs.watch missed an event, and open
      // the watcher lazily once the hook has created the wotch dir/log.
      await this.refreshNotifications()
      this.openNotifWatcher()

      const projectDirs = this.listProjectDirs()
      const managed = this.deps.getManagedSessionIds()

      // Process scan FIRST: the adoption decision depends on whether any
      // claude process is running for a session's host/cwd. Without this
      // ordering, idle-but-live sessions (process alive, file mtime stale
      // because the user is mid-think) would be dropped before liveness
      // could rescue them.
      const procsByHost = await this.scanProcessesByHost()

      // Phase 1: enumerate candidate session files with their stat info, then
      // decide which ones to adopt. We collect first so we can apply the
      // MAX_ADOPTED cap by mtime desc.
      interface Candidate {
        sessionId: string
        projectDir: string
        jsonlPath: string
        size: number
        mtimeMs: number
      }
      const candidates: Candidate[] = []
      const seen = new Set<string>()

      for (const projectDir of projectDirs) {
        const dirPath = join(PROJECTS_DIR, projectDir)
        let files: string[]
        try {
          files = readdirSync(dirPath)
        } catch {
          continue
        }
        for (const file of files) {
          const m = SESSION_FILE_RE.exec(file)
          if (!m) continue
          const sessionId = m[1]
          if (managed.has(sessionId)) continue
          const jsonlPath = join(dirPath, file)
          let st
          try {
            st = statSync(jsonlPath)
          } catch {
            continue
          }
          seen.add(sessionId)
          const existing = this.entries.get(sessionId)
          if (existing) {
            if (st.size > existing.offset) {
              await this.tailAppendedBytes(existing)
            }
            existing.lastModified = st.mtimeMs
            continue
          }
          candidates.push({
            sessionId,
            projectDir,
            jsonlPath,
            size: st.size,
            mtimeMs: st.mtimeMs
          })
        }
      }

      // Sort newest first and apply the cap. The eligibility filter below
      // further narrows based on recency / matching process.
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const now = Date.now()
      let adopted = 0
      for (const c of candidates) {
        if (adopted >= MAX_ADOPTED) break
        const recent = now - c.mtimeMs < RECENT_WINDOW_MS
        // Eligibility for the live-fallback path requires reading the file to
        // know the cwd / hostId. Defer that to adoptSession; here we use a
        // cheap "any host has claude processes AND within day" gate to skip
        // truly ancient sessions even when claude is running somewhere.
        const anyProcessAnywhere = Array.from(procsByHost.values()).some((p) => p.length > 0)
        const withinDay = now - c.mtimeMs < LIVE_FALLBACK_WINDOW_MS
        if (!recent && !(anyProcessAnywhere && withinDay)) continue
        const ok = await this.adoptSession(
          c.sessionId,
          c.projectDir,
          c.jsonlPath,
          c.size,
          c.mtimeMs,
          procsByHost
        )
        if (ok) adopted += 1
      }

      // Drop entries whose file disappeared, or that were just adopted as
      // managed tabs.
      for (const [sid, entry] of this.entries) {
        if (managed.has(sid)) {
          this.closeWatcher(entry)
          this.entries.delete(sid)
          this.broadcast({ kind: 'external_removed', sessionId: sid })
          continue
        }
        if (!seen.has(sid)) {
          this.closeWatcher(entry)
          this.entries.delete(sid)
          this.broadcast({ kind: 'external_removed', sessionId: sid })
        }
      }

      // Refresh liveness on all entries using the already-collected scan.
      this.applyLiveness(procsByHost)
    } finally {
      this.rescanInFlight = false
    }
  }

  private listProjectDirs(): string[] {
    try {
      return readdirSync(PROJECTS_DIR)
    } catch {
      return []
    }
  }

  private async adoptSession(
    sessionId: string,
    projectDir: string,
    jsonlPath: string,
    size: number,
    lastModified: number,
    procsByHost: Map<string, { pid: number; cwd?: string }[]>
  ): Promise<boolean> {
    let text: string
    try {
      text = await fsp.readFile(jsonlPath, 'utf8')
    } catch {
      return false
    }
    const stats = parseJsonlStats(text)
    if (!stats.cwd) return false // can't classify without a cwd
    const hostId = deriveHostId(stats.cwd)
    // If the host has no live claude processes AND the file isn't recent,
    // skip — the cheap pre-filter caught the "any host has process" case,
    // but per-host we can be more precise.
    const procs = procsByHost.get(hostId) ?? []
    const recent = Date.now() - lastModified < RECENT_WINDOW_MS
    if (!recent && procs.length === 0) return false

    // Initial live/pid stays false here — the applyLiveness pass that runs
    // right after adoption sets them based on per-host PID allocation,
    // avoiding a "N live → K live" flicker on first paint.
    const entry: ExternalEntry = {
      sessionId,
      hostId,
      cwd: stats.cwd,
      projectDir,
      jsonlPath,
      offset: size,
      size,
      lastModified,
      createdAt: stats.createdAt,
      turns: stats.turns,
      tools: stats.tools,
      errors: stats.errors,
      lastSnippet: stats.lastSnippet,
      firstPrompt: stats.firstPrompt,
      gitBranch: stats.gitBranch,
      live: false
    }
    this.entries.set(sessionId, entry)
    this.openWatcher(entry)
    this.broadcast({ kind: 'external_added', info: this.toInfo(entry) })
    return true
  }

  private openWatcher(entry: ExternalEntry): void {
    try {
      entry.watcher = fsWatch(entry.jsonlPath, () => this.onFileEvent(entry))
    } catch {
      // fs.watch can fail (file gone between stat and watch); the periodic
      // rescan will pick changes up regardless.
    }
  }

  private closeWatcher(entry: ExternalEntry): void {
    if (entry.debounce) {
      clearTimeout(entry.debounce)
      entry.debounce = undefined
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // ignore
      }
      entry.watcher = undefined
    }
  }

  private onFileEvent(entry: ExternalEntry): void {
    if (!this.enabled) return
    // Debounce — Windows fires many events for a single append.
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined
      void this.tailAppendedBytes(entry)
    }, 80)
  }

  private async tailAppendedBytes(entry: ExternalEntry): Promise<void> {
    let st
    try {
      st = statSync(entry.jsonlPath)
    } catch {
      // file gone — drop it
      this.closeWatcher(entry)
      this.entries.delete(entry.sessionId)
      this.broadcast({ kind: 'external_removed', sessionId: entry.sessionId })
      return
    }
    if (st.size < entry.offset) {
      // File truncated/rewritten — re-read from the start.
      entry.offset = 0
      entry.turns = 0
      entry.tools = 0
      entry.errors = 0
      entry.lastSnippet = undefined
    }
    if (st.size === entry.offset) {
      // No new bytes; just refresh mtime + maybe broadcast if liveness shifted.
      entry.lastModified = st.mtimeMs
      this.maybeBroadcastUpdate(entry)
      return
    }
    let appended: string
    try {
      const fh = await fsp.open(entry.jsonlPath, 'r')
      try {
        const buf = Buffer.alloc(st.size - entry.offset)
        await fh.read(buf, 0, buf.length, entry.offset)
        appended = buf.toString('utf8')
      } finally {
        await fh.close()
      }
    } catch {
      return
    }
    entry.offset = st.size
    entry.size = st.size
    entry.lastModified = st.mtimeMs

    // Lines may be split across reads — leave any trailing partial line in the
    // offset by trimming back to the last newline. For simplicity here we
    // accept that a partial last line gets re-counted on the next read; counts
    // come from full assistant/user entries and partials are extremely rare
    // (claude flushes whole JSON objects per write).
    const lines = appended.split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      applyJsonlLineToEntry(line, entry)
    }
    this.maybeBroadcastUpdate(entry)
  }

  // -------------------------------------------------------------------------
  // Liveness
  // -------------------------------------------------------------------------

  private async scanProcessesByHost(): Promise<Map<string, { pid: number; cwd?: string }[]>> {
    const byHost = new Map<string, { pid: number; cwd?: string }[]>()
    await Promise.all(
      listHosts().map(async (h) => {
        if (!h.available) {
          byHost.set(h.id, [])
          return
        }
        try {
          const adapter = getHost(h.id)
          const procs = await adapter.listClaudeProcesses()
          byHost.set(
            h.id,
            procs.map((p) => ({ pid: p.pid, cwd: p.cwd }))
          )
        } catch {
          byHost.set(h.id, [])
        }
      })
    )
    return byHost
  }

  private applyLiveness(procsByHost: Map<string, { pid: number; cwd?: string }[]>): void {
    // Group entries by host so we can do a per-host 1:1 PID allocation. Without
    // this, "any process running" would light up *every* session on the host
    // as live with the same PID — which produces N live cards for 1 process.
    const entriesByHost = new Map<string, ExternalEntry[]>()
    for (const e of this.entries.values()) {
      const arr = entriesByHost.get(e.hostId) ?? []
      arr.push(e)
      entriesByHost.set(e.hostId, arr)
    }

    for (const [hostId, entries] of entriesByHost) {
      const procs = procsByHost.get(hostId) ?? []
      if (procs.length === 0) {
        for (const e of entries) {
          if (e.live || e.pid !== undefined) {
            e.live = false
            e.pid = undefined
          }
          this.maybeBroadcastUpdate(e)
        }
        continue
      }

      // Pass 1: precise cwd matches claim their PID first. Each PID can only
      // be matched once (multiple sessions wouldn't share a claude process).
      const usedPids = new Set<number>()
      const unmatched: ExternalEntry[] = []
      for (const e of entries) {
        const matched = procs.find(
          (p) => p.cwd && !usedPids.has(p.pid) && samePath(p.cwd, e.cwd, hostId)
        )
        if (matched) {
          e.live = true
          e.pid = matched.pid
          usedPids.add(matched.pid)
        } else {
          unmatched.push(e)
        }
      }

      // Pass 2: assign any remaining PIDs to the most-recently-modified
      // sessions as a best-guess (Windows-only path — WSL would have matched
      // by cwd above). Anyone beyond that count is "recent" but not live.
      const freePids = procs.filter((p) => !usedPids.has(p.pid)).map((p) => p.pid)
      unmatched.sort((a, b) => b.lastModified - a.lastModified)
      for (let i = 0; i < unmatched.length; i++) {
        const e = unmatched[i]
        if (i < freePids.length) {
          e.live = true
          e.pid = freePids[i]
        } else {
          e.live = false
          e.pid = undefined
        }
      }

      for (const e of entries) this.maybeBroadcastUpdate(e)
    }
  }

  // -------------------------------------------------------------------------
  // Notifications (Notification-hook signal log)
  // -------------------------------------------------------------------------

  private openNotifWatcher(): void {
    if (this.notifWatcher) return
    // Watch the wotch dir (the log file may not exist yet — fs.watch on a
    // missing file throws). A dir watcher fires when the log is created or
    // appended. If the dir doesn't exist yet, this throws and we retry on the
    // next rescan tick once the hook helper has created it.
    try {
      this.notifWatcher = fsWatch(WOTCH_DIR, (_event, filename) => {
        if (filename && !String(filename).includes('notifications')) return
        this.onNotifEvent()
      })
    } catch {
      // dir not present yet — refreshNotifications() on each tick covers us
    }
  }

  private closeNotifWatcher(): void {
    if (this.notifDebounce) {
      clearTimeout(this.notifDebounce)
      this.notifDebounce = undefined
    }
    if (this.notifWatcher) {
      try {
        this.notifWatcher.close()
      } catch {
        // ignore
      }
      this.notifWatcher = undefined
    }
  }

  private onNotifEvent(): void {
    if (!this.enabled) return
    if (this.notifDebounce) clearTimeout(this.notifDebounce)
    this.notifDebounce = setTimeout(() => {
      this.notifDebounce = undefined
      void this.refreshNotifications().then(() => {
        for (const e of this.entries.values()) this.maybeBroadcastUpdate(e)
      })
    }, 80)
  }

  /** Rebuild notifBySession from the on-disk log (latest record per session). */
  private async refreshNotifications(): Promise<void> {
    let text: string
    try {
      text = await fsp.readFile(NOTIFICATIONS_LOG, 'utf8')
    } catch {
      this.notifBySession.clear()
      return
    }
    const map = new Map<string, NotifRecord>()
    for (const raw of text.split(/\r?\n/)) {
      if (!raw) continue
      let o: Record<string, unknown>
      try {
        o = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof o.sessionId !== 'string' || typeof o.ts !== 'number') continue
      const type = o.type === 'permission' ? 'permission' : 'idle'
      const prev = map.get(o.sessionId)
      if (!prev || o.ts >= prev.ts) map.set(o.sessionId, { type, ts: o.ts })
    }
    this.notifBySession = map

    if (text.length > NOTIF_LOG_COMPACT_BYTES) {
      const compact =
        Array.from(map.entries())
          .map(([sessionId, v]) => JSON.stringify({ sessionId, type: v.type, ts: v.ts }))
          .join('\n') + '\n'
      try {
        await fsp.writeFile(NOTIFICATIONS_LOG, compact, 'utf8')
      } catch {
        // best-effort compaction; ignore failures
      }
    }
  }

  /**
   * "Needs attention" for an external session, derived from the latest hook
   * notification vs. transcript activity:
   *   - undefined if the process isn't live (can't interact) or no notification.
   *   - undefined if the transcript advanced past the notification (mtime >= ts)
   *     — the user already responded, so it self-clears.
   *   - otherwise the notification's type ('permission' | 'idle').
   */
  private deriveAttention(entry: ExternalEntry): 'permission' | 'idle' | undefined {
    if (!entry.live) return undefined
    const n = this.notifBySession.get(entry.sessionId)
    if (!n) return undefined
    if (n.ts <= entry.lastModified) return undefined
    return n.type
  }

  // -------------------------------------------------------------------------
  // Broadcast helpers
  // -------------------------------------------------------------------------

  private toInfo(entry: ExternalEntry): ExternalSessionInfo {
    const attention = this.deriveAttention(entry)
    return {
      sessionId: entry.sessionId,
      hostId: entry.hostId,
      cwd: entry.cwd,
      summary: entry.summary,
      customTitle: entry.customTitle,
      firstPrompt: entry.firstPrompt,
      gitBranch: entry.gitBranch,
      lastAssistantSnippet: entry.lastSnippet,
      turns: entry.turns,
      tools: entry.tools,
      errors: entry.errors,
      lastModified: entry.lastModified,
      createdAt: entry.createdAt,
      live: entry.live,
      pid: entry.pid,
      ...(attention ? { attention } : {})
    }
  }

  private maybeBroadcastUpdate(entry: ExternalEntry): void {
    const info = this.toInfo(entry)
    const key = JSON.stringify(info)
    if (entry.lastBroadcast === key) return
    entry.lastBroadcast = key
    this.broadcast({ kind: 'external_updated', info })
  }

  private broadcast(event: TabEvent): void {
    const wc = this.deps.getWebContents()
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(IPC.tabEvent, event)
    } catch {
      // ignore — renderer torn down
    }
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing helpers
// ---------------------------------------------------------------------------

interface JsonlStats {
  cwd?: string
  gitBranch?: string
  createdAt?: number
  turns: number
  tools: number
  errors: number
  firstPrompt?: string
  lastSnippet?: string
}

function parseJsonlStats(text: string): JsonlStats {
  const stats: JsonlStats = { turns: 0, tools: 0, errors: 0 }
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue
    applyJsonlLineToStats(raw, stats)
  }
  return stats
}

function applyJsonlLineToStats(line: string, stats: JsonlStats): void {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  if (typeof obj.cwd === 'string' && !stats.cwd) stats.cwd = obj.cwd
  if (typeof obj.gitBranch === 'string' && !stats.gitBranch) stats.gitBranch = obj.gitBranch
  if (typeof obj.timestamp === 'string' && !stats.createdAt) {
    const t = Date.parse(obj.timestamp)
    if (Number.isFinite(t)) stats.createdAt = t
  }
  const type = obj.type
  if (type === 'user') {
    const content = readMessageContent(obj)
    if (typeof content === 'string') {
      if (!stats.firstPrompt) stats.firstPrompt = truncate(content, SNIPPET_MAX)
      // Only real user turns increment — tool_result lines also carry role:user
      // but their content is an array.
      stats.turns += 1
    }
  } else if (type === 'assistant') {
    const blocks = readMessageContent(obj)
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        const block = b as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = block.text.trim()
          if (t) stats.lastSnippet = truncate(t, SNIPPET_MAX)
        } else if (block.type === 'tool_use') {
          stats.tools += 1
        }
      }
    }
  } else if (type === 'tool_result') {
    if ((obj as Record<string, unknown>).is_error === true) stats.errors += 1
  }
}

function applyJsonlLineToEntry(line: string, entry: ExternalEntry): void {
  const before = {
    turns: entry.turns,
    tools: entry.tools,
    errors: entry.errors,
    lastSnippet: entry.lastSnippet,
    firstPrompt: entry.firstPrompt,
    gitBranch: entry.gitBranch
  }
  const stats: JsonlStats = {
    cwd: entry.cwd,
    gitBranch: entry.gitBranch,
    createdAt: entry.createdAt,
    turns: entry.turns,
    tools: entry.tools,
    errors: entry.errors,
    firstPrompt: entry.firstPrompt,
    lastSnippet: entry.lastSnippet
  }
  applyJsonlLineToStats(line, stats)
  entry.turns = stats.turns
  entry.tools = stats.tools
  entry.errors = stats.errors
  entry.lastSnippet = stats.lastSnippet ?? before.lastSnippet
  entry.firstPrompt = stats.firstPrompt ?? before.firstPrompt
  entry.gitBranch = stats.gitBranch ?? before.gitBranch
}

function readMessageContent(obj: Record<string, unknown>): unknown {
  const message = obj.message
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>
    return m.content
  }
  return obj.content
}

function truncate(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function deriveHostId(cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(cwd)) return 'windows'
  if (cwd.startsWith('/')) return 'wsl'
  return 'windows'
}

function normalizePath(p: string, hostId: string): string {
  if (hostId === 'windows') {
    return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  }
  return p.replace(/\/+$/, '')
}

function samePath(a: string, b: string, hostId: string): boolean {
  return normalizePath(a, hostId) === normalizePath(b, hostId)
}

// ---------------------------------------------------------------------------
// JSONL → LogEntry[] transcript parser
// ---------------------------------------------------------------------------
//
// Same dispatching shape as SessionManager.handleSdkMessage, but returns an
// array instead of broadcasting. Lines whose type we don't recognize
// (queue-operation, attachment, thinking, todo_reminder, etc.) are skipped —
// they're internal CLI plumbing and don't belong in a user-visible transcript.

export function parseJsonlToLog(text: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }
    const type = obj.type
    if (type === 'assistant') {
      const message = obj.message as { content?: SdkAssistantContentBlock[] } | undefined
      const uuid = typeof obj.uuid === 'string' ? obj.uuid : randomUUID()
      out.push({ kind: 'assistant', id: uuid, blocks: message?.content ?? [] })
    } else if (type === 'user') {
      const message = obj.message as { content?: unknown } | undefined
      const content = message?.content
      if (typeof content === 'string') {
        out.push({ kind: 'user', id: randomUUID(), text: content })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            out.push({
              kind: 'tool_result',
              id: b.tool_use_id,
              content: b.content,
              isError: b.is_error === true
            })
          } else if (b.type === 'text' && typeof b.text === 'string') {
            // Some user entries carry text blocks (e.g. when the user typed
            // /something via the CLI). Surface them as user messages.
            out.push({ kind: 'user', id: randomUUID(), text: b.text })
          }
        }
      }
    } else if (type === 'result') {
      out.push({
        kind: 'result',
        id: randomUUID(),
        isError: obj.is_error === true,
        summary: typeof obj.subtype === 'string' ? obj.subtype : 'result',
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined
      })
    }
    // Other types (queue-operation, attachment, ai-title, thinking, …)
    // intentionally ignored — they're CLI-internal and never reach the
    // managed session log either.
  }
  return out
}
