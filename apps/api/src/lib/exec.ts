import { execFile } from 'child_process'
import { promisify } from 'util'

/**
 * Promisified execFile. Unlike `exec`, this does NOT spawn a shell — arguments
 * are passed as an argv array, so shell metacharacters ($(), backticks, ;, |,
 * &&, quotes, globs) in user-controlled values are treated as literal data and
 * can never be interpreted as commands.
 *
 * Prefer this (or Node's native `fs`/library APIs) over `exec(\`... ${x} ...\`)`
 * anywhere a value originates from the database, request body, or filesystem.
 */
export const execFileP = promisify(execFile)

export interface RunOpts {
  cwd?: string
  timeout?: number
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/**
 * Run a program with a fixed argv array, no shell. Returns combined stdout.
 * Throws on non-zero exit (the error carries .stdout/.stderr like execFile).
 */
export async function run(
  file: string,
  args: string[],
  opts: RunOpts = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileP(file, args, {
    timeout: opts.timeout ?? 30_000,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    cwd: opts.cwd,
    env: opts.env
  })
}

/**
 * Validate a Git remote URL before it is ever handed to `git`.
 * Accepts only https/http URLs and scp-like `git@host:owner/repo(.git)` syntax.
 * Rejects anything else (e.g. `ext::`, `file://`, `-`-prefixed option-injection,
 * or values containing whitespace/newlines).
 */
export function isValidGitUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 500) return false
  if (/[\s\x00-\x1f]/.test(url)) return false // no whitespace or control chars
  if (url.startsWith('-')) return false // never let a URL be parsed as a git option

  // scp-like syntax: git@github.com:owner/repo.git
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[A-Za-z0-9._/~-]+$/.test(url)) return true

  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}
