import { FastifyPluginAsync } from 'fastify'

// Grouped application errors (mini-Sentry). Admin-only — error samples can
// contain sensitive request data, so triage is limited to admins.
export const logErrorsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET / — grouped errors across sites, filterable.
  app.get('/', async (request) => {
    const q = request.query as { siteId?: string; search?: string; resolved?: string }
    const where: Record<string, unknown> = {}
    if (q.siteId) where.siteId = Number(q.siteId)
    if (q.resolved === '0') where.resolved = false
    if (q.resolved === '1') where.resolved = true
    if (q.search) {
      where.OR = [
        { message: { contains: q.search } },
        { exceptionClass: { contains: q.search } }
      ]
    }

    const [errors, unresolved] = await Promise.all([
      app.prisma.logError.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        take: 200,
        select: {
          id: true, siteId: true, level: true, exceptionClass: true, message: true,
          count: true, firstSeenAt: true, lastSeenAt: true, resolved: true,
          site: { select: { domain: true } }
        }
      }),
      app.prisma.logError.count({ where: { resolved: false } })
    ])
    return { errors, unresolved }
  })

  // GET /:id — full detail + the deploy that was live when it first appeared.
  app.get('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const err = await app.prisma.logError.findUnique({
      where: { id },
      include: { site: { select: { id: true, domain: true } } }
    })
    if (!err) return reply.code(404).send({ error: 'Not found' })

    // Best-effort: the most recent deploy at or before the first occurrence.
    const introducedBy = await app.prisma.deployment.findFirst({
      where: { siteId: err.siteId, createdAt: { lte: err.firstSeenAt } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, branch: true, commit: true, createdAt: true }
    })
    return { ...err, introducedBy }
  })

  // PATCH /:id — resolve / unresolve.
  app.patch('/:id', {
    schema: { body: { type: 'object', properties: { resolved: { type: 'boolean' } }, additionalProperties: false } }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { resolved } = request.body as { resolved?: boolean }
    const err = await app.prisma.logError.update({
      where: { id },
      data: { ...(resolved !== undefined && { resolved }) }
    }).catch(() => null)
    if (!err) return reply.code(404).send({ error: 'Not found' })
    return err
  })

  // DELETE /:id — dismiss a group.
  app.delete('/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    await app.prisma.logError.delete({ where: { id } }).catch(() => {})
    return { ok: true }
  })
}
