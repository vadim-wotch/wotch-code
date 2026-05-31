import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { promisify } from 'node:util'
import type {
  HostAdapter,
  HostProcessInfo,
  SpawnRunnerOptions,
  SpawnShellOptions
} from './host-adapter'

const execFileP = promisify(execFile)

export const windowsHost: HostAdapter = {
  info: {
    id: 'windows',
    label: 'Native Windows',
    available: true,
    defaultSandbox: false
  },
  defaultSandbox: false,

  spawnRunner(opts: SpawnRunnerOptions) {
    if (!existsSync(opts.runnerScript)) {
      throw new Error(`Runner script not found: ${opts.runnerScript}`)
    }
    // Validate cwd up front. Without this, child_process.spawn surfaces a
    // confusing "spawn <execPath> ENOENT" — Windows CreateProcess fails when
    // the working directory is missing, but Node attributes it to the binary.
    try {
      if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
        throw new Error(`Working directory does not exist: ${opts.cwd}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Working directory')) throw e
      throw new Error(`Working directory is not accessible: ${opts.cwd} (${String(e)})`)
    }
    // Run the runner with the same Node binary that's running Electron's main
    // process — ensures Node version parity and avoids requiring a separate
    // Node install. process.execPath points to Electron itself, but with
    // ELECTRON_RUN_AS_NODE=1 it behaves as plain Node.
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'wotch-code/0.4.1',
      ...opts.env
    }
    return spawn(process.execPath, [opts.runnerScript], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  },

  spawnShell(opts: SpawnShellOptions) {
    // PowerShell is the default Windows 10+ shell for dev work and handles
    // pipelines/redirection more predictably than cmd. -NoLogo keeps banner
    // out of output, -NoProfile avoids slow user profiles, -Command runs
    // the line and exits.
    //
    // Force-color env vars: many tools auto-disable color when stdout isn't a
    // TTY. These hints flip the common ones (Node, ESLint, ripgrep, jq, …)
    // back on. Git ignores them — for git, use `git -c color.ui=always …`.
    return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', opts.command], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        CLICOLOR_FORCE: '1',
        TERM: 'xterm-256color'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  },

  translateCwd(winPath: string) {
    return winPath
  },

  async listClaudeProcesses(): Promise<HostProcessInfo[]> {
    // Look for both `claude.exe` (rare — npm shim) and `node.exe` whose command
    // line includes "claude". Exclude this app's own runner (runner.js), and
    // Electron parents (helpers, gpu, etc.) which would show up with very
    // different command lines anyway.
    //
    // Get-CimInstance is more reliable than tasklist for command lines (which
    // tasklist truncates) and is safe in PowerShell -NoProfile mode.
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'claude.exe'\" | " +
      "ForEach-Object { Write-Output (\"$($_.ProcessId)`t$($_.CommandLine -replace '`t',' ')\") }"
    let stdout: string
    try {
      const r = await execFileP('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024
      })
      stdout = r.stdout
    } catch {
      return []
    }
    const out: HostProcessInfo[] = []
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const pid = Number(line.slice(0, tab))
      const command = line.slice(tab + 1)
      if (!Number.isFinite(pid) || pid <= 0) continue
      const lower = command.toLowerCase()
      if (!lower.includes('claude')) continue
      // Skip our own runner — match by filename to avoid leaking paths.
      if (lower.includes('runner.js')) continue
      out.push({ pid, command })
    }
    return out
  },

  async killProcess(pid: number): Promise<boolean> {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      // /T kills the whole process tree (node shim + actual claude child).
      await execFileP('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 5000
      })
      return true
    } catch {
      return false
    }
  }
}
