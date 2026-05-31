import { useState } from 'react'

interface Props {
  name: string
  toolUseId: string
  input: Record<string, unknown>
  result?: { content: unknown; isError?: boolean }
}

function summarize(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') return input.command as string
  if (typeof input.file_path === 'string') return input.file_path as string
  if (typeof input.path === 'string') return input.path as string
  if (typeof input.pattern === 'string') return input.pattern as string
  if (name === 'AskUserQuestion') {
    const qs = (input as { questions?: unknown }).questions
    if (Array.isArray(qs) && qs.length > 0) {
      const first = qs[0] as { question?: unknown }
      const text = typeof first?.question === 'string' ? first.question : ''
      return qs.length > 1 ? `${text} (+${qs.length - 1} more)` : text
    }
  }
  return ''
}

interface AskUserQuestionShape {
  questions: Array<{
    question: string
    header?: string
    multiSelect?: boolean
    options: Array<{ label: string; description?: string }>
  }>
}

function asAskUserQuestionInput(input: Record<string, unknown>): AskUserQuestionShape | null {
  const qs = (input as { questions?: unknown }).questions
  if (!Array.isArray(qs)) return null
  const ok = qs.every(
    (q) =>
      q &&
      typeof q === 'object' &&
      typeof (q as { question?: unknown }).question === 'string' &&
      Array.isArray((q as { options?: unknown }).options)
  )
  return ok ? (input as unknown as AskUserQuestionShape) : null
}

function AskUserQuestionInput({ input }: { input: AskUserQuestionShape }): React.JSX.Element {
  return (
    <div className="auq-input">
      {input.questions.map((q, qi) => (
        <div className="auq-input__q" key={qi}>
          <div className="auq-input__question">
            {q.header && <span className="auq-input__header">{q.header}</span>}
            <span>{q.question}</span>
            {q.multiSelect && <span className="auq-input__badge">multi</span>}
          </div>
          <ul className="auq-input__options">
            {q.options.map((opt, oi) => (
              <li className="auq-input__option" key={oi}>
                <span className="auq-input__option-label">{opt.label}</span>
                {opt.description && (
                  <span className="auq-input__option-desc"> — {opt.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function renderResult(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .join('')
  }
  return JSON.stringify(content, null, 2)
}

export default function ToolUseCard({ name, input, result }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = summarize(name, input)
  const pending = !result
  // AskUserQuestion comes back via canUseTool deny-with-message — the SDK
  // tags that as is_error, but for this tool the "error" content is just
  // the user's answer. Render it as a normal answer instead.
  const isAskUserQuestion = name === 'AskUserQuestion'
  const showAsError = !!result?.isError && !isAskUserQuestion
  const statusLabel = pending
    ? '…'
    : showAsError
      ? 'error'
      : isAskUserQuestion && result
        ? 'answered'
        : 'ok'
  return (
    <div className={`tool ${pending ? 'tool--pending' : ''} ${showAsError ? 'tool--error' : ''}`}>
      <button className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__chevron">{open ? '▾' : '▸'}</span>
        <span className="tool__name">{name}</span>
        <span className="tool__summary">{summary}</span>
        <span className="tool__status">{statusLabel}</span>
      </button>
      {open && (
        <div className="tool__body">
          <div className="tool__section">
            <div className="tool__label">{isAskUserQuestion ? 'questions' : 'input'}</div>
            {(() => {
              const auq = isAskUserQuestion ? asAskUserQuestionInput(input) : null
              return auq ? (
                <AskUserQuestionInput input={auq} />
              ) : (
                <pre className="tool__pre">{JSON.stringify(input, null, 2)}</pre>
              )
            })()}
          </div>
          {result && (
            <div className="tool__section">
              <div className="tool__label">
                {showAsError ? 'error' : isAskUserQuestion ? 'answer' : 'output'}
              </div>
              <pre className="tool__pre">{renderResult(result.content)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
