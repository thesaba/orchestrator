import { FastifyPluginAsync } from 'fastify'
import { writeSecret } from '../lib/crypto'
import { getSetting, setSetting } from '../lib/telegram'
import { getAiConfig, aiComplete, redact, clip, SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, todayUsage, ChatMessage } from '../lib/ai'

// AI assistant (read-only / advisory). Admin-only: it reads error/deploy data
// and returns an explanation — it never changes a site.
export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET /config — current AI config (never the key itself) + usage.
  app.get('/config', async () => {
    const cfg = await getAiConfig(app)
    return {
      enabled: cfg.enabled, provider: cfg.provider, model: cfg.model,
      baseUrl: await getSetting(app, 'ai_base_url'), configured: !!cfg.apiKey,
      usageToday: await todayUsage(app),
      dailyLimit: Number((await getSetting(app, 'ai_daily_limit')) || '0')
    }
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
          apiKey: { type: 'string', maxLength: 300 },
          dailyLimit: { type: 'integer', minimum: 0, maximum: 100000 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const b = request.body as { enabled?: boolean; provider?: string; model?: string; baseUrl?: string; apiKey?: string; dailyLimit?: number }
    if (b.enabled !== undefined) await setSetting(app, 'ai_enabled', b.enabled ? '1' : '')
    if (b.provider !== undefined) await setSetting(app, 'ai_provider', b.provider)
    if (b.model !== undefined) await setSetting(app, 'ai_model', b.model)
    if (b.baseUrl !== undefined) await setSetting(app, 'ai_base_url', b.baseUrl)
    if (b.dailyLimit !== undefined) await setSetting(app, 'ai_daily_limit', String(b.dailyLimit))
    if (b.apiKey) await setSetting(app, 'ai_api_key', writeSecret(b.apiKey)) // encrypted at rest
    app.audit('ai.config', { req: request, meta: { enabled: b.enabled, provider: b.provider } })
    return { ok: true }
  })

  // POST /test — quick connectivity/key check.
  app.post('/test', async (_request, reply) => {
    try {
      const reply2 = await aiComplete(app, { system: 'You are a health check.', user: 'Reply with the single word: OK', maxTokens: 5 })
      return { ok: true, reply: reply2 }
    } catch (e: unknown) {
      const err = e as { code?: number; message: string }
      return reply.code(err.code === 400 ? 400 : 502).send({ error: err.message })
    }
  })

  // POST /chat — free-form assistant, optionally grounded in a site's context.
  app.post('/chat', {
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          siteId: { type: 'integer' },
          history: {
            type: 'array', maxItems: 20,
            items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string', maxLength: 4000 } }, required: ['role', 'content'], additionalProperties: false }
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { message, siteId, history } = request.body as { message: string; siteId?: number; history?: ChatMessage[] }

    // Optional per-site context (redacted).
    let context = ''
    if (siteId) {
      const site = await app.prisma.site.findUnique({
        where: { id: siteId },
        select: { domain: true, phpVersion: true, status: true, maintenanceMode: true, deployments: { take: 1, orderBy: { createdAt: 'desc' }, select: { status: true, branch: true, commit: true } } }
      })
      if (site) {
        const errs = await app.prisma.logError.findMany({ where: { siteId, resolved: false, ignored: false }, orderBy: { lastSeenAt: 'desc' }, take: 5, select: { exceptionClass: true, message: true, count: true } })
        const last = site.deployments[0]
        context =
          `CONTEXT — site ${site.domain} (PHP ${site.phpVersion}), status ${site.status}${site.maintenanceMode ? ' (maintenance)' : ''}. ` +
          `Last deploy: ${last ? `${last.status} ${last.branch}${last.commit ? ` @ ${last.commit}` : ''}` : '—'}.\n` +
          `Recent unresolved errors:\n${errs.length ? errs.map((e: { exceptionClass: string | null; message: string; count: number }) => `- ${e.exceptionClass ?? ''}: ${redact(e.message)} (×${e.count})`).join('\n') : 'none'}`
      }
    }

    const msgs: ChatMessage[] = []
    for (const h of (history ?? []).slice(-10)) {
      msgs.push({ role: h.role, content: h.role === 'user' ? redact(clip(h.content, 4000)) : h.content })
    }
    msgs.push({ role: 'user', content: (context ? `${context}\n\n` : '') + `Question: ${redact(clip(message, 4000))}` })

    try {
      const answer = await aiComplete(app, { system: CHAT_SYSTEM_PROMPT, messages: msgs, maxTokens: 900 })
      app.audit('ai.chat', { req: request, meta: { siteId } })
      return { reply: answer }
    } catch (e: unknown) {
      const err = e as { code?: number; message: string }
      return reply.code(err.code === 400 ? 400 : err.code === 429 ? 429 : 502).send({ error: err.message })
    }
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
