// Protocol between the Electron main process and a runner subprocess.
// Transport: NDJSON (one JSON object per line) over the runner's stdin/stdout.

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface HostInfo {
  id: string
  label: string
  available: boolean
  reason?: string
  /** When true, sessions on this host run with the SDK sandbox engaged by default. */
  defaultSandbox?: boolean
}

export interface RunnerStartOptions {
  cwd: string
  permissionMode: PermissionMode
  model?: string
  allowedTools?: string[]
  additionalDirectories?: string[]
  /** Resume an existing on-disk session by ID. */
  resume?: string
  /** Engage the SDK sandbox (Linux/macOS only — Windows host always passes false). */
  sandbox?: boolean
}

export interface SessionListItem {
  sessionId: string
  summary: string
  customTitle?: string
  firstPrompt?: string
  cwd?: string
  gitBranch?: string
  lastModified: number
  createdAt?: number
}

// ---------------------------------------------------------------------------
// Main → Runner
// ---------------------------------------------------------------------------

export type MainToRunner =
  | { type: 'start'; prompt?: string; options: RunnerStartOptions }
  | { type: 'userMessage'; text: string }
  | { type: 'permissionResponse'; id: string; decision: 'allow' | 'deny'; remember?: boolean }
  | { type: 'questionResponse'; id: string; answers: QuestionAnswer[] | null }
  | { type: 'interrupt' }
  | { type: 'shutdown' }

// ---------------------------------------------------------------------------
// Runner → Main
// ---------------------------------------------------------------------------

export type RunnerToMain =
  | { type: 'ready' }
  | { type: 'sdkMessage'; message: unknown } // forwarded verbatim from the SDK's async generator
  | { type: 'commands'; commands: SlashCommand[] }
  | {
      type: 'permissionRequest'
      id: string
      toolName: string
      input: Record<string, unknown>
      title?: string
      description?: string
      displayName?: string
      blockedPath?: string
      decisionReason?: string
      toolUseID: string
    }
  | {
      type: 'askUserQuestion'
      id: string
      toolUseID: string
      questions: QuestionPrompt[]
    }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'exit'; reason: string }

export interface SlashCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

// ---------------------------------------------------------------------------
// SDK message shape (subset we care about). Runner forwards SDK messages
// inside `sdkMessage.message`; the main process narrows by `message.type`.
// Full types live in @anthropic-ai/claude-agent-sdk; we mirror only what the
// renderer needs so we don't leak the whole SDK type surface across IPC.
// ---------------------------------------------------------------------------

export interface SdkSystemInit {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd?: string
  model?: string
  tools?: string[]
}

export interface SdkAssistantContentBlockText {
  type: 'text'
  text: string
}

export interface SdkAssistantContentBlockToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type SdkAssistantContentBlock =
  | SdkAssistantContentBlockText
  | SdkAssistantContentBlockToolUse
  | { type: string; [k: string]: unknown }

export interface SdkAssistantMessage {
  type: 'assistant'
  uuid: string
  session_id: string
  message: {
    role: 'assistant'
    content: SdkAssistantContentBlock[]
  }
}

export interface SdkUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content:
      | string
      | Array<{
          type: string
          tool_use_id?: string
          content?: unknown
          [k: string]: unknown
        }>
  }
  session_id?: string
}

export interface SdkResultMessage {
  type: 'result'
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string
  is_error: boolean
  duration_ms?: number
  num_turns?: number
  total_cost_usd?: number
  session_id: string
  result?: string
}

export type AnySdkMessage =
  | SdkSystemInit
  | SdkAssistantMessage
  | SdkUserMessage
  | SdkResultMessage
  | { type: string; [k: string]: unknown }

// ---------------------------------------------------------------------------
// Renderer-facing tab state. Lives in the zustand store; updated by main via
// the `tab.events` IPC channel.
// ---------------------------------------------------------------------------

export type TabStatus =
  | 'idle'
  | 'starting'
  | 'streaming'
  | 'awaiting_user'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'done'
  | 'error'
  | 'aborted'
  | 'exited'

export interface TabMeta {
  id: string
  name: string
  color: string
  hostId: string
  cwd: string
  permissionMode: PermissionMode
  model?: string
  status: TabStatus
  sessionId?: string
  createdAt: number
  /** True when the session is running with the SDK sandbox engaged. */
  sandbox?: boolean
}

export type LogEntry =
  | {
      kind: 'assistant'
      id: string // uuid from SDK
      blocks: SdkAssistantContentBlock[]
    }
  | {
      kind: 'user'
      id: string
      text: string
    }
  | {
      kind: 'tool_result'
      id: string // matches tool_use id
      content: unknown
      isError?: boolean
    }
  | {
      kind: 'system'
      id: string
      text: string
    }
  | {
      kind: 'result'
      id: string
      isError: boolean
      summary: string
      durationMs?: number
      costUsd?: number
    }
  | {
      kind: 'error'
      id: string
      text: string
    }
  | {
      // User-invoked shell command (! prefix). Output is shown only locally
      // — Claude does not see it unless the user pastes it into a follow-up.
      kind: 'shell'
      id: string
      command: string
      output: string
      exitCode?: number
      running: boolean
    }

export interface PendingApproval {
  id: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
  displayName?: string
  blockedPath?: string
  decisionReason?: string
}

// ---------------------------------------------------------------------------
// AskUserQuestion: Claude Code's structured question tool. The model emits a
// tool_use with `questions: [{ question, header, options: [...], multiSelect }]`
// and expects the host to render UI and return user-selected answers.
//
// Renderer always supports an "Other" free-text fallback (per the tool's
// contract — it auto-injects this option), surfaced via `customLabel` on the
// answer.
// ---------------------------------------------------------------------------

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface QuestionPrompt {
  question: string
  header: string
  multiSelect?: boolean
  options: QuestionOption[]
}

export interface QuestionAnswer {
  question: string
  header: string
  /** Labels of the options the user selected. For "Other" entries this is
   *  the user-typed label. */
  selectedLabels: string[]
  /** Optional free-text notes the user attached (always single string;
   *  empty when none). */
  notes?: string
}

export interface PendingQuestion {
  id: string
  toolUseID: string
  questions: QuestionPrompt[]
}

// ---------------------------------------------------------------------------
// Renderer ⇄ Main IPC channel names. Centralized to avoid string drift.
// ---------------------------------------------------------------------------

export const IPC = {
  // invoke (renderer → main, returns Promise)
  listHosts: 'tab.listHosts',
  createTab: 'tab.create',
  sendMessage: 'tab.send',
  approve: 'tab.approve',
  answerQuestion: 'tab.answerQuestion',
  runShell: 'tab.runShell',
  abort: 'tab.abort',
  closeTab: 'tab.close',
  renameTab: 'tab.rename',
  clearTab: 'tab.clear',
  pickDirectory: 'app.pickDirectory',
  listSessions: 'app.listSessions',
  deleteSession: 'app.deleteSession',
  setExternalEnabled: 'app.setExternalEnabled',
  takeOverExternal: 'app.takeOverExternal',
  getExternalTranscript: 'app.getExternalTranscript',
  // event (main → renderer, fire-and-forget)
  tabEvent: 'tab.event'
} as const

// ---------------------------------------------------------------------------
// External sessions: Claude Code conversations running outside this app (e.g.
// started in a terminal). The tracker scans ~/.claude/projects/ for sessions
// not in the in-memory managed registry, tails their JSONL transcripts via
// fs.watch, and broadcasts read-only summaries here. `live=true` means a
// matching `claude` process is currently running; `live=false` means recent
// on-disk activity only (fallback when process correlation fails or the
// terminal exited).
// ---------------------------------------------------------------------------

export interface ExternalSessionInfo {
  sessionId: string
  hostId: string
  cwd: string
  summary?: string
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  lastAssistantSnippet?: string
  turns: number
  tools: number
  errors: number
  lastModified: number
  createdAt?: number
  live: boolean
  pid?: number
}

// Events broadcast from main → renderer over IPC.tabEvent
export type TabEvent =
  | { kind: 'tab_created'; tab: TabMeta }
  | { kind: 'tab_status'; tabId: string; status: TabStatus; sessionId?: string }
  | { kind: 'log'; tabId: string; entry: LogEntry }
  | { kind: 'approval_request'; tabId: string; request: PendingApproval }
  | { kind: 'approval_resolved'; tabId: string; id: string }
  | { kind: 'question_request'; tabId: string; request: PendingQuestion }
  | { kind: 'question_resolved'; tabId: string; id: string }
  | { kind: 'tab_closed'; tabId: string }
  | { kind: 'tab_renamed'; tabId: string; name: string }
  | { kind: 'log_cleared'; tabId: string }
  | { kind: 'commands'; tabId: string; commands: SlashCommand[] }
  | { kind: 'external_added'; info: ExternalSessionInfo }
  | { kind: 'external_updated'; info: ExternalSessionInfo }
  | { kind: 'external_removed'; sessionId: string }
  | { kind: 'external_cleared' }

/**
 * Slash commands implemented entirely on the client side — they don't go to
 * the SDK and the original CLI handles them locally. Surfaced in the palette
 * alongside SDK-provided commands so the UX matches the terminal.
 */
export const CLIENT_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'rename',
    description: 'Rename this session',
    argumentHint: '<title>',
    aliases: ['name']
  },
  {
    name: 'clear',
    description: 'Clear context and start a fresh session in this tab'
  },
  {
    name: 'resume',
    description: 'Resume an existing session in a new tab'
  }
]
