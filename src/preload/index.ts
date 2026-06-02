import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type HostInfo,
  type LogEntry,
  type PermissionMode,
  type QuestionAnswer,
  type SessionListItem,
  type TabEvent,
  type TabMeta
} from '../shared/protocol'

// CreateTabInput lives in main/session-manager; redeclared here so the preload
// doesn't pull main-only modules into the renderer's type graph.
export interface CreateTabInputForRenderer {
  hostId: string
  name: string
  color: string
  cwd: string
  permissionMode: PermissionMode
  model?: string
  initialPrompt?: string
  /** Resume an on-disk session by ID instead of starting fresh. */
  resume?: string
}

const api = {
  listHosts: (): Promise<HostInfo[]> => ipcRenderer.invoke(IPC.listHosts),
  createTab: (input: CreateTabInputForRenderer): Promise<TabMeta> =>
    ipcRenderer.invoke(IPC.createTab, input),
  sendMessage: (tabId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sendMessage, tabId, text),
  approve: (
    tabId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    remember?: boolean
  ): Promise<void> => ipcRenderer.invoke(IPC.approve, tabId, requestId, decision, remember),
  answerQuestion: (
    tabId: string,
    requestId: string,
    answers: QuestionAnswer[] | null
  ): Promise<void> => ipcRenderer.invoke(IPC.answerQuestion, tabId, requestId, answers),
  abort: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.abort, tabId),
  runShell: (tabId: string, command: string): Promise<void> =>
    ipcRenderer.invoke(IPC.runShell, tabId, command),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.closeTab, tabId),
  renameTab: (tabId: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.renameTab, tabId, name),
  clearTab: (tabId: string): Promise<void> => ipcRenderer.invoke(IPC.clearTab, tabId),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickDirectory),
  listSessions: (opts?: { dir?: string; limit?: number }): Promise<SessionListItem[]> =>
    ipcRenderer.invoke(IPC.listSessions, opts),
  deleteSession: (
    sessionId: string,
    dir?: string
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.deleteSession, sessionId, dir),
  setExternalEnabled: (on: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.setExternalEnabled, on),
  takeOverExternal: (
    sessionId: string
  ): Promise<{ ok: true; tab: TabMeta } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.takeOverExternal, sessionId),
  getExternalTranscript: (sessionId: string): Promise<LogEntry[]> =>
    ipcRenderer.invoke(IPC.getExternalTranscript, sessionId),
  getAttentionHook: (): Promise<{ installed: boolean }> =>
    ipcRenderer.invoke(IPC.getAttentionHook),
  setAttentionHook: (
    on: boolean
  ): Promise<{ ok: true; installed: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.setAttentionHook, on),
  onTabEvent: (handler: (event: TabEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: TabEvent): void => handler(event)
    ipcRenderer.on(IPC.tabEvent, listener)
    return () => ipcRenderer.off(IPC.tabEvent, listener)
  },
  setZoomFactor: (factor: number): void => webFrame.setZoomFactor(factor),
  getZoomFactor: (): number => webFrame.getZoomFactor(),
  onZoomChanged: (handler: (factor: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, factor: number): void => handler(factor)
    ipcRenderer.on('zoom.changed', listener)
    return () => ipcRenderer.off('zoom.changed', listener)
  },
  onShutdown: (handler: (info: { total: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { total: number }): void => handler(info)
    ipcRenderer.on('app.shutdown', listener)
    return () => ipcRenderer.off('app.shutdown', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = api
}

export type WotchCodeApi = typeof api
