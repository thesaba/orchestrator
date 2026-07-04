import { FastifyInstance } from 'fastify'
import { promises as fs } from 'fs'
import crypto from 'crypto'

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
      const sites = await app.prisma.site.findMany({ where: { status: 'active' }, select: { id: true, rootPath: true } })
      for (const site of sites) {
        await collectSite(app, site.id, `${site.rootPath}/current/storage/logs/laravel.log`)
      }
    } catch (err: unknown) {
      app.log.warn(`log collector: ${(err as Error).message}`)
    }
  }
  const interval = Number(process.env.LOG_COLLECTOR_INTERVAL_MS ?? 60_000)
  setInterval(run, interval)
  setTimeout(run, 20_000) // first pass shortly after boot
}

async function collectSite(app: FastifyInstance, siteId: number, logPath: string): Promise<void> {
  let stat
  try { stat = await fs.stat(logPath) } catch { return } // no log yet

  // First time we see this site, start ~200KB from the end so we don't ingest
  // the whole historical log; afterwards continue from the last offset.
  let start = offsets.get(siteId) ?? Math.max(0, stat.size - 200_000)
  if (stat.size < start) start = 0 // file was rotated/truncated
  if (stat.size <= start) { offsets.set(siteId, stat.size); return }

  const fh = await fs.open(logPath, 'r')
  try {
    const toRead = Math.min(stat.size - start, 2_000_000) // cap 2MB per pass
    const buf = Buffer.alloc(toRead)
    const { bytesRead } = await fh.read(buf, 0, toRead, start)
    const text = buf.subarray(0, bytesRead).toString('utf-8')

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
    offsets.set(siteId, start + bytesRead)
  } finally {
    await fh.close()
  }
}
