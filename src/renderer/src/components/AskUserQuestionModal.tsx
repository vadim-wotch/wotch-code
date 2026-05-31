import { useEffect, useState } from 'react'
import type { PendingQuestion, QuestionAnswer, QuestionPrompt } from '../../../shared/protocol'

interface Props {
  tabId: string
  request: PendingQuestion | undefined
}

// Per-question UI state. Selections are tracked as an ordered list of option
// indices so we preserve click order even when re-rendering. The custom slot
// is the "Other" entry (always offered, per the AskUserQuestion contract).
interface DraftAnswer {
  selectedIndexes: number[]
  customLabel: string
  customSelected: boolean
  notes: string
}

const OTHER_LABEL = 'Other'

function emptyDrafts(questions: QuestionPrompt[]): DraftAnswer[] {
  return questions.map(() => ({
    selectedIndexes: [],
    customLabel: '',
    customSelected: false,
    notes: ''
  }))
}

function toAnswers(questions: QuestionPrompt[], drafts: DraftAnswer[]): QuestionAnswer[] {
  return questions.map((q, qi) => {
    const d = drafts[qi]
    const labels: string[] = []
    for (const idx of d.selectedIndexes) {
      const opt = q.options[idx]
      if (opt) labels.push(opt.label)
    }
    if (d.customSelected && d.customLabel.trim().length > 0) labels.push(d.customLabel.trim())
    return {
      question: q.question,
      header: q.header,
      selectedLabels: labels,
      notes: d.notes.trim() ? d.notes.trim() : undefined
    }
  })
}

function isAnswered(question: QuestionPrompt, draft: DraftAnswer | undefined): boolean {
  if (!draft) return false
  if (draft.selectedIndexes.length > 0) return true
  if (draft.customSelected && draft.customLabel.trim().length > 0) return true
  // Single-select questions still allow "Other" as the lone choice; multi-
  // select requires at least one selection too. Same rule for both.
  void question
  return false
}

export default function AskUserQuestionModal({ tabId, request }: Props): React.JSX.Element | null {
  const questions = request?.questions
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() =>
    questions ? emptyDrafts(questions) : []
  )
  const [activeQ, setActiveQ] = useState(0)
  const [focusedOptIdx, setFocusedOptIdx] = useState<number | null>(null)

  // Reset draft state when the request id changes — otherwise stale answers
  // from the previous question carry over.
  useEffect(() => {
    if (!questions) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset drafts when the question request changes
    setDrafts(emptyDrafts(questions))
    setActiveQ(0)
    setFocusedOptIdx(null)
  }, [request?.id, questions])

  if (!request || !questions) return null
  if (drafts.length !== questions.length) return null
  const q = questions[activeQ]
  const draft = drafts[activeQ]
  if (!q || !draft) return null

  const updateDraft = (next: Partial<DraftAnswer>): void => {
    setDrafts((cur) => cur.map((d, i) => (i === activeQ ? { ...d, ...next } : d)))
  }

  const toggleOption = (idx: number): void => {
    if (q.multiSelect) {
      const has = draft.selectedIndexes.includes(idx)
      updateDraft({
        selectedIndexes: has
          ? draft.selectedIndexes.filter((i) => i !== idx)
          : [...draft.selectedIndexes, idx]
      })
    } else {
      // Single-select: replace, and clear "Other" so we don't end up with two
      // selections.
      updateDraft({ selectedIndexes: [idx], customSelected: false })
    }
    setFocusedOptIdx(idx)
  }

  const toggleCustom = (): void => {
    if (q.multiSelect) {
      updateDraft({ customSelected: !draft.customSelected })
    } else {
      updateDraft({ customSelected: true, selectedIndexes: [] })
    }
    setFocusedOptIdx(-1)
  }

  const allAnswered = questions.every((qq, i) => isAnswered(qq, drafts[i]))

  const submit = (): void => {
    window.api.answerQuestion(tabId, request.id, toAnswers(questions, drafts))
  }
  const cancel = (): void => {
    window.api.answerQuestion(tabId, request.id, null)
  }

  const focusedOpt =
    focusedOptIdx === null
      ? null
      : focusedOptIdx === -1
        ? null // "Other" has no model-provided preview
        : (q.options[focusedOptIdx] ?? null)

  const hasAnyPreview = q.options.some((o) => o.preview)

  return (
    <div className="modal-backdrop">
      <div className={`modal modal--question ${hasAnyPreview ? 'modal--question-wide' : ''}`}>
        {questions.length > 1 && (
          <div className="question__pager">
            {questions.map((qq, i) => (
              <button
                key={i}
                type="button"
                className={`question__pager-chip ${i === activeQ ? 'question__pager-chip--active' : ''} ${
                  isAnswered(qq, drafts[i]) ? 'question__pager-chip--done' : ''
                }`}
                onClick={() => {
                  setActiveQ(i)
                  setFocusedOptIdx(null)
                }}
                title={qq.question}
              >
                {qq.header || `Q${i + 1}`}
              </button>
            ))}
          </div>
        )}

        <div className="question__title">{q.question}</div>
        {q.multiSelect && <div className="question__hint">Select one or more.</div>}

        <div className="question__layout">
          <div className="question__options">
            {q.options.map((opt, i) => {
              const selected = draft.selectedIndexes.includes(i)
              return (
                <button
                  key={i}
                  type="button"
                  className={`question__option ${selected ? 'question__option--selected' : ''}`}
                  onClick={() => toggleOption(i)}
                  onMouseEnter={() => setFocusedOptIdx(i)}
                  onFocus={() => setFocusedOptIdx(i)}
                >
                  <div className="question__option-marker">
                    {q.multiSelect ? (selected ? '☑' : '☐') : selected ? '●' : '○'}
                  </div>
                  <div className="question__option-body">
                    <div className="question__option-label">{opt.label}</div>
                    {opt.description && (
                      <div className="question__option-desc">{opt.description}</div>
                    )}
                  </div>
                </button>
              )
            })}

            {/* Free-text "Other" — always offered. */}
            <div
              className={`question__option question__option--other ${
                draft.customSelected ? 'question__option--selected' : ''
              }`}
              onMouseEnter={() => setFocusedOptIdx(-1)}
            >
              <button
                type="button"
                className="question__option-marker question__option-marker--btn"
                onClick={toggleCustom}
                aria-label="Toggle Other"
              >
                {q.multiSelect
                  ? draft.customSelected
                    ? '☑'
                    : '☐'
                  : draft.customSelected
                    ? '●'
                    : '○'}
              </button>
              <div className="question__option-body">
                <div className="question__option-label">{OTHER_LABEL}</div>
                <input
                  className="question__custom-input"
                  type="text"
                  placeholder="Type your own answer…"
                  value={draft.customLabel}
                  onChange={(e) => {
                    updateDraft({
                      customLabel: e.target.value,
                      customSelected: e.target.value.length > 0 ? true : draft.customSelected
                    })
                  }}
                  onFocus={() => setFocusedOptIdx(-1)}
                />
              </div>
            </div>
          </div>

          {hasAnyPreview && (
            <div className="question__preview">
              {focusedOpt?.preview ? (
                <pre className="question__preview-pre">{focusedOpt.preview}</pre>
              ) : (
                <div className="question__preview-empty">Hover an option to preview.</div>
              )}
            </div>
          )}
        </div>

        <div className="question__notes">
          <label className="question__notes-label" htmlFor={`q-notes-${activeQ}`}>
            Notes (optional)
          </label>
          <textarea
            id={`q-notes-${activeQ}`}
            className="question__notes-input"
            rows={2}
            value={draft.notes}
            onChange={(e) => updateDraft({ notes: e.target.value })}
            placeholder="Add anything Claude should know about this choice."
          />
        </div>

        <div className="modal__actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          {questions.length > 1 && activeQ < questions.length - 1 && (
            <button
              className="btn"
              disabled={!isAnswered(q, draft)}
              onClick={() => {
                setActiveQ(activeQ + 1)
                setFocusedOptIdx(null)
              }}
            >
              Next
            </button>
          )}
          <button className="btn btn--primary" disabled={!allAnswered} onClick={submit}>
            Send answers
          </button>
        </div>
      </div>
    </div>
  )
}
