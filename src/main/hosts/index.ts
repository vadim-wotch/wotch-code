import type { HostAdapter, HostInfo } from './host-adapter'
import { windowsHost } from './windows-host'
import { wslHost } from './wsl-host'

const adapters: Record<string, HostAdapter> = {
  [windowsHost.info.id]: windowsHost,
  [wslHost.info.id]: wslHost
  // future: docker
}

export function listHosts(): HostInfo[] {
  return Object.values(adapters).map((a) => a.info)
}

export function getHost(id: string): HostAdapter {
  const a = adapters[id]
  if (!a) throw new Error(`Unknown host: ${id}`)
  return a
}
