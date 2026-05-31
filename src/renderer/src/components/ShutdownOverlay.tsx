interface Props {
  total: number
  remaining: number
}

export default function ShutdownOverlay({ total, remaining }: Props): React.JSX.Element {
  const closed = Math.max(0, total - remaining)
  const pct = total > 0 ? Math.min(100, Math.round((closed / total) * 100)) : 100
  return (
    <div className="shutdown" role="status" aria-live="polite">
      <div className="shutdown__card">
        <div className="shutdown__title">Closing sessions</div>
        <div className="shutdown__sub">
          {closed} of {total} closed · {remaining > 0 ? 'shutting down runners…' : 'finalizing…'}
        </div>
        <div className="shutdown__bar">
          <div className="shutdown__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="shutdown__dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  )
}
