import { create } from 'zustand'
import type {
  ExternalSessionInfo,
  LogEntry,
  PendingApproval,
  PendingQuestion,
  SlashCommand,
  TabEvent,
  TabMeta,
  TabStatus
} from '../../../shared/protocol'

export interface TabState {
  meta: TabMeta
  log: LogEntry[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  commands: SlashCommand[]
}

interface TabsStore {
  tabs: Record<string, TabState>
  order: string[]
  activeId: string | null
  /** When set, the renderer shows the read-only detail view for this external
   *  sessionId instead of the dashboard. Mutually exclusive with activeId. */
  activeExternalId: string | null
  /** Session IDs the user has pinned; mirrors localStorage. */
  pinnedSessionIds: Set<string>
  /** External sessions (running outside the app). Keyed by sessionId. */
  external: Record<string, ExternalSessionInfo>
  /** Local dismissals — sessionIds the user hid from the dashboard. Cleared on refresh. */
  hiddenExternal: Set<string>
  setActive: (id: string | null) => void
  setActiveExternal: (sessionId: string | null) => void
  applyEvent: (event: TabEvent) => void
  removeTab: (id: string) => void
  setPinnedSessionIds: (ids: Set<string>) => void
  hideExternal: (sessionId: string) => void
  clearHiddenExternal: () => void
}

export const useTabsStore = create<TabsStore>((set) => ({
  tabs: {},
  order: [],
  activeId: null,
  activeExternalId: null,
  pinnedSessionIds: new Set<string>(),
  external: {},
  hiddenExternal: new Set<string>(),

  setActive: (id) =>
    set((s) => ({
      activeId: id,
      activeExternalId: id ? null : s.activeExternalId
    })),

  setActiveExternal: (sessionId) =>
    set((s) => ({
      activeExternalId: sessionId,
      activeId: sessionId ? null : s.activeId
    })),

  setPinnedSessionIds: (ids) => set({ pinnedSessionIds: ids }),

  hideExternal: (sessionId) =>
    set((s) => {
      const next = new Set(s.hiddenExternal)
      next.add(sessionId)
      return { hiddenExternal: next }
    }),

  clearHiddenExternal: () => set({ hiddenExternal: new Set<string>() }),

  removeTab: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.tabs
      const order = s.order.filter((t) => t !== id)
      const activeId = s.activeId === id ? (order[0] ?? null) : s.activeId
      return { tabs: rest, order, activeId }
    }),

  applyEvent: (event) =>
    set((s) => {
      switch (event.kind) {
        case 'tab_created': {
          const tab: TabState = {
            meta: event.tab,
            log: [],
            pendingApprovals: [],
            pendingQuestions: [],
            commands: []
          }
          return {
            tabs: { ...s.tabs, [event.tab.id]: tab },
            order: [...s.order, event.tab.id],
            activeId: s.activeId ?? event.tab.id
          }
        }
        case 'commands': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: { ...s.tabs, [event.tabId]: { ...cur, commands: event.commands } }
          }
        }
        case 'tab_status': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          const meta: TabMeta = {
            ...cur.meta,
            status: event.status as TabStatus,
            sessionId: event.sessionId ?? cur.meta.sessionId
          }
          return { tabs: { ...s.tabs, [event.tabId]: { ...cur, meta } } }
        }
        case 'log': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          // dedupe assistant messages by uuid (SDK can re-emit during partials).
          // Same in-place replacement for shell entries — main streams output
          // chunks by re-broadcasting the same id with a longer `output`.
          if (event.entry.kind === 'assistant' || event.entry.kind === 'shell') {
            const targetKind = event.entry.kind
            const targetId = (event.entry as LogEntry & { id: string }).id
            const idx = cur.log.findIndex((l) => l.kind === targetKind && l.id === targetId)
            if (idx >= 0) {
              const log = cur.log.slice()
              log[idx] = event.entry
              return { tabs: { ...s.tabs, [event.tabId]: { ...cur, log } } }
            }
          }
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: { ...cur, log: [...cur.log, event.entry] }
            }
          }
        }
        case 'approval_request': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: {
                ...cur,
                pendingApprovals: [...cur.pendingApprovals, event.request]
              }
            }
          }
        }
        case 'approval_resolved': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: {
                ...cur,
                pendingApprovals: cur.pendingApprovals.filter((a) => a.id !== event.id)
              }
            }
          }
        }
        case 'question_request': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: {
                ...cur,
                pendingQuestions: [...cur.pendingQuestions, event.request]
              }
            }
          }
        }
        case 'question_resolved': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: {
                ...cur,
                pendingQuestions: cur.pendingQuestions.filter((q) => q.id !== event.id)
              }
            }
          }
        }
        case 'tab_closed': {
          const { [event.tabId]: _gone, ...rest } = s.tabs
          const order = s.order.filter((t) => t !== event.tabId)
          const activeId = s.activeId === event.tabId ? (order[0] ?? null) : s.activeId
          return { tabs: rest, order, activeId }
        }
        case 'tab_renamed': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: { ...cur, meta: { ...cur.meta, name: event.name } }
            }
          }
        }
        case 'log_cleared': {
          const cur = s.tabs[event.tabId]
          if (!cur) return {}
          return {
            tabs: {
              ...s.tabs,
              [event.tabId]: { ...cur, log: [], pendingApprovals: [], pendingQuestions: [] }
            }
          }
        }
        case 'external_added':
        case 'external_updated': {
          return { external: { ...s.external, [event.info.sessionId]: event.info } }
        }
        case 'external_removed': {
          if (!s.external[event.sessionId]) return {}
          const { [event.sessionId]: _gone, ...rest } = s.external
          const activeExternalId =
            s.activeExternalId === event.sessionId ? null : s.activeExternalId
          return { external: rest, activeExternalId }
        }
        case 'external_cleared': {
          return { external: {}, activeExternalId: null }
        }
        default:
          return {}
      }
    })
}))
