import { app, BrowserWindow, ipcMain, Menu, shell, dialog } from 'electron'
import { join, sep } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  listSessions as sdkListSessions,
  deleteSession as sdkDeleteSession
} from '@anthropic-ai/claude-agent-sdk'
import icon from '../../resources/icon.png?asset'
import { SessionManager, type CreateTabInput } from './session-manager'
import { ExternalSessionTracker } from './external-tracker'
import {
  installNotificationHook,
  isNotificationHookInstalled,
  uninstallNotificationHook
} from './notification-hook'
import { IPC, type QuestionAnswer, type SessionListItem } from '../shared/protocol'

// In packaged builds, __dirname lives inside app.asar — unreadable by plain
// Node, which the WSL host relies on. asarUnpack mirrors the file to
// app.asar.unpacked; redirect to the on-disk twin so both hosts work. In dev
// the path has no app.asar segment, so this is a no-op.
const runnerScript = join(__dirname, 'runner.js').replace(
  `${sep}app.asar${sep}`,
  `${sep}app.asar.unpacked${sep}`
)
const sessions = new SessionManager(runnerScript)

let mainWindow: BrowserWindow | null = null

const externalTracker = new ExternalSessionTracker({
  // Accessing `.webContents` on a destroyed window throws ("Object has been
  // destroyed"); `?.` only guards null, so check isDestroyed() first. This is
  // hit during quit, when disable() broadcasts after the window is torn down.
  getWebContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
  getManagedSessionIds: () => sessions.getManagedSessionIds()
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    title: 'WotchCode',
    backgroundColor: '#0b0d10',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (mainWindow) sessions.attach(mainWindow.webContents)
  })

  // Zoom in main (Chromium's native zoom intercepts before the renderer).
  // Factor-based (1.0 = default) for smooth 10% steps; level-based steps would
  // jump 20% at a time.
  const ZOOM_STEP = 0.1
  const ZOOM_MIN = 0.5
  const ZOOM_MAX = 2.5
  const round = (n: number): number => Math.round(n * 100) / 100
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (!(input.control || input.meta) || input.alt) return
    if (!mainWindow) return
    const wc = mainWindow.webContents
    const k = input.key
    let next: number | null = null
    if (k === '=' || k === '+') {
      next = round(Math.min(ZOOM_MAX, wc.getZoomFactor() + ZOOM_STEP))
    } else if (k === '-' || k === '_') {
      next = round(Math.max(ZOOM_MIN, wc.getZoomFactor() - ZOOM_STEP))
    } else if (input.shift && k === '0') {
      next = 1
    }
    if (next !== null) {
      event.preventDefault()
      wc.setZoomFactor(next)
      wc.send('zoom.changed', next)
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setName('WotchCode')
  electronApp.setAppUserModelId('com.wotchcode')

  // Kill the default app menu. Electron's auto-generated "View" menu binds
  // Ctrl+0 / Ctrl+= / Ctrl+- to zoom controls, eating our Ctrl+0 hotkey
  // before it ever reaches the renderer.
  Menu.setApplicationMenu(null)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // -------- IPC -----------------------------------------------------------
  ipcMain.handle(IPC.listHosts, () => sessions.listHosts())

  ipcMain.handle(IPC.createTab, async (_e, input: CreateTabInput) => {
    return await sessions.createTab(input)
  })

  ipcMain.handle(IPC.sendMessage, (_e, tabId: string, text: string) => {
    sessions.sendUserMessage(tabId, text)
  })

  ipcMain.handle(
    IPC.approve,
    (_e, tabId: string, requestId: string, decision: 'allow' | 'deny', remember?: boolean) => {
      sessions.approve(tabId, requestId, decision, remember)
    }
  )

  ipcMain.handle(
    IPC.answerQuestion,
    (_e, tabId: string, requestId: string, answers: QuestionAnswer[] | null) => {
      sessions.answerQuestion(tabId, requestId, answers)
    }
  )

  ipcMain.handle(IPC.abort, (_e, tabId: string) => {
    sessions.abort(tabId)
  })

  ipcMain.handle(IPC.runShell, (_e, tabId: string, command: string) => {
    sessions.runShellCommand(tabId, command)
  })

  ipcMain.handle(IPC.closeTab, (_e, tabId: string) => {
    sessions.closeTab(tabId)
  })

  ipcMain.handle(IPC.renameTab, async (_e, tabId: string, name: string) => {
    await sessions.renameTab(tabId, name)
  })

  ipcMain.handle(IPC.clearTab, async (_e, tabId: string) => {
    await sessions.clearTab(tabId)
  })

  ipcMain.handle(IPC.pickDirectory, async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })

  ipcMain.handle(IPC.deleteSession, async (_e, sessionId: string, dir?: string) => {
    try {
      await sdkDeleteSession(sessionId, dir ? { dir } : undefined)
      return { ok: true as const }
    } catch (e) {
      console.error('deleteSession failed', e)
      return { ok: false as const, error: String(e) }
    }
  })

  ipcMain.handle(IPC.setExternalEnabled, async (_e, on: boolean) => {
    if (on) {
      await externalTracker.enable()
    } else {
      externalTracker.disable()
    }
  })

  ipcMain.handle(IPC.getExternalTranscript, async (_e, sessionId: string) => {
    return externalTracker.readTranscript(sessionId)
  })

  ipcMain.handle(IPC.getAttentionHook, async () => {
    return { installed: await isNotificationHookInstalled() }
  })

  ipcMain.handle(IPC.setAttentionHook, async (_e, on: boolean) => {
    try {
      if (on) await installNotificationHook()
      else await uninstallNotificationHook()
      return { ok: true as const, installed: on }
    } catch (e) {
      console.error('setAttentionHook failed', e)
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(IPC.takeOverExternal, async (_e, sessionId: string) => {
    const entry = externalTracker.getEntry(sessionId)
    if (!entry) {
      return { ok: false as const, error: 'External session no longer tracked' }
    }
    try {
      const tab = await sessions.takeOverExternal({
        sessionId: entry.sessionId,
        hostId: entry.hostId,
        cwd: entry.cwd,
        pid: entry.pid,
        jsonlPath: entry.jsonlPath,
        name: entry.customTitle || entry.summary || entry.firstPrompt?.slice(0, 40)
      })
      externalTracker.removeBySessionId(sessionId)
      return { ok: true as const, tab }
    } catch (e) {
      console.error('takeOverExternal failed', e)
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle(
    IPC.listSessions,
    async (_e, opts?: { dir?: string; limit?: number }): Promise<SessionListItem[]> => {
      try {
        const items = await sdkListSessions({
          dir: opts?.dir,
          limit: opts?.limit ?? 100
        })
        return items.map((s) => ({
          sessionId: s.sessionId,
          summary: s.summary,
          customTitle: s.customTitle,
          firstPrompt: s.firstPrompt,
          cwd: s.cwd,
          gitBranch: s.gitBranch,
          lastModified: s.lastModified,
          createdAt: s.createdAt
        }))
      } catch (e) {
        console.error('listSessions failed', e)
        return []
      }
    }
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let isShuttingDown = false
app.on('before-quit', async (e) => {
  if (isShuttingDown) return
  externalTracker.disable()
  if (sessions.activeCount() === 0) return
  isShuttingDown = true
  e.preventDefault()
  // Tell the renderer to render the closing overlay; counts down via the
  // existing `tab_closed` events as each runner actually exits.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app.shutdown', { total: sessions.activeCount() })
  }
  await sessions.shutdownAll()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
