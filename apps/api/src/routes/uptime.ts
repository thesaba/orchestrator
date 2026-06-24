import { FastifyPluginAsync } from 'fastify'

export const uptimeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET /uptime — latest status per active site
  app.get('/uptime', async () => {
    const sites = await app.prisma.site.findMany({
      where: { status: 'active' },
      select: { id: true, domain: true, uptimeMonitor: true }
    })

    const results = await Promise.all(
      sites.map(async (site) => {
        const latest = await app.prisma.uptimeCheck.findFirst({
          where: { siteId: site.id },
          orderBy: { checkedAt: 'desc' }
        })
        return {
          siteId: site.id,
          domain: site.domain,
          monitoring: site.uptimeMonitor,
          status: latest?.status ?? 'unknown',
          responseMs: latest?.responseMs ?? null,
          statusCode: latest?.statusCode ?? null,
          checkedAt: latest?.checkedAt ?? null
        }
      })
    )

    return { sites: results }
  })

  // GET /uptime/:siteId/history — last 24h checks for charts
  app.get('/uptime/:siteId/history', async (request, reply) => {
    const siteId = Number((request.params as { siteId: string }).siteId)
    const since = new Date(Date.now() - 24 * 60 * 60_000)

    const checks = await app.prisma.uptimeCheck.findMany({
      where: { siteId, checkedAt: { gte: since } },
      orderBy: { checkedAt: 'asc' },
      take: 300
    })

    const up = checks.filter((c) => c.status === 'up').length
    const uptime = checks.length > 0 ? Math.round((up / checks.length) * 100) : null

    return { checks, uptime24h: uptime }
  })

  // PATCH /uptime/:siteId — toggle monitoring on/off per site
  app.patch('/uptime/:siteId', {
    schema: {
      body: {
        type: 'object',
        required: ['monitoring'],
        properties: { monitoring: { type: 'boolean' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { siteId: string }).siteId)
    const { monitoring } = request.body as { monitoring: boolean }
    await app.prisma.site.update({ where: { id: siteId }, data: { uptimeMonitor: monitoring } })
    return { ok: true, monitoring }
  })
}
