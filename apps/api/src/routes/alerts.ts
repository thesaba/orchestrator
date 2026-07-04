import { FastifyPluginAsync } from 'fastify'

const METRICS = ['cpu', 'ram', 'disk', 'swap']
const OPERATORS = ['gt', 'lt']

// Threshold alert rules for system metrics. Admin-only — these drive automated
// notifications and channel alerts.
export const alertsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  app.get('/', async () => {
    const rules = await app.prisma.alertRule.findMany({ orderBy: { createdAt: 'asc' } })
    return { rules }
  })

  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['metric', 'threshold'],
        properties: {
          metric:       { type: 'string', enum: METRICS },
          operator:     { type: 'string', enum: OPERATORS },
          threshold:    { type: 'integer', minimum: 0, maximum: 100 },
          cooldownMins: { type: 'integer', minimum: 1, maximum: 1440 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const b = request.body as { metric: string; operator?: string; threshold: number; cooldownMins?: number }
    const rule = await app.prisma.alertRule.create({
      data: { metric: b.metric, operator: b.operator ?? 'gt', threshold: b.threshold, cooldownMins: b.cooldownMins ?? 30 }
    })
    app.audit('alert.created', { req: request, meta: { ruleId: rule.id, metric: b.metric, threshold: b.threshold } })
    reply.code(201)
    return rule
  })

  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled:      { type: 'boolean' },
          operator:     { type: 'string', enum: OPERATORS },
          threshold:    { type: 'integer', minimum: 0, maximum: 100 },
          cooldownMins: { type: 'integer', minimum: 1, maximum: 1440 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const b = request.body as { enabled?: boolean; operator?: string; threshold?: number; cooldownMins?: number }
    const rule = await app.prisma.alertRule.update({
      where: { id },
      data: {
        ...(b.enabled !== undefined && { enabled: b.enabled }),
        ...(b.operator !== undefined && { operator: b.operator }),
        ...(b.threshold !== undefined && { threshold: b.threshold }),
        ...(b.cooldownMins !== undefined && { cooldownMins: b.cooldownMins })
      }
    }).catch(() => null)
    if (!rule) return reply.code(404).send({ error: 'Rule not found' })
    return rule
  })

  app.delete('/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    await app.prisma.alertRule.delete({ where: { id } }).catch(() => {})
    return { ok: true }
  })
}
