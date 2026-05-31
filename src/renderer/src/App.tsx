import { useEffect, useState } from 'react'
import Dashboard from './components/Dashboard'
import ExternalSessionView from './components/ExternalSessionView'
import NewTabModal from './components/NewTabModal'
import SessionView from './components/SessionView'
import ShutdownOverlay from './components/ShutdownOverlay'
import TabStrip from './components/TabStrip'
import { useTabsStore } from './state/tabs'
import { loadPinned, unpinSession } from './state/pinned'

const ZOOM_KEY = 'hb.zoomFactor.v1'

function loadZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY)
    if (!raw) return 1
    const v = Number(raw)
    return Number.isFinite(v) ? Math.max(0.5, Math.min(2.5, v)) : 1
  } catch {
    return 1
  }
}
function saveZoom(factor: number): void {
  try {
    localStorage.setItem(ZOOM_KEY, String(factor))
  } catch {
    // ignore
  }
}

function App(): React.JSX.Element {
  const {
    tabs,
    order,
    activeId,
    activeExternalId,
    external,
    setActive,
    setActiveExternal,
    applyEvent,
    setPinnedSessionIds
  } = useTabsStore()
  const [showNew, setShowNew] = useState(false)
  const [newMode, setNewMode] = useState<'new' | 'resume'>('new')
  const [zoomToast, setZoomToast] = useState<number | null>(null)
  const [shutdown, setShutdown] = useState<{ total: number } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    return window.api.onTabEvent(applyEvent)
  }, [applyEvent])

  useEffect(() => {
    return window.api.onShutdown((info) => setShutdown(info))
  }, [])

  // Restore pinned sessions on first mount.
  useEffect(() => {
    const pins = loadPinned()
    setPinnedSessionIds(new Set(pins.map((p) => p.sessionId)))
    if (pins.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time pinned-session restore on mount
    setRestoring(true)
    ;(async () => {
      for (const p of pins) {
        try {
          await window.api.createTab({
            hostId: p.hostId,
            name: p.name,
            color: p.color,
            cwd: p.cwd,
            permissionMode: p.permissionMode,
            model: p.model,
            resume: p.sessionId
          })
        } catch (e) {
          console.error('restore pinned failed', p.sessionId, e)
          // If the underlying session is gone, drop the pin so we don't keep retrying.
          unpinSession(p.sessionId)
          setPinnedSessionIds(new Set(loadPinned().map((x) => x.sessionId)))
        }
      }
      setRestoring(false)
    })()
  }, [setPinnedSessionIds])

  // Restore zoom factor on first mount, and listen for changes from main.
  // Surface a transient HUD on every change so the level is discoverable.
  useEffect(() => {
    window.api.setZoomFactor(loadZoom())
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onZoomChanged((factor) => {
      saveZoom(factor)
      setZoomToast(factor)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setZoomToast(null), 1100)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Global hotkeys. Capture phase so input/textarea handlers can't swallow them.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey || e.metaKey
      if (!ctrl || e.altKey) return

      // Zoom hotkeys live in main (before-input-event) — they need to run
      // before Chromium's native zoom intercepts.

      // Ctrl+Tab → next tab; Ctrl+Shift+Tab → previous. Cycles through:
      // [dashboard, tab1, tab2, ...] so you can land on Home from the keyboard too.
      if (e.key === 'Tab') {
        e.preventDefault()
        const positions: (string | null)[] = [null, ...order]
        const curIdx = positions.indexOf(activeId)
        const dir = e.shiftKey ? -1 : 1
        const next = positions[(curIdx + dir + positions.length) % positions.length]
        setActive(next)
        return
      }

      if (e.key === '0') {
        e.preventDefault()
        setActive(null)
        setActiveExternal(null)
        return
      }

      if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        setNewMode('new')
        setShowNew(true)
        return
      }

      if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1
        const id = order[idx]
        if (id) {
          e.preventDefault()
          setActive(id)
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [order, activeId, setActive, setActiveExternal])

  // Open the new-tab modal automatically when the app first launches with no
  // sessions AND no pinned ones to restore. Don't reopen later.
  const [autoOpened, setAutoOpened] = useState(false)
  useEffect(() => {
    if (autoOpened || restoring) return
    if (order.length === 0 && loadPinned().length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-open new-tab modal once when launching empty
      setShowNew(true)
      setAutoOpened(true)
    }
  }, [order.length, autoOpened, restoring])

  const active = activeId ? tabs[activeId] : undefined
  const activeExternal = activeExternalId ? external[activeExternalId] : undefined
  const openNew = (mode: 'new' | 'resume' = 'new'): void => {
    setNewMode(mode)
    setShowNew(true)
  }

  return (
    <div className="app">
      <TabStrip onNewTab={() => openNew('new')} />
      <div className="app__body">
        {active ? (
          <SessionView tab={active} onOpenResume={() => openNew('resume')} />
        ) : activeExternal ? (
          <ExternalSessionView
            info={activeExternal}
            onBack={() => setActiveExternal(null)}
            onTakenOver={(id) => setActive(id)}
          />
        ) : (
          <Dashboard onOpen={(id) => setActive(id)} onNewTab={() => openNew('new')} />
        )}
      </div>
      <NewTabModal
        open={showNew}
        initialMode={newMode}
        onClose={() => setShowNew(false)}
        onCreate={async (input) => {
          setShowNew(false)
          try {
            await window.api.createTab(input)
          } catch (e) {
            console.error('createTab failed', e)
            const msg = e instanceof Error ? e.message : String(e)
            // Strip the IPC handler prefix Electron adds.
            const clean = msg.replace(/^Error invoking remote method '[^']+':\s*/, '')
            window.alert(`Could not start session.\n\n${clean}`)
          }
        }}
      />
      {zoomToast !== null && (
        <div className="zoom-toast" key={zoomToast}>
          {Math.round(zoomToast * 100)}%
        </div>
      )}
      {shutdown && <ShutdownOverlay total={shutdown.total} remaining={order.length} />}
    </div>
  )
}

export default App
