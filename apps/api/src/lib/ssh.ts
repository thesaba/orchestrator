import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { decryptSecret, isEncrypted } from './crypto'

/**
 * Low-level SSH helpers for reaching remote managed servers.
 *
 * Safety model:
 *  - Private keys are stored ENCRYPTED in the DB and only ever written to a
 *    transient 0600 file for the duration of a single ssh invocation.
 *  - We use BatchMode (never prompt), a fixed ConnectTimeout, and a dedicated
 *    known_hosts with StrictHostKeyChecking=accept-new: the first connection
 *    trust-on-first-use pins the host key; a later key change is rejected
 *    (protects against MITM after enrolment).
 *  - Remote commands are built by shell-escaping every argv token, so values
 *    from the DB/request can never break out into extra shell commands.
 */

export interface RemoteServer {
  kind: string
  host: string | null
  port: number
  sshUser: string
  sshKey: string | null // encrypted PEM
}

// Directory holding the panel's per-server known_hosts (created 0700 on demand).
function stateDir(): string {
  return process.env.ORCH_SSH_DIR || path.join(os.homedir(), '.orchestrator-ssh')
}

async function knownHostsFile(): Promise<string> {
  const dir = stateDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const f = path.join(dir, 'known_hosts')
  // Ensure it exists so ssh doesn't warn about a missing file.
  await fs.appendFile(f, '', { mode: 0o600 }).catch(() => {})
  return f
}

// Single-quote a value for safe embedding in a POSIX shell command.
export function shellEscape(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Build the single remote command string ssh will execute. Each token is
 * escaped; env vars are prefixed as `KEY='value'` (keys validated as
 * identifiers); an optional cwd is entered first.
 */
export function buildRemoteCommand(opts: {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}): string {
  const parts: string[] = []
  if (opts.cwd) parts.push(`cd ${shellEscape(opts.cwd)} &&`)
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue // ignore invalid names
      parts.push(`${k}=${shellEscape(v)}`)
    }
  }
  parts.push(shellEscape(opts.file))
  for (const a of opts.args ?? []) parts.push(shellEscape(a))
  return parts.join(' ')
}

/** ssh argv (excluding the remote command), given the temp key path. */
export async function sshBaseArgs(server: RemoteServer, keyPath: string, tty = false): Promise<string[]> {
  const kh = await knownHostsFile()
  const args = [
    '-i', keyPath,
    '-p', String(server.port || 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${kh}`,
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3'
  ]
  if (tty) args.push('-tt') // force a pty so killing local ssh signals the remote process
  args.push(`${server.sshUser}@${server.host}`)
  return args
}

/** Decrypt the server's key into a transient 0600 file; caller must clean up. */
export async function writeKeyFile(server: RemoteServer): Promise<string> {
  const raw = server.sshKey ?? ''
  const key = isEncrypted(raw) ? (decryptSecret(raw) ?? '') : raw
  if (!key) throw Object.assign(new Error('Server has no SSH key configured'), { code: 400 })
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-key-'))
  const file = path.join(dir, 'id')
  await fs.writeFile(file, key.endsWith('\n') ? key : key + '\n', { mode: 0o600 })
  return file
}

export async function cleanupKeyFile(keyPath: string): Promise<void> {
  await fs.rm(path.dirname(keyPath), { recursive: true, force: true }).catch(() => {})
}
