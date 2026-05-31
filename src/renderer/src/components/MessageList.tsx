import { useEffect, useMemo, useRef } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import Anser from 'anser'
import type { LogEntry, SdkAssistantContentBlock } from '../../../shared/protocol'
import ToolUseCard from './ToolUseCard'

function AnsiText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const tokens = useMemo(
    () => Anser.ansiToJson(text, { use_classes: true, remove_empty: true }),
    [text]
  )
  return (
    <pre className={className}>
      {tokens.map((tok, i) => {
        const cls = [tok.fg, tok.bg, ...(tok.decorations ?? [])].filter(Boolean).join(' ')
        return cls ? (
          <span key={i} className={cls}>
            {tok.content}
          </span>
        ) : (
          <span key={i}>{tok.content}</span>
        )
      })}
    </pre>
  )
}

interface Props {
  log: LogEntry[]
}

interface AssistantBlockEntry {
  kind: 'assistant'
  id: string
  blocks: SdkAssistantContentBlock[]
}

function isAssistantEntry(e: LogEntry): e is AssistantBlockEntry {
  return e.kind === 'assistant'
}

interface ToolResultEntry {
  kind: 'tool_result'
  id: string
  content: unknown
  isError?: boolean
}

function isToolResultEntry(e: LogEntry): e is ToolResultEntry {
  return e.kind === 'tool_result'
}

export default function MessageList({ log }: Props): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const prevLenRef = useRef(0)

  // Build a quick lookup of tool_use_id → result, so tool-use blocks can show their output inline.
  const resultByToolId = useMemo(() => {
    const map = new Map<string, ToolResultEntry>()
    for (const e of log) {
      if (isToolResultEntry(e)) map.set(e.id, e)
    }
    return map
  }, [log])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    // First time we render any entries (open a fresh session, resume a
    // managed one, or pop into an external transcript): force pin so the
    // user lands on the latest message instead of the top of the history.
    // After that, only pin if the user is already near the bottom.
    const firstFill = prevLenRef.current === 0 && log.length > 0
    prevLenRef.current = log.length
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (firstFill || nearBottom) el.scrollTop = el.scrollHeight
  }, [log])

  return (
    <div className="message-list" ref={scrollerRef}>
      {log.map((entry, i) => {
        if (entry.kind === 'tool_result') return null // rendered inside the tool_use card
        if (isAssistantEntry(entry)) {
          return (
            <div className="msg msg--assistant" key={entry.id}>
              {entry.blocks.map((b, bi) => {
                if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
                  return (
                    <div className="msg__text markdown" key={bi}>
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                      >
                        {(b as { text: string }).text}
                      </Markdown>
                    </div>
                  )
                }
                if (b.type === 'tool_use') {
                  const tu = b as { id: string; name: string; input: Record<string, unknown> }
                  const r = resultByToolId.get(tu.id)
                  return (
                    <ToolUseCard
                      key={tu.id}
                      name={tu.name}
                      toolUseId={tu.id}
                      input={tu.input}
                      result={r ? { content: r.content, isError: r.isError } : undefined}
                    />
                  )
                }
                if (
                  b.type === 'thinking' &&
                  typeof (b as { thinking?: unknown }).thinking === 'string'
                ) {
                  const t = (b as unknown as { thinking: string }).thinking
                  return (
                    <div className="msg__thinking" key={bi}>
                      <em>thinking</em>
                      <pre>{t}</pre>
                    </div>
                  )
                }
                return null
              })}
            </div>
          )
        }
        if (entry.kind === 'user') {
          return (
            <div className="msg msg--user" key={entry.id}>
              {entry.text}
            </div>
          )
        }
        if (entry.kind === 'system') {
          return (
            <div className="msg msg--system" key={entry.id}>
              {entry.text}
            </div>
          )
        }
        if (entry.kind === 'error') {
          return (
            <div className="msg msg--error" key={entry.id}>
              {entry.text}
            </div>
          )
        }
        if (entry.kind === 'shell') {
          const status = entry.running
            ? 'running…'
            : entry.exitCode === 0
              ? 'exit 0'
              : `exit ${entry.exitCode ?? '?'}`
          const failed = !entry.running && entry.exitCode !== 0
          return (
            <div className={`msg msg--shell ${failed ? 'msg--shell-failed' : ''}`} key={entry.id}>
              <div className="msg__shell-head">
                <span className="msg__shell-prompt">$</span>
                <span className="msg__shell-cmd">{entry.command}</span>
                <span className="msg__shell-status">{status}</span>
              </div>
              {entry.output && <AnsiText className="msg__shell-output" text={entry.output} />}
            </div>
          )
        }
        if (entry.kind === 'result') {
          const cost = entry.costUsd != null ? `$${entry.costUsd.toFixed(4)}` : ''
          const dur = entry.durationMs != null ? `${(entry.durationMs / 1000).toFixed(1)}s` : ''
          return (
            <div
              className={`msg msg--result ${entry.isError ? 'msg--error' : ''}`}
              key={`${entry.id}-${i}`}
            >
              <span className="msg__label">turn complete</span> {entry.summary} · {dur} {cost}
            </div>
          )
        }
        return null
      })}
    </div>
  )
}
