import { promises as fs } from 'fs'
import path from 'path'
import { execOn, ServerCtx, isLocal } from './server-exec'
import { shellEscape } from './ssh'

/**
 * Server-aware filesystem primitives.
 *
 * For a LOCAL server (serverId=null) these delegate to node `fs` — byte-for-byte
 * the original behaviour. For a REMOTE server the same operation is performed on
 * that host over SSH, with file CONTENT moved as base64 so no shell-escaping of
 * the body is ever required (arbitrary bytes are safe).
 *
 * Every path is passed through shellEscape for the remote branch, so values from
 * the DB/request can never break out into extra shell commands.
 */

export async function readFileOn(ctx: ServerCtx, filePath: string): Promise<string> {
  if (isLocal(ctx)) return fs.readFile(filePath, 'utf-8')
  // base64 -w0 → single line; throws (non-zero) if the file is missing, which
  // matches fs.readFile rejecting — callers rely on that to fall back.
  const { stdout } = await execOn(ctx, 'bash', ['-lc', `base64 -w0 ${shellEscape(filePath)}`])
  return Buffer.from(stdout.trim(), 'base64').toString('utf-8')
}

export async function writeFileOn(ctx: ServerCtx, filePath: string, content: string, opts: { mode?: number } = {}): Promise<void> {
  if (isLocal(ctx)) {
    await fs.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {})
    await fs.writeFile(filePath, content, opts.mode ? { mode: opts.mode } : {})
    return
  }
  const b64 = Buffer.from(content, 'utf-8').toString('base64')
  const chmod = opts.mode ? ` && chmod ${opts.mode.toString(8)} ${shellEscape(filePath)}` : ''
  const script =
    `mkdir -p ${shellEscape(path.dirname(filePath))} && ` +
    `printf %s ${shellEscape(b64)} | base64 -d > ${shellEscape(filePath)}${chmod}`
  await execOn(ctx, 'bash', ['-lc', script])
}

export async function copyFileOn(ctx: ServerCtx, src: string, dst: string): Promise<void> {
  if (isLocal(ctx)) { await fs.copyFile(src, dst); return }
  await execOn(ctx, 'bash', ['-lc', `cp -f ${shellEscape(src)} ${shellEscape(dst)}`])
}

export async function existsOn(ctx: ServerCtx, filePath: string): Promise<boolean> {
  if (isLocal(ctx)) return fs.access(filePath).then(() => true).catch(() => false)
  return execOn(ctx, 'bash', ['-lc', `test -e ${shellEscape(filePath)}`]).then(() => true).catch(() => false)
}

export async function unlinkOn(ctx: ServerCtx, filePath: string): Promise<void> {
  if (isLocal(ctx)) { await fs.unlink(filePath).catch(() => {}); return }
  await execOn(ctx, 'bash', ['-lc', `rm -f ${shellEscape(filePath)}`]).catch(() => {})
}

export async function mkdirOn(ctx: ServerCtx, dirPath: string): Promise<void> {
  if (isLocal(ctx)) { await fs.mkdir(dirPath, { recursive: true }); return }
  await execOn(ctx, 'bash', ['-lc', `mkdir -p ${shellEscape(dirPath)}`])
}

export async function readdirOn(ctx: ServerCtx, dirPath: string): Promise<string[]> {
  if (isLocal(ctx)) return fs.readdir(dirPath)
  const { stdout } = await execOn(ctx, 'bash', ['-lc', `ls -1 ${shellEscape(dirPath)}`])
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
}

/** chown -R on the remote (or fs equivalent locally is skipped — provisioning owns perms). */
export async function chownROn(ctx: ServerCtx, owner: string, target: string): Promise<void> {
  if (isLocal(ctx)) { return } // local flows already set ownership where needed
  await execOn(ctx, 'bash', ['-lc', `chown -R ${shellEscape(owner)} ${shellEscape(target)}`]).catch(() => {})
}
