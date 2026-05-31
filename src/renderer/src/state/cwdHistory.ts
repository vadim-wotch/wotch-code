// localStorage-backed recent-folders list for the new-session cwd field.
// Mirrors history.ts; kept separate so prompt history and folder history stay
// independent (different lifetimes, different sizes).

const KEY = 'hb.cwdHistory.v1'
const MAX = 15

export function loadCwdHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function pushCwdHistory(cwd: string): string[] {
  const trimmed = cwd.trim()
  if (!trimmed) return loadCwdHistory()
  const cur = loadCwdHistory().filter((p) => p !== trimmed)
  const next = [trimmed, ...cur].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // ignore quota errors
  }
  return next
}

export function removeFromCwdHistory(cwd: string): string[] {
  const next = loadCwdHistory().filter((p) => p !== cwd)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}
