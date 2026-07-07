import { spawn, ChildProcessWithoutNullStreams, execFile } from 'child_process'
import { promisify } from 'util'
import { run, RunOpts } from './exec'
import { RemoteServer, sshBaseArgs, buildRemoteCommand, writeKeyFile, cleanupKeyFile } from './ssh'

const execFileP = promisify(execFile)

/**
 * Server-aware command execution.
 *
 * The whole point: for a LOCAL server (or a null/undefined server, which every
 * pre-existing site resolves to) this is byte-for-byte the original behaviour —
 * `execOn` calls `run(...)` and `spawnOn` calls `spawn(...)` exactly as before.
 * Only for a remote (kind="remote") server do we route the same command over
 * SSH. This keeps all existing local sites completely unaffected.
 */

export type ServerCtx = RemoteServer | null | undefined

export function isLocal(server: ServerCtx): boolean {
  return !server || server.kind === 'local' || !server.host
}

export interface ExecOnOpts extends RunOpts {
  /** For remote: env is injected into the remote command, not the ssh process. */
}

/** Run a program (argv, no local shell) on the target server. Returns stdout/stderr. */
export async function execOn(
  server: ServerCtx,
  file: string,
  args: string[],
  opts: ExecOnOpts = {}
): Promise<{ stdout: string; stderr: string }> {
  if (isLocal(server)) {
    return run(file, args, opts)
  }
  const srv = server as RemoteServer
  const keyPath = await writeKeyFile(srv)
  try {
    const remoteCmd = buildRemoteCommand({
      file, args,
      cwd: opts.cwd,
      env: (opts.env as Record<string, string> | undefined)
    })
    const base = await sshBaseArgs(srv, keyPath)
    const res = await execFileP('ssh', [...base, remoteCmd], {
      timeout: opts.timeout ?? 30_000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024
    })
    return { stdout: res.stdout as string, stderr: res.stderr as string }
  } finally {
    await cleanupKeyFile(keyPath)
  }
}

export interface SpawnOnOpts {
  cwd?: string
  env?: Record<string, string>
  detached?: boolean
  /** Request a remote pty so killing the ssh process signals the remote command. */
  tty?: boolean
}

/**
 * Spawn a long-running / streaming command on the target server, returning a
 * ChildProcess whose stdout/stderr stream just like a local spawn. For remote
 * servers the child is the local `ssh` process; killing it tears down the
 * connection (and, with tty, signals the remote command).
 */
export async function spawnOn(
  server: ServerCtx,
  file: string,
  args: string[],
  opts: SpawnOnOpts = {}
): Promise<ChildProcessWithoutNullStreams> {
  if (isLocal(server)) {
    return spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: opts.detached
    })
  }
  const srv = server as RemoteServer
  const keyPath = await writeKeyFile(srv)
  const remoteCmd = buildRemoteCommand({ file, args, cwd: opts.cwd, env: opts.env })
  const base = await sshBaseArgs(srv, keyPath, opts.tty)
  const child = spawn('ssh', [...base, remoteCmd], { detached: opts.detached })
  // Clean up the transient key once the connection ends.
  const cleanup = () => { cleanupKeyFile(keyPath) }
  child.on('close', cleanup)
  child.on('error', cleanup)
  return child
}
