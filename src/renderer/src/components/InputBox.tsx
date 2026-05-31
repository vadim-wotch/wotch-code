import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SlashCommand } from '../../../shared/protocol'

interface Props {
  tabId: string
  disabled: boolean
  hint?: string
  commands: SlashCommand[]
  onSend: (text: string) => void
}

// Returns the command-prefix the user is currently typing (without leading
// slash) when the popover should be open, or null otherwise. We only show the
// popover when the cursor is inside the first token AND the line begins with `/`.
function activePrefix(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null
  // Only the first line counts; multi-line means user has moved past command-mode.
  const firstLineEnd = text.indexOf('\n')
  const lineLen = firstLineEnd === -1 ? text.length : firstLineEnd
  if (caret > lineLen) return null
  // First space ends the command name; after that we're typing args, not a name.
  const firstSpace = text.indexOf(' ')
  const nameEnd = firstSpace === -1 ? lineLen : firstSpace
  if (caret > nameEnd) return null
  return text.slice(1, caret)
}

export default function InputBox({
  tabId,
  disabled,
  hint,
  commands,
  onSend
}: Props): React.JSX.Element {
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const prefix = activePrefix(text, caret)
  const matches = useMemo(() => {
    if (prefix === null) return []
    const q = prefix.toLowerCase()
    return commands
      .filter((c) => {
        if (c.name.toLowerCase().startsWith(q)) return true
        if (c.aliases?.some((a) => a.toLowerCase().startsWith(q))) return true
        return false
      })
      .slice(0, 10)
  }, [prefix, commands])

  // Reset selection when the matches change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset highlighted match when the query changes
    setSelected(0)
  }, [prefix])

  const insertCommand = (cmd: SlashCommand): void => {
    // Replace the first token with /cmdname and put a trailing space so the
    // user can immediately type arguments. Preserve anything after the first
    // space (existing args).
    const firstSpace = text.indexOf(' ')
    const tail = firstSpace === -1 ? '' : text.slice(firstSpace)
    const next = `/${cmd.name}${tail || ' '}`
    setText(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      const pos = `/${cmd.name} `.length
      el.focus()
      el.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  const send = (): void => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
    setCaret(0)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const showingPalette = matches.length > 0
    if (showingPalette) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        insertCommand(matches[selected])
        return
      }
      if (e.key === 'Escape') {
        // Clear the active prefix so the popover hides — easiest is to move
        // caret past the command region by appending a space.
        e.preventDefault()
        setText(text + ' ')
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    setCaret((e.target as HTMLTextAreaElement).selectionStart)
  }

  return (
    <div className="input-box">
      <div className="input-box__field">
        {matches.length > 0 && (
          <div className="cmd-palette">
            <div className="cmd-palette__head">Commands</div>
            {matches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                className={`cmd-palette__row ${i === selected ? 'cmd-palette__row--sel' : ''}`}
                onMouseEnter={() => setSelected(i)}
                onMouseDown={(e) => {
                  // mousedown fires before blur, so we don't lose the textarea focus.
                  e.preventDefault()
                  insertCommand(c)
                }}
              >
                <span className="cmd-palette__name">/{c.name}</span>
                {c.argumentHint && <span className="cmd-palette__hint">{c.argumentHint}</span>}
                <span className="cmd-palette__desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="input-box__textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onKeyDown={onKey}
          onKeyUp={onSelect}
          onClick={onSelect}
          onSelect={onSelect}
          placeholder={
            hint ??
            'Type a message — / for commands, ! for shell, Enter to send, Shift+Enter for newline'
          }
          rows={2}
        />
      </div>
      <div className="input-box__actions">
        <button
          className="btn"
          onClick={() => window.api.abort(tabId)}
          title="Interrupt this session"
        >
          Interrupt
        </button>
        <button className="btn btn--primary" onClick={send} disabled={disabled || !text.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}
