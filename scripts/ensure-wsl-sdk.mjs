#!/usr/bin/env node
// Ensures @anthropic-ai/claude-agent-sdk-linux-x64 is present in node_modules.
//
// Why this exists: the WSL host runs the SDK CLI as a Linux binary, so the
// Windows-side node_modules tree must contain the linux-x64 platform package
// (read by plain `node` inside WSL via /mnt/...). But that package's manifest
// pins os=linux,cpu=x64, so `npm install` on Windows skips/prunes it whether
// it's listed as a regular or optional dependency.
//
// We avoid touching npm's resolution graph (which would also prune the
// matching win32-x64 binary if we ran `npm install --os=linux`). Instead we
// fetch the published tarball with `npm pack` and extract it directly.
// Idempotent: returns immediately if the package is already on disk.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.2.132'
const PKG = '@anthropic-ai/claude-agent-sdk-linux-x64'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64')

if (existsSync(target) && readdirSync(target).length > 0) {
  process.exit(0)
}

// execSync (single string + shell) so npm.cmd resolves on Windows. Args are
// hardcoded constants here, no injection surface.
const tarOut = execSync(`npm pack --silent ${PKG}@${VERSION}`, {
  cwd: root,
  encoding: 'utf8'
})
// `npm pack` prints the tarball filename on the last non-empty stdout line.
const tarball = tarOut.trim().split(/\r?\n/).filter(Boolean).at(-1)
if (!tarball) {
  console.error(`[ensure-wsl-sdk] npm pack produced no tarball for ${PKG}@${VERSION}`)
  process.exit(1)
}
const tarballPath = join(root, tarball)

console.log(`[ensure-wsl-sdk] installing ${PKG}@${VERSION} (WSL host needs this)`)

mkdirSync(target, { recursive: true })
// Use the Windows-builtin BSD tar (System32) explicitly — if a GNU tar is
// first on PATH (Git Bash / MSYS2) it interprets "D:" as a remote rsh host
// and fails with "Cannot connect to D: resolve failed". On other platforms
// the system tar handles absolute paths fine.
const tarBin =
  process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
// --strip-components=1 drops the leading "package/" directory inside the
// tarball so files land directly under target/.
execFileSync(tarBin, ['-xzf', tarballPath, '-C', target, '--strip-components=1'], {
  cwd: root,
  stdio: 'inherit'
})
rmSync(tarballPath, { force: true })
