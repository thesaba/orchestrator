import { FastifyPluginAsync } from 'fastify'

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET /api/audit?siteId=1&limit=50&offset=0
  app.get('/', async (request) => {
    const q = request.query as { siteId?: string; limit?: string; offset?: string }
    const where = q.siteId ? { siteId: Number(q.siteId) } : {}
    const take  = Math.min(Number(q.limit ?? 50), 200)
    const skip  = Number(q.offset ?? 0)

    const [logs, total] = await Promise.all([
      app.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      app.prisma.auditLog.count({ where })
    ])

    return {
      logs: logs.map((l) => ({
        ...l,
        meta: l.meta ? JSON.parse(l.meta) : null
      })),
      total,
      limit: take,
      offset: skip
    }
  })
}
