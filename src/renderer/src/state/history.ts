// Simple localStorage-backed prompt history. Lives only in the renderer so it
// survives app restarts even though session transcripts don't.

const KEY = 'hb.promptHistory.v1'
const MAX = 30

export function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function pushHistory(prompt: string): string[] {
  const trimmed = prompt.trim()
  if (!trimmed) return loadHistory()
  const cur = loadHistory().filter((p) => p !== trimmed)
  const next = [trimmed, ...cur].slice(0, MAX)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // ignore quota errors
  }
  return next
}

export function removeFromHistory(prompt: string): string[] {
  const next = loadHistory().filter((p) => p !== prompt)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
