import type { ChildProcess } from 'node:child_process'
import type { HostInfo } from '../../shared/protocol'

export type { HostInfo }

export interface SpawnRunnerOptions {
  /** Where the compiled runner script lives (resolved by main process). */
  runnerScript: string
  /** Working directory the session should run in. Hosts may translate paths. */
  cwd: string
  /** Extra env to merge with the runner's environment. */
  env?: Record<string, string>
}

export interface SpawnShellOptions {
  /** cwd in this host's path scheme (already translated). */
  cwd: string
  /** Command line as the user typed it. Hosts pass it to their default shell. */
  command: string
}

/** A claude-related process found on this host. `cwd` may be undefined when
 *  the host can't observe it cheaply (Windows). */
export interface HostProcessInfo {
  pid: number
  command: string
  cwd?: string
}

export interface HostAdapter {
  info: HostInfo
  spawnRunner(opts: SpawnRunnerOptions): ChildProcess
  /**
   * Spawn a user-invoked shell command (the `!` prefix) on this host.
   * Stdout+stderr stream to the caller; exit code marks completion.
   */
  spawnShell(opts: SpawnShellOptions): ChildProcess
  /**
   * Translate a Windows-style path the user picked into the path the host
   * expects (e.g. WSL would convert C:\foo to /mnt/c/foo). For native Windows
   * this is the identity.
   */
  translateCwd(winPath: string): string | Promise<string>
  /**
   * List `claude`-related processes running on this host. Used by the external
   * session tracker to decide whether a session on disk has a live writer.
   * Implementations should exclude this app's own runner subprocesses.
   */
  listClaudeProcesses(): Promise<HostProcessInfo[]>
  /**
   * Best-effort kill of a process on this host. Returns true if the kill call
   * succeeded; the caller still needs to wait for the process to actually go
   * away (we observe via file mtime quiet).
   */
  killProcess(pid: number): Promise<boolean>
  /** Default value of RunnerStartOptions.sandbox for sessions on this host. */
  readonly defaultSandbox: boolean
}
