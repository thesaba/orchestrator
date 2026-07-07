import { FastifyInstance } from 'fastify'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import { execOn, isLocal, ServerCtx } from './server-exec'
import { serverCtxById } from './servers'
import { shellEscape } from './ssh'

// Laravel log header line, e.g.
//   [2024-01-01 12:00:00] production.ERROR: Something broke {"exception":"…"}
const HEADER = /^\[(\d{4}-\d{2}-\d{2}[ T][\d:.]+)\][^\]]*?\.(ERROR|CRITICAL|EMERGENCY|ALERT|WARNING):\s+(.*)$/

// Per-site last byte offset read, so each pass only ingests new lines.
const offsets = new Map<number, number>()

function extractException(rest: string): { exceptionClass?: string; message: string } {
  const braceIdx = rest.indexOf(' {"exception"')
  const message = (braceIdx >= 0 ? rest.slice(0, braceIdx) : rest).trim().slice(0, 500)
  const m = rest.match(/\(([A-Za-z0-9_\\]+(?:Exception|Error))\b/) || message.match(/([A-Za-z0-9_\\]+(?:Exception|Error))\b/)
  const exceptionClass = m ? m[1].split('\\').pop() : undefined
  return { exceptionClass, message }
}

// Collapse similar messages: strip numbers, hex, quoted content and paths so
// "User 12 not found" and "User 99 not found" share a fingerprint.
function normalize(msg: string): string {
  return msg
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/["'`][^"'`]*["'`]/g, '"…"')
    .replace(/\/[^\s():]+/g, '/…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

// Tails each active site's laravel.log, groups error lines by fingerprint and
// upserts LogError rows. Read-only against site files; failures are logged.
export function startLogCollector(app: FastifyInstance): void {
  const run = async () => {
    try {
      const sites = await app.prisma.site.findMany({ where: { status: 'active' } }) as any[]
      for (const site of sites) {
        const ctx = await serverCtxById(app.prisma, site.serverId ?? null)
        await collectSite(app, site.id, ctx, `${site.rootPath}/current/storage/logs/laravel.log`).catch(() => {/* per-site, never break the loop */})
      }
    } catch (err: unknown) {
      app.log.warn(`log collector: ${(err as Error).message}`)
    }
  }
  const interval = Number(process.env.LOG_COLLECTOR_INTERVAL_MS ?? 60_000)
  setInterval(run, interval)
  setTimeout(run, 20_000) // first pass shortly after boot
}

// Read the new tail of a site's log (from the last offset) on its own server.
// Local: fs stat + partial read (unchanged). Remote: stat -c %s + tail -c | head.
async function readNewLogBytes(ctx: ServerCtx, siteId: number, logPath: string): Promise<{ text: string; newOffset: number } | null> {
  let size: number
  if (isLocal(ctx)) {
    try { size = (await fs.stat(logPath)).size } catch { return null }
  } else {
    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc', `stat -c %s ${shellEscape(logPath)} 2>/dev/null`])
      size = parseInt(stdout.trim(), 10)
      if (!Number.isFinite(size)) return null
    } catch { return null }
  }

  let start = offsets.get(siteId) ?? Math.max(0, size - 200_000)
  if (size < start) start = 0 // rotated/truncated
  if (size <= start) { offsets.set(siteId, size); return { text: '', newOffset: size } }
  const toRead = Math.min(size - start, 2_000_000) // cap 2MB/pass

  if (isLocal(ctx)) {
    const fh = await fs.open(logPath, 'r')
    try {
      const buf = Buffer.alloc(toRead)
      const { bytesRead } = await fh.read(buf, 0, toRead, start)
      return { text: buf.subarray(0, bytesRead).toString('utf-8'), newOffset: start + bytesRead }
    } finally { await fh.close() }
  }
  // Remote: base64 the byte range so arbitrary bytes survive the SSH channel.
  const { stdout } = await execOn(ctx, 'bash',
    ['-lc', `tail -c +${start + 1} ${shellEscape(logPath)} 2>/dev/null | head -c ${toRead} | base64 -w0`],
    { maxBuffer: 8 * 1024 * 1024 })
  const buf = Buffer.from(stdout.trim(), 'base64')
  return { text: buf.toString('utf-8'), newOffset: start + buf.length }
}

async function collectSite(app: FastifyInstance, siteId: number, ctx: ServerCtx, logPath: string): Promise<void> {
  const chunk = await readNewLogBytes(ctx, siteId, logPath)
  if (!chunk || !chunk.text) { if (chunk) offsets.set(siteId, chunk.newOffset); return }
  const text = chunk.text

  {
    const groups = new Map<string, { level: string; exceptionClass?: string; message: string; sample: string; count: number; last: Date }>()
    for (const line of text.split('\n')) {
      const mm = HEADER.exec(line)
      if (!mm) continue // continuation / stack-trace line — skip
      const ts = new Date(mm[1].replace(' ', 'T'))
      const level = mm[2].toLowerCase()
      const { exceptionClass, message } = extractException(mm[3])
      const fp = crypto.createHash('sha1').update(`${siteId}|${exceptionClass ?? ''}|${normalize(message)}`).digest('hex').slice(0, 16)
      const g = groups.get(fp) ?? { level, exceptionClass, message, sample: line.slice(0, 1000), count: 0, last: ts }
      g.count++
      g.last = isNaN(ts.getTime()) ? new Date() : ts
      groups.set(fp, g)
    }

    for (const [fp, g] of groups) {
      const existing = await app.prisma.logError.findUnique({ where: { siteId_fingerprint: { siteId, fingerprint: fp } } })
      if (existing?.ignored) continue // muted group — never re-surface
      if (existing) {
        await app.prisma.logError.update({
          where: { id: existing.id },
          data: { count: existing.count + g.count, lastSeenAt: g.last, resolved: false, level: g.level, message: g.message, sample: g.sample }
        })
      } else {
        await app.prisma.logError.create({
          data: { siteId, fingerprint: fp, level: g.level, exceptionClass: g.exceptionClass ?? null, message: g.message, sample: g.sample, count: g.count, firstSeenAt: g.last, lastSeenAt: g.last }
        })
      }
    }
    offsets.set(siteId, chunk.newOffset)
  }
}
