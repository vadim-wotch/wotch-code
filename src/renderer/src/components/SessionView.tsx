import { useEffect, useRef, useState } from 'react'
import { CLIENT_SLASH_COMMANDS } from '../../../shared/protocol'
import type { TabState } from '../state/tabs'
import ApprovalModal from './ApprovalModal'
import AskUserQuestionModal from './AskUserQuestionModal'
import InputBox from './InputBox'
import MessageList from './MessageList'
import Splitter from './Splitter'

interface Props {
  tab: TabState
  onOpenResume: () => void
}

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  starting: 'starting…',
  streaming: 'streaming',
  awaiting_user: 'ready',
  awaiting_approval: 'waiting for approval',
  awaiting_question: 'waiting for answer',
  done: 'done',
  error: 'error',
  aborted: 'aborted',
  exited: 'exited'
}

const INPUT_H_KEY = 'hb.inputHeight.v1'
const DEFAULT_INPUT_H = 120
const MIN_INPUT_H = 64
const MAX_INPUT_H_RATIO = 0.7 // input can take at most 70% of the session column

function loadInputHeight(): number {
  try {
    const v = Number(localStorage.getItem(INPUT_H_KEY))
    return Number.isFinite(v) && v >= MIN_INPUT_H ? v : DEFAULT_INPUT_H
  } catch {
    return DEFAULT_INPUT_H
  }
}

export default function SessionView({ tab, onOpenResume }: Props): React.JSX.Element {
  const status = tab.meta.status
  const inputDisabled =
    status === 'starting' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_question' ||
    status === 'exited' ||
    status === 'error'

  const progressActive = status === 'streaming' || status === 'starting'
  const pendingApproval = tab.pendingApprovals[0]
  const pendingQuestion = tab.pendingQuestions[0]

  const [inputH, setInputH] = useState<number>(loadInputHeight)
  const startHRef = useRef<number>(inputH)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Re-clamp on container resize so the splitter never traps the user with an
  // input that's eaten the whole window.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const max = Math.max(MIN_INPUT_H, el.clientHeight * MAX_INPUT_H_RATIO)
      setInputH((cur) => Math.min(cur, max))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="session" ref={containerRef}>
      <div className="session__header" style={{ borderColor: tab.meta.color }}>
        <div className="session__title">
          <span className="session__color-dot" style={{ background: tab.meta.color }} />
          <span className="session__name">{tab.meta.name}</span>
          {tab.meta.sandbox && (
            <span
              className="session__sandbox"
              title="Tool calls run in the SDK sandbox (filesystem + network restricted)"
            >
              🔒 sandboxed
            </span>
          )}
          <span className="session__meta">{tab.meta.cwd}</span>
        </div>
        <div className="session__status">
          <span className="session__status-label">{STATUS_LABEL[status] ?? status}</span>
          {tab.meta.sessionId && (
            <span className="session__sid" title="session id">
              {tab.meta.sessionId.slice(0, 8)}
            </span>
          )}
        </div>
        <div
          className={`progress ${progressActive ? 'progress--active' : ''}`}
          style={{ ['--progress-color' as string]: tab.meta.color }}
        />
      </div>

      <MessageList log={tab.log} />

      <Splitter
        onStart={() => {
          startHRef.current = inputH
        }}
        onDrag={(dy) => {
          const max = (containerRef.current?.clientHeight ?? 1000) * MAX_INPUT_H_RATIO
          const next = Math.max(MIN_INPUT_H, Math.min(max, startHRef.current - dy))
          setInputH(next)
        }}
        onEnd={() => {
          try {
            localStorage.setItem(INPUT_H_KEY, String(inputH))
          } catch {
            // ignore
          }
        }}
      />

      <div className="session__input" style={{ height: inputH }}>
        <InputBox
          tabId={tab.meta.id}
          disabled={inputDisabled}
          commands={[...CLIENT_SLASH_COMMANDS, ...tab.commands]}
          hint={
            status === 'awaiting_approval'
              ? 'Resolve the approval to continue.'
              : status === 'awaiting_question'
                ? 'Answer the question to continue.'
                : status === 'streaming'
                  ? 'Claude is working. Type a message to queue, or interrupt.'
                  : undefined
          }
          onSend={(text) => {
            // Intercept client-side commands the CLI handles locally — they
            // never go to the SDK.
            const t = text.trim()
            // ! prefix: run as shell on the session host. Output is local-
            // only; Claude's context is unchanged.
            if (t.startsWith('!')) {
              const cmd = t.slice(1).trim()
              if (cmd) window.api.runShell(tab.meta.id, cmd)
              return
            }
            const rename = /^\/(rename|name)\s+(.+)$/.exec(t)
            if (rename) {
              window.api.renameTab(tab.meta.id, rename[2].trim())
              return
            }
            if (/^\/clear\b/i.test(t)) {
              window.api.clearTab(tab.meta.id)
              return
            }
            if (/^\/resume\b/i.test(t)) {
              onOpenResume()
              return
            }
            window.api.sendMessage(tab.meta.id, text)
          }}
        />
      </div>

      <ApprovalModal tabId={tab.meta.id} request={pendingApproval} />
      <AskUserQuestionModal
        key={pendingQuestion?.id ?? 'none'}
        tabId={tab.meta.id}
        request={pendingQuestion}
      />
    </div>
  )
}
