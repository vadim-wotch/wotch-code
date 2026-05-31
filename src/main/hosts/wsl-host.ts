import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  HostAdapter,
  HostInfo,
  HostProcessInfo,
  SpawnRunnerOptions,
  SpawnShellOptions
} from './host-adapter'

const execFileP = promisify(execFile)

// ---------------------------------------------------------------------------
// Probe WSL once at module load. Synchronous because spawnRunner / listHosts
// expect availability without async — we'd prefer a one-time small cost over
// async-painting every host UI surface. wsl.exe is a tiny launcher; the call
// returns in milliseconds when it's installed and times out fast when it's
// not. Cached for the app lifetime.
// ---------------------------------------------------------------------------

interface WslProbe {
  available: boolean
  reason?: string
  defaultDistro?: string
  /** When set: the path to a Linux SDK CLI binary the runner inside WSL can
   *  use. Detected from the host node_modules; if absent, we still mark the
   *  host available but surface a helpful reason in `setupHint` so the user
   *  sees the issue once they try to start a session. */
  setupHint?: string
}

function probeWsl(): WslProbe {
  // wsl.exe -l -v emits UTF-16LE on Windows by default. Force quiet output to
  // a single line per distro so we can parse without fighting the encoding.
  let raw: string
  try {
    const buf = execFileSync('wsl.exe', ['-l', '-v'], {
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    // Strip BOM + decode UTF-16LE. wsl outputs as UTF-16 little-endian.
    raw = buf.toString('utf16le').replace(/^\uFEFF/, '')
  } catch (e) {
    return {
      available: false,
      reason:
        e instanceof Error && /ENOENT/.test(e.message)
          ? 'wsl.exe not found'
          : `wsl probe failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // Parse `NAME  STATE  VERSION` rows. The default distro is prefixed `*`.
  // First line is a header; skip blanks.
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length <= 1) {
    return { available: false, reason: 'no WSL distros installed' }
  }
  let defaultDistro: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    const isDefault = line.startsWith('*')
    const cols = line.replace(/^\*/, '').trim().split(/\s+/)
    const name = cols[0]
    if (isDefault && name) {
      defaultDistro = name
      break
    }
  }
  if (!defaultDistro) {
    return { available: false, reason: 'no default WSL distro detected' }
  }

  // node check — without it the runner can't even start. Surface this in the
  // probe instead of waiting for an opaque execvpe failure at session time.
  let nodeMissing = false
  try {
    execFileSync('wsl.exe', ['-d', defaultDistro, '--exec', 'sh', '-c', 'command -v node'], {
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    nodeMissing = true
  }

  // Linux SDK binary check — same node_modules, different platform package.
  // We probe its presence on the Windows side because the WSL runner will
  // resolve it from the same /mnt/... node_modules tree.
  const linuxPkg = findLinuxSdkPackage()

  const hints: string[] = []
  if (nodeMissing) hints.push(`node not found in ${defaultDistro} (apt install nodejs)`)
  if (!linuxPkg) hints.push('run `npm run prepare:wsl` to install the Linux SDK binary')

  return {
    available: true,
    defaultDistro,
    setupHint: hints.length > 0 ? hints.join('; ') : undefined
  }
}

function findLinuxSdkPackage(): string | undefined {
  // Walk up from this module's __dirname looking for node_modules. Works in
  // both dev (out/main) and packaged builds.
  let dir = __dirname
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const probe = probeWsl()

// ---------------------------------------------------------------------------
// Path translation: C:\foo bar  →  /mnt/c/foo bar
// ---------------------------------------------------------------------------

function winToWsl(winPath: string): string {
  // Drive-letter form. Anything else (already a Linux path, UNC, etc.) we
  // leave alone — caller is expected to pass a Windows-style absolute path
  // since the dir-picker returns those.
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath
  const drive = m[1].toLowerCase()
  const rest = m[2].replace(/\\/g, '/')
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`
}

function wslToWin(linuxPath: string): string | null {
  const m = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(linuxPath)
  if (!m) return null
  const drive = m[1].toUpperCase()
  const rest = m[2] ? m[2].replace(/\//g, '\\') : ''
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const info: HostInfo = probe.available
  ? {
      id: 'wsl',
      label: probe.defaultDistro ? `WSL - ${probe.defaultDistro}` : 'WSL',
      available: true,
      reason: probe.setupHint,
      defaultSandbox: true
    }
  : {
      id: 'wsl',
      label: 'WSL',
      available: false,
      reason: probe.reason,
      defaultSandbox: true
    }

export const wslHost: HostAdapter = {
  info,
  defaultSandbox: true,

  spawnRunner(opts: SpawnRunnerOptions) {
    if (!probe.available || !probe.defaultDistro) {
      throw new Error(`WSL host unavailable: ${probe.reason ?? 'unknown'}`)
    }
    if (probe.setupHint) {
      // Surface latent setup issues (missing node / missing Linux SDK) at the
      // moment the user actually tries to start a session.
      throw new Error(`WSL host not ready: ${probe.setupHint}`)
    }
    if (!existsSync(opts.runnerScript)) {
      throw new Error(`Runner script not found: ${opts.runnerScript}`)
    }

    // cwd was translated to a Linux path by translateCwd. Validate the Windows
    // origin still exists — `wsl --cd` will fail with an opaque chdir error
    // otherwise. The session-manager records the translated cwd, so we walk
    // back to the Windows form for the check.
    const winCwd = wslToWin(opts.cwd)
    if (winCwd && (!existsSync(winCwd) || !statSync(winCwd).isDirectory())) {
      throw new Error(`Working directory does not exist on Windows: ${winCwd}`)
    }

    const linuxRunner = winToWsl(opts.runnerScript)
    // cwd is already translated to a Linux path by translateCwd above; the
    // session-manager passes it back in unchanged.
    const linuxCwd = opts.cwd

    // Point the WSL-side SDK at the Windows-side .claude directory so both
    // hosts share one session store + credentials. Without this, WSL
    // sessions land at /home/<user>/.claude (invisible to the Windows
    // listSessions scan) and the resume list misses them entirely.
    const sharedClaudeDir = winToWsl(join(homedir(), '.claude'))

    // `wsl.exe --cd` sets the Linux-side cwd. `--exec` skips shell parsing so
    // arguments with spaces survive intact. We use `env` as the program so we
    // can set CLAUDE_CONFIG_DIR + CLAUDE_AGENT_SDK_CLIENT_APP for just this
    // process without polluting the parent env or threading WSLENV.
    const envArgs = [
      `CLAUDE_CONFIG_DIR=${sharedClaudeDir}`,
      'CLAUDE_AGENT_SDK_CLIENT_APP=wotch-code/0.4.0',
      ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`)
    ]
    const args = [
      '-d',
      probe.defaultDistro,
      '--cd',
      linuxCwd,
      '--exec',
      'env',
      ...envArgs,
      'node',
      linuxRunner
    ]
    return spawn('wsl.exe', args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  },

  spawnShell(opts: SpawnShellOptions) {
    if (!probe.available || !probe.defaultDistro) {
      throw new Error(`WSL host unavailable: ${probe.reason ?? 'unknown'}`)
    }
    // bash -lc gives the user a login shell so PATH from .bashrc/.profile is
    // populated (nvm, pyenv, etc. are routinely on PATH only inside login
    // shells). -c parses the line as a single command string so quoting in
    // the user's input survives intact.
    //
    // Force-color env vars are set via `env VAR=val …` because WSL doesn't
    // inherit Windows-side env without WSLENV plumbing. Many tools (Node,
    // ESLint, ripgrep, ls, …) honor these and re-enable color even though
    // stdout isn't a TTY. Git ignores them — use `git -c color.ui=always …`.
    return spawn(
      'wsl.exe',
      [
        '-d',
        probe.defaultDistro,
        '--cd',
        opts.cwd,
        '--exec',
        'env',
        'FORCE_COLOR=1',
        'CLICOLOR_FORCE=1',
        'TERM=xterm-256color',
        'bash',
        '-lc',
        opts.command
      ],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
  },

  translateCwd(winPath: string) {
    return winToWsl(winPath)
  },

  async listClaudeProcesses(): Promise<HostProcessInfo[]> {
    if (!probe.available || !probe.defaultDistro) return []
    // /proc-walk gives pid + cwd + cmdline for every process the user can see.
    // We emit one line per process as `pid<TAB>cwd<TAB>cmd` and parse below.
    // 2>/dev/null swallows EACCES on processes the user doesn't own.
    const script =
      'for p in /proc/[0-9]*; do ' +
      'pid=$(basename "$p"); ' +
      'cwd=$(readlink "$p/cwd" 2>/dev/null); ' +
      'cmd=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
      '[ -n "$cmd" ] || continue; ' +
      'printf "%s\\t%s\\t%s\\n" "$pid" "$cwd" "$cmd"; ' +
      'done'
    let stdout: string
    try {
      const r = await execFileP(
        'wsl.exe',
        ['-d', probe.defaultDistro, '--exec', 'sh', '-c', script],
        { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }
      )
      stdout = r.stdout
    } catch {
      return []
    }
    const out: HostProcessInfo[] = []
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const pid = Number(parts[0])
      const cwd = parts[1] || undefined
      const command = parts.slice(2).join('\t')
      if (!Number.isFinite(pid) || pid <= 0) continue
      const lower = command.toLowerCase()
      if (!lower.includes('claude')) continue
      if (lower.includes('runner.js')) continue
      out.push({ pid, command, cwd })
    }
    return out
  },

  async killProcess(pid: number): Promise<boolean> {
    if (!probe.available || !probe.defaultDistro) return false
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      // SIGTERM first; if claude doesn't honor it, the user can take over
      // again or close manually. Avoid -9 to give claude a chance to flush.
      await execFileP('wsl.exe', ['-d', probe.defaultDistro, '--exec', 'kill', String(pid)], {
        windowsHide: true,
        timeout: 4000
      })
      return true
    } catch {
      return false
    }
  }
}
