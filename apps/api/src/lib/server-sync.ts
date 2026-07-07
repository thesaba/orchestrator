import { spawn } from 'child_process'
import path from 'path'
import type { PrismaClient } from '@prisma/client'
import { RemoteServer, sshBaseArgs, writeKeyFile, cleanupKeyFile, shellEscape } from './ssh'
import { toServerCtx } from './servers'
import { isLocal } from './server-exec'

/** Where the panel's bash scripts are copied on a remote server. */
export const REMOTE_SCRIPTS_DIR = '/opt/orchestrator-scripts'

function localScriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

/**
 * Copy the local scripts/ directory to a remote server via `tar | ssh tar -x`.
 * Idempotent (overwrites). Used before a remote provision/deploy so deploy.sh /
 * provision.sh / cleanup.sh etc. exist on the target host.
 */
export async function syncScripts(server: RemoteServer): Promise<void> {
  const keyPath = await writeKeyFile(server)
  try {
    const base = await sshBaseArgs(server, keyPath)
    const remote = `mkdir -p ${shellEscape(REMOTE_SCRIPTS_DIR)} && tar xzf - -C ${shellEscape(REMOTE_SCRIPTS_DIR)} && chmod +x ${shellEscape(REMOTE_SCRIPTS_DIR)}/*.sh 2>/dev/null || true`
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['czf', '-', '-C', localScriptsDir(), '.'])
      const ssh = spawn('ssh', [...base, remote])
      let err = ''
      tar.stdout.pipe(ssh.stdin)
      tar.on('error', reject)
      ssh.on('error', reject)
      ssh.stderr.on('data', (d) => { err += d.toString() })
      ssh.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.trim() || `script sync failed (exit ${code})`)))
    })
  } finally {
    await cleanupKeyFile(keyPath)
  }
}

/**
 * Ensure a site's target server has the scripts synced. No-op for local sites.
 * Marks scriptsSynced so we don't re-copy on every deploy. Returns the scripts
 * directory to use (local path or the remote path).
 */
export async function ensureScriptsSynced(prisma: PrismaClient, serverId: number | null | undefined): Promise<{ local: boolean; scriptsDir: string }> {
  if (!serverId) return { local: true, scriptsDir: localScriptsDir() }
  const server = await (prisma as any).server.findUnique({ where: { id: serverId } }).catch(() => null)
  const ctx = toServerCtx(server)
  if (isLocal(ctx)) return { local: true, scriptsDir: localScriptsDir() }
  // Always (re)sync: the tarball is a few KB, and this guarantees the remote
  // always has the latest scripts (a stale scriptsSynced flag previously left
  // newly-added scripts like bootstrap-server.sh missing on the remote).
  await syncScripts(ctx as RemoteServer)
  await (prisma as any).server.update({ where: { id: server.id }, data: { scriptsSynced: true } }).catch(() => {})
  return { local: false, scriptsDir: REMOTE_SCRIPTS_DIR }
}
