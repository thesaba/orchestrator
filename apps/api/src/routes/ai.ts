import { FastifyPluginAsync } from 'fastify'
import { writeSecret } from '../lib/crypto'
import { getSetting, setSetting } from '../lib/telegram'
import { getAiConfig, aiComplete, redact, clip, SYSTEM_PROMPT } from '../lib/ai'

// AI assistant (read-only / advisory). Admin-only: it reads error/deploy data
// and returns an explanation — it never changes a site.
export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET /config — current AI config (never the key itself).
  app.get('/config', async () => {
    const cfg = await getAiConfig(app)
    return { enabled: cfg.enabled, provider: cfg.provider, model: cfg.model, baseUrl: await getSetting(app, 'ai_base_url'), configured: !!cfg.apiKey }
  })

  // PATCH /config — provider/model/base URL/enable + (optional) API key.
  app.patch('/config', {
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          provider: { type: 'string', enum: ['openai', 'anthropic'] },
          model: { type: 'string', maxLength: 100 },
          baseUrl: { type: 'string', maxLength: 300 },
          apiKey: { type: 'string', maxLength: 300 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const b = request.body as { enabled?: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string }
    if (b.enabled !== undefined) await setSetting(app, 'ai_enabled', b.enabled ? '1' : '')
    if (b.provider !== undefined) await setSetting(app, 'ai_provider', b.provider)
    if (b.model !== undefined) await setSetting(app, 'ai_model', b.model)
    if (b.baseUrl !== undefined) await setSetting(app, 'ai_base_url', b.baseUrl)
    if (b.apiKey) await setSetting(app, 'ai_api_key', writeSecret(b.apiKey)) // encrypted at rest
    app.audit('ai.config', { req: request, meta: { enabled: b.enabled, provider: b.provider } })
    return { ok: true }
  })

  // POST /explain-error/:id?force=1 — explain a grouped error (cached).
  app.post('/explain-error/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const force = (request.query as { force?: string }).force === '1'
    const err = await app.prisma.logError.findUnique({
      where: { id },
      include: { site: { select: { domain: true, phpVersion: true } } }
    })
    if (!err) return reply.code(404).send({ error: 'Error not found' })
    if (err.aiExplanation && !force) return { explanation: err.aiExplanation, cached: true }

    const user =
      `Site: ${err.site?.domain} (PHP ${err.site?.phpVersion})\n` +
      `Level: ${err.level}\nException: ${err.exceptionClass ?? '—'}\nOccurrences: ${err.count}\n` +
      `Message: ${redact(err.message)}\n\nRaw log line:\n${redact(clip(err.sample ?? '', 3000))}`
    try {
      const explanation = await aiComplete(app, { system: SYSTEM_PROMPT, user })
      await app.prisma.logError.update({ where: { id }, data: { aiExplanation: explanation } })
      app.audit('ai.explain_error', { req: request, meta: { errorId: id } })
      return { explanation, cached: false }
    } catch (e: unknown) {
      const err2 = e as { code?: number; message: string }
      return reply.code(err2.code === 400 ? 400 : 502).send({ error: err2.message })
    }
  })

  // POST /explain-deploy/:deploymentId — diagnose a deploy from its log.
  app.post('/explain-deploy/:deploymentId', async (request, reply) => {
    const id = Number((request.params as { deploymentId: string }).deploymentId)
    const dep = await app.prisma.deployment.findUnique({
      where: { id },
      include: { site: { select: { domain: true, phpVersion: true } } }
    })
    if (!dep) return reply.code(404).send({ error: 'Deployment not found' })
    if (!dep.log) return reply.code(400).send({ error: 'This deployment has no log to analyse.' })

    const user =
      `Site: ${dep.site?.domain} (PHP ${dep.site?.phpVersion})\n` +
      `Deploy status: ${dep.status}\nBranch: ${dep.branch}${dep.commit ? ` @ ${dep.commit}` : ''}\n\n` +
      `Deploy log (tail):\n${redact(clip(dep.log, 6000))}`
    try {
      const explanation = await aiComplete(app, { system: SYSTEM_PROMPT, user, maxTokens: 800 })
      app.audit('ai.explain_deploy', { req: request, meta: { deploymentId: id } })
      return { explanation }
    } catch (e: unknown) {
      const err2 = e as { code?: number; message: string }
      return reply.code(err2.code === 400 ? 400 : 502).send({ error: err2.message })
    }
  })
}
