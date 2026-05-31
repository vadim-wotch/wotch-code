import type { PermissionMode } from '../../../shared/protocol'

const KEY = 'hb.pinnedTabs.v1'

export interface PinnedSnapshot {
  hostId: string
  cwd: string
  permissionMode: PermissionMode
  model?: string
  name: string
  color: string
  /** SessionId is required — restore uses it to `resume` the on-disk transcript. */
  sessionId: string
}

export function loadPinned(): PinnedSnapshot[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => x && typeof x.sessionId === 'string') : []
  } catch {
    return []
  }
}

function save(list: PinnedSnapshot[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // ignore quota errors
  }
}

export function pinSession(snap: PinnedSnapshot): void {
  const cur = loadPinned().filter((s) => s.sessionId !== snap.sessionId)
  cur.push(snap)
  save(cur)
}

export function unpinSession(sessionId: string): void {
  save(loadPinned().filter((s) => s.sessionId !== sessionId))
}

export function isPinned(sessionId: string): boolean {
  return loadPinned().some((s) => s.sessionId === sessionId)
}
