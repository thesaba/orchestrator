import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { writeSecret, readSecret } from '../lib/crypto'
import { EVENT_TYPES } from '../lib/events'

// Automation & outbound webhooks management. Admin-only. Everything is off by
// default (webhook.active=false, rule.enabled=false, rule.dryRun=true), so
// creating these never changes behaviour until explicitly turned on.

const ACTION_TYPES = ['notify', 'telegram', 'webhook'] as const

export const automationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  const db = app.prisma as any

  const publicHook = (h: any) => ({
    id: h.id, name: h.name, url: h.url, events: safeJson(h.events, []),
    active: h.active, hasSecret: !!h.secret, createdAt: h.createdAt
  })

  app.get('/event-types', async () => ({ events: EVENT_TYPES, actions: ACTION_TYPES }))

  // ── Webhooks ────────────────────────────────────────────────────────────────
  app.get('/webhooks', async () => {
    const hooks = await db.webhook.findMany({ orderBy: { createdAt: 'desc' } })
    return { webhooks: hooks.map(publicHook) }
  })

  app.post('/webhooks', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name:   { type: 'string', minLength: 1, maxLength: 100 },
          url:    { type: 'string', minLength: 1, maxLength: 2000 },
          secret: { type: 'string', maxLength: 200 },
          events: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          active: { type: 'boolean' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const b = request.body as any
    if (!/^https?:\/\//i.test(b.url)) return reply.code(400).send({ error: 'URL must start with http:// or https://' })
    const hook = await db.webhook.create({
      data: {
        name: b.name, url: b.url,
        secret: b.secret ? writeSecret(b.secret) : null,
        events: JSON.stringify(b.events ?? []),
        active: !!b.active
      }
    })
    app.audit('webhook.created', { req: request, meta: { id: hook.id } })
    reply.code(201)
    return publicHook(hook)
  })

  app.patch('/webhooks/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string', minLength: 1, maxLength: 100 },
          url:    { type: 'string', minLength: 1, maxLength: 2000 },
          secret: { type: 'string', maxLength: 200 },
          events: { type: 'array', items: { type: 'string' }, maxItems: 50 },
          active: { type: 'boolean' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as any).id)
    const b = request.body as any
    if (b.url !== undefined && !/^https?:\/\//i.test(b.url)) return reply.code(400).send({ error: 'URL must start with http:// or https://' })
    const data: any = {}
    if (b.name !== undefined) data.name = b.name
    if (b.url !== undefined) data.url = b.url
    if (b.secret !== undefined) data.secret = b.secret ? writeSecret(b.secret) : null
    if (b.events !== undefined) data.events = JSON.stringify(b.events)
    if (b.active !== undefined) data.active = b.active
    const hook = await db.webhook.update({ where: { id }, data }).catch(() => null)
    if (!hook) return reply.code(404).send({ error: 'Webhook not found' })
    app.audit('webhook.updated', { req: request, meta: { id } })
    return publicHook(hook)
  })

  app.delete('/webhooks/:id', async (request) => {
    const id = Number((request.params as any).id)
    await db.webhook.delete({ where: { id } }).catch(() => {})
    app.audit('webhook.deleted', { req: request, meta: { id } })
    return { ok: true }
  })

  app.get('/webhooks/:id/deliveries', async (request) => {
    const id = Number((request.params as any).id)
    const deliveries = await db.webhookDelivery.findMany({ where: { webhookId: id }, orderBy: { createdAt: 'desc' }, take: 50 })
    return { deliveries }
  })

  // Fire a one-off test delivery so the operator can confirm the endpoint works.
  app.post('/webhooks/:id/test', async (request, reply) => {
    const id = Number((request.params as any).id)
    const h = await db.webhook.findUnique({ where: { id } })
    if (!h) return reply.code(404).send({ error: 'Webhook not found' })
    const body = JSON.stringify({ event: 'test.ping', data: { message: 'Orchestrator test delivery' }, at: new Date().toISOString() })
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-orchestrator-event': 'test.ping' }
    const secret = readSecret(h.secret)
    if (secret) headers['x-orchestrator-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(h.url, { method: 'POST', headers, body, signal: ctrl.signal })
      await db.webhookDelivery.create({ data: { webhookId: id, event: 'test.ping', success: res.ok, statusCode: res.status, error: res.ok ? null : `HTTP ${res.status}` } }).catch(() => {})
      return { ok: res.ok, statusCode: res.status }
    } catch (e) {
      await db.webhookDelivery.create({ data: { webhookId: id, event: 'test.ping', success: false, statusCode: null, error: (e as Error).message } }).catch(() => {})
      return reply.code(502).send({ ok: false, error: (e as Error).message })
    } finally {
      clearTimeout(timer)
    }
  })

  // ── Automation rules ──────────────────────────────────────────────────────
  app.get('/rules', async () => {
    const rules = await db.automationRule.findMany({ orderBy: { createdAt: 'desc' } })
    return { rules: rules.map((r: any) => ({ ...r, conditions: safeJson(r.conditions, []), actionConfig: safeJson(r.actionConfig, {}) })) }
  })

  const ruleBody = {
    type: 'object',
    properties: {
      name:         { type: 'string', minLength: 1, maxLength: 100 },
      trigger:      { type: 'string', minLength: 1, maxLength: 64 },
      conditions:   { type: 'array', maxItems: 20 },
      actionType:   { type: 'string', enum: ACTION_TYPES as unknown as string[] },
      actionConfig: { type: 'object' },
      enabled:      { type: 'boolean' },
      dryRun:       { type: 'boolean' }
    },
    additionalProperties: false
  }

  app.post('/rules', { schema: { body: { ...ruleBody, required: ['name', 'trigger', 'actionType'] } } }, async (request, reply) => {
    const b = request.body as any
    const rule = await db.automationRule.create({
      data: {
        name: b.name, trigger: b.trigger,
        conditions: JSON.stringify(b.conditions ?? []),
        actionType: b.actionType,
        actionConfig: JSON.stringify(b.actionConfig ?? {}),
        enabled: !!b.enabled,
        dryRun: b.dryRun === undefined ? true : !!b.dryRun
      }
    })
    app.audit('automation.rule_created', { req: request, meta: { id: rule.id } })
    reply.code(201)
    return rule
  })

  app.patch('/rules/:id', { schema: { body: ruleBody } }, async (request, reply) => {
    const id = Number((request.params as any).id)
    const b = request.body as any
    const data: any = {}
    if (b.name !== undefined) data.name = b.name
    if (b.trigger !== undefined) data.trigger = b.trigger
    if (b.conditions !== undefined) data.conditions = JSON.stringify(b.conditions)
    if (b.actionType !== undefined) data.actionType = b.actionType
    if (b.actionConfig !== undefined) data.actionConfig = JSON.stringify(b.actionConfig)
    if (b.enabled !== undefined) data.enabled = b.enabled
    if (b.dryRun !== undefined) data.dryRun = b.dryRun
    const rule = await db.automationRule.update({ where: { id }, data }).catch(() => null)
    if (!rule) return reply.code(404).send({ error: 'Rule not found' })
    app.audit('automation.rule_updated', { req: request, meta: { id } })
    return rule
  })

  app.delete('/rules/:id', async (request) => {
    const id = Number((request.params as any).id)
    await db.automationRule.delete({ where: { id } }).catch(() => {})
    app.audit('automation.rule_deleted', { req: request, meta: { id } })
    return { ok: true }
  })

  app.get('/rules/:id/runs', async (request) => {
    const id = Number((request.params as any).id)
    const runs = await db.automationRun.findMany({ where: { ruleId: id }, orderBy: { createdAt: 'desc' }, take: 50 })
    return { runs }
  })
}

function safeJson(s: string | null | undefined, fallback: unknown) {
  try { return JSON.parse(s || '') } catch { return fallback }
}
