/**
 * Session runner subprocess.
 *
 * Spawned by the Electron main process — one per tab. Talks NDJSON over its
 * own stdin/stdout. Owns a single Claude Agent SDK `query()` for the lifetime
 * of the session: an async generator feeds user turns into `query()`, the
 * Query async generator's yielded SDKMessages are forwarded to main, and a
 * `canUseTool` callback bridges permission prompts through main to the UI.
 */

import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type {
  MainToRunner,
  QuestionAnswer,
  QuestionOption,
  QuestionPrompt,
  RunnerToMain,
  RunnerStartOptions
} from '../shared/protocol'

// stderr is reserved for diagnostics that main process can choose to log.
const log = (...args: unknown[]): void => console.error('[runner]', ...args)

function send(msg: RunnerToMain): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

// ---------------------------------------------------------------------------
// Async-iterable user-turn queue.
// query() expects an AsyncIterable<SDKUserMessage>. We push to it via stdin.
// ---------------------------------------------------------------------------

type UserTurn = {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
}

class UserTurnQueue implements AsyncIterable<UserTurn> {
  private buffer: UserTurn[] = []
  private resolveNext: ((value: IteratorResult<UserTurn>) => void) | null = null
  private done = false

  push(text: string): void {
    const msg = {
      type: 'user' as const,
      message: { role: 'user' as const, content: text },
      parent_tool_use_id: null
    }
    if (this.resolveNext) {
      const r = this.resolveNext
      this.resolveNext = null
      r({ value: msg, done: false })
    } else {
      this.buffer.push(msg)
    }
  }

  end(): void {
    this.done = true
    if (this.resolveNext) {
      const r = this.resolveNext
      this.resolveNext = null
      r({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<UserTurn> {
    return {
      next: (): Promise<IteratorResult<UserTurn>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false })
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true })
        }
        return new Promise((resolve) => {
          this.resolveNext = resolve
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pending permission requests — main responds with `permissionResponse`.
// ---------------------------------------------------------------------------

// Track the original `input` alongside the resolver: the SDK's PermissionResult
// allow arm requires `updatedInput` (Record<string, unknown>), and we echo the
// original through unchanged since the UI doesn't expose an edit-input flow.
const pendingApprovals = new Map<
  string,
  { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
>()

function requestPermission(
  toolName: string,
  input: Record<string, unknown>,
  meta: {
    title?: string
    description?: string
    displayName?: string
    blockedPath?: string
    decisionReason?: string
    toolUseID: string
  }
): Promise<PermissionResult> {
  const id = randomUUID()
  return new Promise<PermissionResult>((resolve) => {
    pendingApprovals.set(id, { resolve, input })
    send({
      type: 'permissionRequest',
      id,
      toolName,
      input,
      title: meta.title,
      description: meta.description,
      displayName: meta.displayName,
      blockedPath: meta.blockedPath,
      decisionReason: meta.decisionReason,
      toolUseID: meta.toolUseID
    })
  })
}

// ---------------------------------------------------------------------------
// Pending AskUserQuestion prompts — main responds with `questionResponse`
// once the renderer has collected the user's selection. `null` answers means
// the user dismissed/cancelled the dialog.
// ---------------------------------------------------------------------------

const pendingQuestions = new Map<string, (answers: QuestionAnswer[] | null) => void>()

function requestUserQuestion(
  questions: QuestionPrompt[],
  toolUseID: string
): Promise<QuestionAnswer[] | null> {
  const id = randomUUID()
  return new Promise<QuestionAnswer[] | null>((resolve) => {
    pendingQuestions.set(id, resolve)
    send({ type: 'askUserQuestion', id, toolUseID, questions })
  })
}

/**
 * Best-effort coercion of an arbitrary `tool_use.input` (the model can
 * sometimes drop fields) into the renderer-facing `QuestionPrompt[]` shape.
 * Returns `null` when the input is too malformed to ask anything useful.
 */
function parseAskUserQuestionInput(input: Record<string, unknown>): QuestionPrompt[] | null {
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw) || raw.length === 0) return null
  const parsed: QuestionPrompt[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const obj = q as Record<string, unknown>
    const question = typeof obj.question === 'string' ? obj.question : ''
    const header = typeof obj.header === 'string' ? obj.header : ''
    const optsRaw = Array.isArray(obj.options) ? obj.options : []
    const options: QuestionOption[] = []
    for (const o of optsRaw) {
      if (!o || typeof o !== 'object') continue
      const oo = o as Record<string, unknown>
      if (typeof oo.label !== 'string') continue
      options.push({
        label: oo.label,
        description: typeof oo.description === 'string' ? oo.description : undefined,
        preview: typeof oo.preview === 'string' ? oo.preview : undefined
      })
    }
    if (!question || options.length === 0) continue
    parsed.push({
      question,
      header,
      multiSelect: obj.multiSelect === true,
      options
    })
  }
  return parsed.length > 0 ? parsed : null
}

/**
 * Format the user's answers into a plain-text string the model can consume
 * via the tool_result. Mirrors the structure the AskUserQuestion tool would
 * have returned natively. We deliver this via `behavior: 'deny'` because the
 * SDK does not expose a way to synthesize an "allow + result" — denial is
 * the only escape hatch that lets us short-circuit the built-in handler
 * (which has no headless implementation) and still hand text to the model.
 */
function formatQuestionAnswers(questions: QuestionPrompt[], answers: QuestionAnswer[]): string {
  const lines: string[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const a = answers[i]
    lines.push(`Q: ${q.question}`)
    if (a && a.selectedLabels.length > 0) {
      lines.push(`A: ${a.selectedLabels.join(', ')}`)
    } else {
      lines.push('A: (no selection)')
    }
    if (a?.notes) lines.push(`Notes: ${a.notes}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const userTurns = new UserTurnQueue()
const abortController = new AbortController()
let queryHandle: Awaited<ReturnType<typeof query>> | null = null
let started = false
let shuttingDown = false

async function runSession(
  initialPrompt: string | undefined,
  opts: RunnerStartOptions
): Promise<void> {
  // Seed the queue with the first user turn — when omitted (resume flow) the
  // SDK iterator just waits for the first message to arrive on stdin.
  if (initialPrompt) userTurns.push(initialPrompt)

  const sdkOptions: Options = {
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    model: opts.model,
    allowedTools: opts.allowedTools,
    additionalDirectories: opts.additionalDirectories,
    resume: opts.resume,
    // Linux/macOS only. Hard-fail when bwrap (or equivalent) is missing so
    // the user gets a clear error in the tab instead of silently running
    // unsandboxed. Auto-allow Bash because the sandbox already cages it —
    // permission prompts in that mode are pure friction.
    sandbox: opts.sandbox
      ? {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true
        }
      : undefined,
    abortController,
    canUseTool: async (toolName, input, callbackOpts) => {
      // AskUserQuestion: built-in tool whose CLI implementation expects a
      // terminal UI — there is no host renderer in headless SDK mode. We
      // intercept here, render the question in our own UI, and surface the
      // user's answers back to the model via a deny-with-message tool_result
      // (the only injection point the SDK gives us short of running the real
      // tool). Marked is_error in the result, but the model reads the content.
      if (toolName === 'AskUserQuestion') {
        const questions = parseAskUserQuestionInput(input)
        if (!questions) {
          return { behavior: 'deny', message: 'AskUserQuestion: malformed input' }
        }
        const answers = await requestUserQuestion(questions, callbackOpts.toolUseID)
        if (!answers) {
          return { behavior: 'deny', message: 'User dismissed the question without answering.' }
        }
        return { behavior: 'deny', message: formatQuestionAnswers(questions, answers) }
      }
      return requestPermission(toolName, input, {
        title: callbackOpts.title,
        description: callbackOpts.description,
        displayName: callbackOpts.displayName,
        blockedPath: callbackOpts.blockedPath,
        decisionReason: callbackOpts.decisionReason,
        toolUseID: callbackOpts.toolUseID
      })
    }
  }

  // The SDK's query() returns a Query object that's also an async generator.
  // Its `prompt` is our async-iterable queue, which keeps the session open
  // for follow-up turns.
  queryHandle = query({
    // SDKUserMessage shape — cast loosely to avoid pulling in MessageParam types.
    prompt: userTurns as unknown as Parameters<typeof query>[0]['prompt'],
    options: sdkOptions
  })

  send({ type: 'ready' })

  // Fire-and-forget: ask the SDK for the slash commands available in this
  // session (built-ins + skills + plugin commands) and forward them to main.
  // initializationResult() resolves once the underlying claude process has
  // finished its handshake; this can race the first user turn but doesn't block.
  ;(async () => {
    try {
      const commands = await queryHandle!.supportedCommands()
      send({
        type: 'commands',
        commands: commands.map((c) => ({
          name: c.name,
          description: c.description,
          argumentHint: c.argumentHint,
          aliases: c.aliases
        }))
      })
    } catch (e) {
      log('supportedCommands failed', e)
    }
  })()

  try {
    for await (const sdkMessage of queryHandle) {
      send({ type: 'sdkMessage', message: sdkMessage })
    }
    send({ type: 'exit', reason: 'completed' })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const message = err instanceof Error ? err.message : String(err)
    // Intentional aborts (user interrupt, /clear, app shutdown) are not errors.
    const isAbort =
      shuttingDown ||
      abortController.signal.aborted ||
      name === 'AbortError' ||
      /aborted by user/i.test(message)
    if (!isAbort) {
      send({ type: 'error', message: `${name}: ${message}`, fatal: true })
    }
    send({ type: 'exit', reason: isAbort ? 'aborted' : 'error' })
  } finally {
    process.exit(0)
  }
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: MainToRunner
  try {
    msg = JSON.parse(line) as MainToRunner
  } catch (e) {
    log('failed to parse stdin line:', line, e)
    return
  }

  switch (msg.type) {
    case 'start': {
      if (started) {
        log('duplicate start ignored')
        return
      }
      started = true
      runSession(msg.prompt, msg.options).catch((e) => {
        log('runSession crashed', e)
        process.exit(1)
      })
      return
    }
    case 'userMessage': {
      userTurns.push(msg.text)
      return
    }
    case 'permissionResponse': {
      const pending = pendingApprovals.get(msg.id)
      if (!pending) {
        log('unknown permission id', msg.id)
        return
      }
      pendingApprovals.delete(msg.id)
      if (msg.decision === 'allow') {
        pending.resolve({ behavior: 'allow', updatedInput: pending.input })
      } else {
        pending.resolve({ behavior: 'deny', message: 'Denied by user' })
      }
      return
    }
    case 'questionResponse': {
      const resolve = pendingQuestions.get(msg.id)
      if (!resolve) {
        log('unknown question id', msg.id)
        return
      }
      pendingQuestions.delete(msg.id)
      resolve(msg.answers)
      return
    }
    case 'interrupt': {
      // Prefer the SDK's interrupt over kill — it cleans up in-flight tools.
      if (queryHandle && typeof queryHandle.interrupt === 'function') {
        queryHandle.interrupt().catch((e) => log('interrupt failed', e))
      } else {
        abortController.abort()
      }
      return
    }
    case 'shutdown': {
      shuttingDown = true
      userTurns.end()
      abortController.abort()
      // Allow the for-await loop to wind down gracefully.
      setTimeout(() => process.exit(0), 500)
      return
    }
  }
})

rl.on('close', () => {
  // stdin closed (parent died) → exit cleanly
  abortController.abort()
  process.exit(0)
})

process.on('uncaughtException', (e) => {
  log('uncaughtException', e)
  send({ type: 'error', message: String(e), fatal: true })
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  log('unhandledRejection', e)
  send({ type: 'error', message: String(e), fatal: true })
  process.exit(1)
})
