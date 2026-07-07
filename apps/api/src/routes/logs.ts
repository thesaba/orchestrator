import { FastifyPluginAsync } from 'fastify'
import path from 'path'
import { serverCtxForSite } from '../lib/servers'
import { readFileOn, writeFileOn } from '../lib/server-fs'

const LOG_LEVELS = ['emergency','alert','critical','error','warning','notice','info','debug']

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
      content = await readFileOn(ctx, logPath)
    } catch {
      try {
        content = await readFileOn(ctx, altLogPath)
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
