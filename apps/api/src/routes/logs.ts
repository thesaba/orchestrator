import { FastifyPluginAsync } from 'fastify'
import path from 'path'
import { serverCtxForSite } from '../lib/servers'
import { writeFileOn } from '../lib/server-fs'
import { execOn } from '../lib/server-exec'
import { shellEscape } from '../lib/ssh'

const LOG_LEVELS = ['emergency','alert','critical','error','warning','notice','info','debug']

// Cap how much of the log we read into memory — a Laravel log can be hundreds
// of MB and reading it whole into a Buffer can OOM the API. ~2MB of tail is
// plenty of recent entries for the viewer.
const MAX_TAIL_BYTES = 2_000_000
async function tailBytes(ctx: Awaited<ReturnType<typeof serverCtxForSite>>, p: string): Promise<string> {
  const { stdout } = await execOn(ctx, 'bash', ['-lc', `tail -c ${MAX_TAIL_BYTES} ${shellEscape(p)}`])
  return stdout
}

export const logsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // GET /:id/logs?level=error&search=query&lines=200
  app.get('/:id/logs', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { level, search, lines: linesParam } = request.query as { level?: string; search?: string; lines?: string }
    const maxLines = Math.min(Number(linesParam ?? 500), 2000)

    const logPath = path.join(site.rootPath, 'shared', 'logs', 'laravel.log')
    // Also try current/storage/logs/laravel.log
    const altLogPath = path.join(site.rootPath, 'current', 'storage', 'logs', 'laravel.log')

    const ctx = await serverCtxForSite(app.prisma, site)
    let content = ''
    let usedPath = logPath
    try {
      content = await tailBytes(ctx, logPath)
    } catch {
      try {
        content = await tailBytes(ctx, altLogPath)
        usedPath = altLogPath
      } catch {
        return { entries: [], total: 0, path: logPath }
      }
    }

    // Parse Laravel log entries (each starts with [YYYY-MM-DD HH:MM:SS])
    const rawEntries = content.split(/\n(?=\[\d{4}-\d{2}-\d{2})/).filter(Boolean)
    const entries = rawEntries.slice(-maxLines).map((raw) => {
      const m = raw.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] (\w+)\.(\w+): (.*)$/s)
      if (!m) return { timestamp: null, environment: null, level: 'unknown', message: raw.trim() }
      return {
        timestamp: m[1],
        environment: m[2],
        level: m[3].toLowerCase(),
        message: (m[4] ?? '').trim()
      }
    }).reverse() // newest first

    const filtered = entries
      .filter(e => !level || e.level === level.toLowerCase())
      .filter(e => !search || e.message.toLowerCase().includes(search.toLowerCase()))

    return { entries: filtered.slice(0, maxLines), total: filtered.length, path: usedPath }
  })

  // DELETE /:id/logs — clear the log file
  app.delete('/:id/logs', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const logPath = path.join(site.rootPath, 'shared', 'logs', 'laravel.log')
    const altLogPath = path.join(site.rootPath, 'current', 'storage', 'logs', 'laravel.log')
    let cleared = false
    for (const p of [logPath, altLogPath]) {
      try { await writeFileOn(ctx, p, ''); cleared = true; break } catch {}
    }
    return { ok: cleared }
  })
}
