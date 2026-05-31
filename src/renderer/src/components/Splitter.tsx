import { useEffect, useRef } from 'react'

interface Props {
  onStart?: () => void
  /** Called continuously with dy delta from the drag-start point (positive = down). */
  onDrag: (dy: number) => void
  onEnd?: () => void
}

export default function Splitter({ onStart, onDrag, onEnd }: Props): React.JSX.Element {
  const startY = useRef<number | null>(null)
  const onStartRef = useRef(onStart)
  const onDragRef = useRef(onDrag)
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onStartRef.current = onStart
    onDragRef.current = onDrag
    onEndRef.current = onEnd
  })

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    startY.current = e.clientY
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    onStartRef.current?.()

    const move = (ev: MouseEvent): void => {
      if (startY.current == null) return
      onDragRef.current(ev.clientY - startY.current)
    }
    const up = (): void => {
      startY.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      onEndRef.current?.()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="horizontal"
      onMouseDown={onMouseDown}
      title="Drag to resize"
    >
      <div className="splitter__grip" />
    </div>
  )
}
