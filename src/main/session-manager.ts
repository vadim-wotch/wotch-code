import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { WebContents } from 'electron'
import { getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk'
import {
  IPC,
  type MainToRunner,
  type PermissionMode,
  type QuestionAnswer,
  type RunnerToMain,
  type SdkAssistantMessage,
  type SdkResultMessage,
  type SdkSystemInit,
  type SdkUserMessage,
  type TabEvent,
  type TabMeta,
  type TabStatus
} from '../shared/protocol'
import { getHost, listHosts as listHostsImpl } from './hosts'

export interface CreateTabInput {
  hostId: string
  name: string
  color: string
  cwd: string
  permissionMode: PermissionMode
  model?: string
  /** First prompt to send. Optional when `resume` is set — user can type later. */
  initialPrompt?: string
  /** Resume an existing on-disk session by ID. */
  resume?: string
}

interface ActiveTab {
  meta: TabMeta
  child: ChildProcess
  pendingApprovalIds: Set<string>
  /** AskUserQuestion prompts awaiting an answer from the renderer. */
  pendingQuestionIds: Set<string>
  /** True if we're waiting on a turn to complete (assistant streaming/tool use). */
  awaitingResult: boolean
  /** When true, handleSdkMessage emits log entries but does not update status. */
  replaying: boolean
}

const TAB_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4']

export class SessionManager {
  private tabs = new Map<string, ActiveTab>()
  private wc: WebContents | null = null

  constructor(private runnerScript: string) {}

  attach(wc: WebContents): void {
    this.wc = wc
  }

  listHosts(): ReturnType<typeof listHostsImpl> {
    return listHostsImpl()
  }

  pickColor(): string {
    return TAB_COLORS[this.tabs.size % TAB_COLORS.length]
  }

  async createTab(input: CreateTabInput): Promise<TabMeta> {
    const host = getHost(input.hostId)
    const cwd = await host.translateCwd(input.cwd)
    const id = randomUUID()
    const meta: TabMeta = {
      id,
      name: input.name || 'Session',
      color: input.color || this.pickColor(),
      hostId: host.info.id,
      cwd,
      permissionMode: input.permissionMode,
      model: input.model,
      status: 'starting',
      sessionId: input.resume,
      createdAt: Date.now(),
      sandbox: host.defaultSandbox
    }

    const child = host.spawnRunner({ runnerScript: this.runnerScript, cwd })
    const active: ActiveTab = {
      meta,
      child,
      pendingApprovalIds: new Set(),
      pendingQuestionIds: new Set(),
      awaitingResult: !!input.initialPrompt,
      replaying: false
    }
    this.tabs.set(id, active)

    this.wireRunner(active)
    this.broadcast({ kind: 'tab_created', tab: meta })

    // On resume, replay the existing transcript before any new turns. This is
    // best-effort: if the read fails, the runner still resumes and the user
    // just won't see prior context in the UI.
    if (input.resume) {
      try {
        await this.replayTranscript(active, input.resume, cwd)
      } catch (e) {
        console.error('replayTranscript failed', e)
      }
    }

    this.sendToRunner(active, {
      type: 'start',
      prompt: input.initialPrompt,
      options: {
        cwd,
        permissionMode: input.permissionMode,
        model: input.model,
        resume: input.resume,
        sandbox: host.defaultSandbox
      }
    })

    return meta
  }

  private async replayTranscript(tab: ActiveTab, sessionId: string, cwd: string): Promise<void> {
    const messages = await getSessionMessages(sessionId, { dir: cwd })
    tab.replaying = true
    try {
      for (const m of messages) {
        this.handleSdkMessage(tab, m as unknown as { type: string; [k: string]: unknown })
      }
    } finally {
      tab.replaying = false
    }
    this.broadcast({
      kind: 'log',
      tabId: tab.meta.id,
      entry: {
        kind: 'system',
        id: randomUUID(),
        text: `— resumed session ${sessionId.slice(0, 8)} (${messages.length} prior messages) —`
      }
    })
  }

  sendUserMessage(tabId: string, text: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.broadcast({
      kind: 'log',
      tabId,
      entry: { kind: 'user', id: randomUUID(), text }
    })
    tab.awaitingResult = true
    this.setStatus(tab, 'streaming')
    this.sendToRunner(tab, { type: 'userMessage', text })
  }

  approve(tabId: string, requestId: string, decision: 'allow' | 'deny', remember?: boolean): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (!tab.pendingApprovalIds.has(requestId)) return
    tab.pendingApprovalIds.delete(requestId)
    this.sendToRunner(tab, { type: 'permissionResponse', id: requestId, decision, remember })
    this.broadcast({ kind: 'approval_resolved', tabId, id: requestId })
    if (tab.pendingApprovalIds.size === 0 && tab.pendingQuestionIds.size === 0) {
      this.setStatus(tab, 'streaming')
    }
  }

  answerQuestion(tabId: string, requestId: string, answers: QuestionAnswer[] | null): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (!tab.pendingQuestionIds.has(requestId)) return
    tab.pendingQuestionIds.delete(requestId)
    this.sendToRunner(tab, { type: 'questionResponse', id: requestId, answers })
    this.broadcast({ kind: 'question_resolved', tabId, id: requestId })
    if (tab.pendingApprovalIds.size === 0 && tab.pendingQuestionIds.size === 0) {
      this.setStatus(tab, 'streaming')
    }
  }

  abort(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.sendToRunner(tab, { type: 'interrupt' })
  }

  /**
   * Run a user-typed shell command (! prefix) in the tab's host. Output is
   * streamed into a single `shell` log entry — visible only in the UI; the
   * SDK runner is not involved, so Claude's context is unaffected.
   */
  runShellCommand(tabId: string, command: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const trimmed = command.trim()
    if (!trimmed) return
    const host = getHost(tab.meta.hostId)
    const id = randomUUID()

    // Initial entry — immediately visible so the user sees the command land
    // even if it produces no output for a while.
    this.broadcast({
      kind: 'log',
      tabId,
      entry: { kind: 'shell', id, command: trimmed, output: '', running: true }
    })

    let child: ReturnType<typeof host.spawnShell>
    try {
      child = host.spawnShell({ cwd: tab.meta.cwd, command: trimmed })
    } catch (e) {
      this.broadcast({
        kind: 'log',
        tabId,
        entry: {
          kind: 'shell',
          id,
          command: trimmed,
          output: e instanceof Error ? e.message : String(e),
          exitCode: -1,
          running: false
        }
      })
      return
    }

    let output = ''
    // Cap the buffer to keep a runaway `yes` from blowing the renderer state.
    // 256KB is more than any realistic interactive command needs and still
    // small enough that whole-state replays stay cheap.
    const MAX = 256 * 1024
    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      output += text
      if (output.length > MAX) {
        output = output.slice(0, MAX) + '\n…[output truncated at 256KB]'
      }
      this.broadcast({
        kind: 'log',
        tabId,
        entry: { kind: 'shell', id, command: trimmed, output, running: true }
      })
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    child.on('error', (err) => {
      this.broadcast({
        kind: 'log',
        tabId,
        entry: {
          kind: 'shell',
          id,
          command: trimmed,
          output: `${output}\n${String(err)}`,
          exitCode: -1,
          running: false
        }
      })
    })
    child.on('exit', (code) => {
      this.broadcast({
        kind: 'log',
        tabId,
        entry: {
          kind: 'shell',
          id,
          command: trimmed,
          output,
          exitCode: code ?? -1,
          running: false
        }
      })
    })
  }

  /**
   * Close a tab. Returns a Promise that resolves when the runner has actually
   * exited (or after a hard timeout). The UI is informed via `tab_closed` only
   * after the child is really gone, so progress UIs reflect reality.
   */
  closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return Promise.resolve()
    // Remove from the live registry immediately so user-facing lists stop
    // showing it; broadcast happens when the child actually exits below.
    this.tabs.delete(tabId)

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.broadcast({ kind: 'tab_closed', tabId })
        resolve()
      }
      if (tab.child.exitCode !== null || tab.child.killed) {
        finish()
        return
      }
      let resolved = false
      const onExit = (): void => {
        if (resolved) return
        resolved = true
        finish()
      }
      tab.child.once('exit', onExit)
      this.sendToRunner(tab, { type: 'shutdown' })
      // Polite SIGTERM if the runner doesn't exit on its own quickly.
      setTimeout(() => {
        if (!resolved && tab.child.exitCode === null && !tab.child.killed) {
          try {
            tab.child.kill()
          } catch {
            // ignore
          }
        }
      }, 1500)
      // Absolute timeout — never hold the app open forever.
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          finish()
        }
      }, 3500)
    })
  }

  async clearTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const oldChild = tab.child
    const opts = {
      hostId: tab.meta.hostId,
      cwd: tab.meta.cwd,
      permissionMode: tab.meta.permissionMode,
      model: tab.meta.model
    }

    // Wind down the old runner. Best effort — we don't await its exit before
    // spawning the new one so the UI feels responsive.
    try {
      if (oldChild.stdin && !oldChild.stdin.destroyed) {
        oldChild.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n')
      }
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (oldChild.exitCode === null && !oldChild.killed) {
        try {
          oldChild.kill()
        } catch {
          // ignore
        }
      }
    }, 1500)

    // Reset state on the tab struct.
    tab.pendingApprovalIds.clear()
    tab.pendingQuestionIds.clear()
    tab.awaitingResult = false
    tab.replaying = false
    tab.meta.sessionId = undefined
    tab.meta.status = 'starting'

    // Spawn fresh runner with the same host/cwd/mode.
    const host = getHost(opts.hostId)
    tab.child = host.spawnRunner({ runnerScript: this.runnerScript, cwd: opts.cwd })
    this.wireRunner(tab)

    this.broadcast({ kind: 'log_cleared', tabId })
    this.broadcast({
      kind: 'log',
      tabId,
      entry: { kind: 'system', id: randomUUID(), text: '— context cleared —' }
    })
    this.broadcast({ kind: 'tab_status', tabId, status: 'starting' })

    // Start with no prompt — waits for the first user message.
    this.sendToRunner(tab, {
      type: 'start',
      options: {
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        model: opts.model,
        sandbox: host.defaultSandbox
      }
    })
  }

  async renameTab(tabId: string, newName: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const trimmed = newName.trim()
    if (!trimmed) return
    tab.meta.name = trimmed
    // Persist on disk too, when this tab is bound to a real session.
    if (tab.meta.sessionId) {
      try {
        await renameSession(tab.meta.sessionId, trimmed, { dir: tab.meta.cwd })
      } catch (e) {
        console.error('renameSession failed', e)
      }
    }
    this.broadcast({ kind: 'tab_renamed', tabId, name: trimmed })
  }

  shutdownAll(): Promise<void> {
    return Promise.all([...this.tabs.keys()].map((id) => this.closeTab(id))).then(() => undefined)
  }

  activeCount(): number {
    return this.tabs.size
  }

  /** Session IDs currently bound to a managed tab. Used by the external
   *  tracker to subtract our own sessions from its scan results. */
  getManagedSessionIds(): Set<string> {
    const out = new Set<string>()
    for (const tab of this.tabs.values()) {
      if (tab.meta.sessionId) out.add(tab.meta.sessionId)
    }
    return out
  }

  /**
   * Take over an externally-running Claude session: ask the host to terminate
   * the external process (best-effort), wait briefly for the JSONL file to
   * stop growing, then spawn a managed tab via the existing resume path. The
   * caller is responsible for removing the entry from the external tracker
   * after this resolves.
   */
  async takeOverExternal(input: {
    sessionId: string
    hostId: string
    cwd: string
    pid?: number
    jsonlPath: string
    name?: string
  }): Promise<TabMeta> {
    const host = getHost(input.hostId)
    if (input.pid) {
      try {
        await host.killProcess(input.pid)
      } catch {
        // best-effort — fall through to file-quiet wait
      }
    }
    await waitForFileQuiet(input.jsonlPath, 1500)
    // translateCwd is a no-op when the cwd is already in the host's expected
    // form (windows-host passes through, wsl-host's winToWsl returns linux
    // paths unchanged) — so we forward the JSONL-recorded cwd as-is.
    return this.createTab({
      hostId: input.hostId,
      name: input.name || 'Adopted session',
      color: this.pickColor(),
      cwd: input.cwd,
      permissionMode: 'default',
      resume: input.sessionId
    })
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sendToRunner(tab: ActiveTab, msg: MainToRunner): void {
    if (!tab.child.stdin || tab.child.stdin.destroyed) return
    tab.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private wireRunner(tab: ActiveTab): void {
    if (!tab.child.stdout) return
    const rl = createInterface({ input: tab.child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let msg: RunnerToMain
      try {
        msg = JSON.parse(line) as RunnerToMain
      } catch (e) {
        console.error('[main] failed to parse runner line:', line, e)
        return
      }
      this.handleRunnerMessage(tab, msg)
    })

    if (tab.child.stderr) {
      let stderrBuf = ''
      tab.child.stderr.on('data', (chunk: Buffer) => {
        // Log runner stderr to main console for debugging.
        process.stderr.write(`[runner ${tab.meta.id.slice(0, 8)}] ${chunk}`)
        // Also surface in the UI a line at a time so setup/runtime problems
        // (missing node, sandbox unavailable, etc.) are visible without
        // dropping into the dev console.
        stderrBuf += chunk.toString('utf8')
        let nl: number
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl).replace(/\r$/, '')
          stderrBuf = stderrBuf.slice(nl + 1)
          if (!line.trim()) continue
          // [runner] is the runner's own diagnostic prefix — passing those
          // through is noise. Anything else (e.g. WSL/CLI errors) goes up.
          if (line.startsWith('[runner]')) continue
          this.broadcast({
            kind: 'log',
            tabId: tab.meta.id,
            entry: { kind: 'system', id: randomUUID(), text: line }
          })
        }
      })
    }

    tab.child.on('exit', (code, signal) => {
      this.broadcast({
        kind: 'log',
        tabId: tab.meta.id,
        entry: {
          kind: 'system',
          id: randomUUID(),
          text: `Runner exited (code=${code}, signal=${signal ?? 'none'})`
        }
      })
      this.setStatus(tab, 'exited')
    })

    tab.child.on('error', (err) => {
      const errno = (err as NodeJS.ErrnoException).code
      // ENOENT from spawn on Windows usually means the cwd is invalid, not
      // the executable — Node attributes the failure to the wrong path.
      const hint =
        errno === 'ENOENT'
          ? ` (likely cause: working directory missing or inaccessible — cwd="${tab.meta.cwd}")`
          : ''
      this.broadcast({
        kind: 'log',
        tabId: tab.meta.id,
        entry: { kind: 'error', id: randomUUID(), text: `${String(err)}${hint}` }
      })
      this.setStatus(tab, 'error')
    })
  }

  private handleRunnerMessage(tab: ActiveTab, msg: RunnerToMain): void {
    switch (msg.type) {
      case 'ready': {
        // If the runner was started with no initial prompt (resume flow), it
        // is parked waiting for the first user message — go straight to
        // awaiting_user instead of streaming.
        this.setStatus(tab, tab.awaitingResult ? 'streaming' : 'awaiting_user')
        return
      }
      case 'sdkMessage': {
        this.handleSdkMessage(tab, msg.message as { type: string; [k: string]: unknown })
        return
      }
      case 'commands': {
        this.broadcast({ kind: 'commands', tabId: tab.meta.id, commands: msg.commands })
        return
      }
      case 'permissionRequest': {
        tab.pendingApprovalIds.add(msg.id)
        this.setStatus(tab, 'awaiting_approval')
        this.broadcast({
          kind: 'approval_request',
          tabId: tab.meta.id,
          request: {
            id: msg.id,
            toolName: msg.toolName,
            input: msg.input,
            title: msg.title,
            description: msg.description,
            displayName: msg.displayName,
            blockedPath: msg.blockedPath,
            decisionReason: msg.decisionReason
          }
        })
        return
      }
      case 'askUserQuestion': {
        tab.pendingQuestionIds.add(msg.id)
        this.setStatus(tab, 'awaiting_question')
        this.broadcast({
          kind: 'question_request',
          tabId: tab.meta.id,
          request: {
            id: msg.id,
            toolUseID: msg.toolUseID,
            questions: msg.questions
          }
        })
        return
      }
      case 'error': {
        this.broadcast({
          kind: 'log',
          tabId: tab.meta.id,
          entry: { kind: 'error', id: randomUUID(), text: msg.message }
        })
        if (msg.fatal) this.setStatus(tab, 'error')
        return
      }
      case 'exit': {
        // The 'exit' OS event will follow; status will land on 'exited' there.
        return
      }
    }
  }

  private handleSdkMessage(tab: ActiveTab, message: { type: string; [k: string]: unknown }): void {
    switch (message.type) {
      case 'system': {
        const m = message as unknown as SdkSystemInit
        if (m.subtype === 'init' && m.session_id) {
          tab.meta.sessionId = m.session_id
          this.broadcast({
            kind: 'tab_status',
            tabId: tab.meta.id,
            status: tab.meta.status,
            sessionId: m.session_id
          })
        }
        return
      }
      case 'assistant': {
        const m = message as unknown as SdkAssistantMessage
        this.broadcast({
          kind: 'log',
          tabId: tab.meta.id,
          entry: {
            kind: 'assistant',
            id: m.uuid,
            blocks: m.message?.content ?? []
          }
        })
        return
      }
      case 'user': {
        // SDK 'user' messages with role:'user' carry tool_results in their content array.
        const m = message as unknown as SdkUserMessage
        const content = m.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              const isError = (block as Record<string, unknown>).is_error === true
              this.broadcast({
                kind: 'log',
                tabId: tab.meta.id,
                entry: {
                  kind: 'tool_result',
                  id: block.tool_use_id,
                  content: block.content,
                  isError
                }
              })
            }
          }
        }
        return
      }
      case 'result': {
        const m = message as unknown as SdkResultMessage
        this.broadcast({
          kind: 'log',
          tabId: tab.meta.id,
          entry: {
            kind: 'result',
            id: randomUUID(),
            isError: !!m.is_error,
            summary: m.subtype,
            durationMs: m.duration_ms,
            costUsd: m.total_cost_usd
          }
        })
        if (!tab.replaying) {
          tab.awaitingResult = false
          this.setStatus(tab, m.is_error ? 'error' : 'awaiting_user')
        }
        return
      }
      // Ignore stream_event / partial_assistant in MVP — assistant messages
      // already deliver the final content. Add later for token-by-token UX.
    }
  }

  private setStatus(tab: ActiveTab, status: TabStatus): void {
    if (tab.meta.status === status) return
    tab.meta.status = status
    this.broadcast({
      kind: 'tab_status',
      tabId: tab.meta.id,
      status,
      sessionId: tab.meta.sessionId
    })
  }

  private broadcast(event: TabEvent): void {
    const wc = this.wc
    if (!wc || wc.isDestroyed()) return
    try {
      wc.send(IPC.tabEvent, event)
    } catch {
      // wc was torn down between the isDestroyed check and send (e.g. during
      // app.exit). Swallow — there's no UI left to update.
    }
  }
}

/**
 * Poll a file's mtime+size until it stops changing for ~250ms (or `maxMs`
 * elapses). Used after killing an external claude process so the resume reads
 * a fully-flushed transcript instead of catching a partial tail write.
 */
async function waitForFileQuiet(path: string, maxMs: number): Promise<void> {
  const { statSync: stat } = await import('node:fs')
  const start = Date.now()
  let last = ''
  let stableSince = 0
  while (Date.now() - start < maxMs) {
    let key: string
    try {
      const s = stat(path)
      key = `${s.size}:${s.mtimeMs}`
    } catch {
      // file gone — assume quiet
      return
    }
    if (key === last) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= 250) return
    } else {
      last = key
      stableSince = 0
    }
    await new Promise((r) => setTimeout(r, 80))
  }
}
