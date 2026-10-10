import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { readSecret } from './crypto'
import { createNotification } from './notifications'
import { sendNotification } from './notify'

/**
 * Central panel event bus. `emitEvent` is fire-and-forget: it NEVER blocks or
 * throws into the caller (so wiring it into deploy/uptime/billing paths can't
 * affect them), and dispatches to two consumers:
 *   1. outbound webhooks (HMAC-signed POSTs)
 *   2. automation rules (off by default; dry-run by default)
 *
 * Actions are deliberately limited to NON-site-affecting ones (notify, telegram,
 * webhook) so no automation can ever disrupt a hosted site.
 */

export type EventPayload = Record<string, unknown>

export function emitEvent(app: FastifyInstance, type: string, payload: EventPayload): void {
  void dispatch(app, type, payload).catch((e) => {
    try { app.log.warn(`event ${type} dispatch failed: ${(e as Error).message}`) } catch { /* noop */ }
  })
}

async function dispatch(app: FastifyInstance, type: string, payload: EventPayload): Promise<void> {
  await Promise.allSettled([
    deliverWebhooks(app, type, payload),
    runAutomation(app, type, payload)
  ])
}

// ── Outbound webhooks ─────────────────────────────────────────────────────────

async function deliverWebhooks(app: FastifyInstance, type: string, payload: EventPayload): Promise<void> {
  const db = app.prisma as any
  const hooks = await db.webhook.findMany({ where: { active: true } }).catch(() => [])
  if (!hooks.length) return

  const body = JSON.stringify({ event: type, data: payload, at: new Date().toISOString() })

  for (const h of hooks) {
    let events: string[] = []
    try { events = JSON.parse(h.events || '[]') } catch { /* [] */ }
    if (events.length && !events.includes(type)) continue // [] means "all events"

    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-orchestrator-event': type }
    const secret = readSecret(h.secret)
    if (secret) {
      headers['x-orchestrator-signature'] = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    let statusCode: number | null = null
    let success = false
    let error: string | null = null
    try {
      const res = await fetch(h.url, { method: 'POST', headers, body, signal: ctrl.signal })
      statusCode = res.status
      success = res.ok
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e) {
      error = (e as Error).message
    } finally {
      clearTimeout(timer)
    }

    await db.webhookDelivery.create({ data: { webhookId: h.id, event: type, success, statusCode, error } }).catch(() => {})
    const stale = await db.webhookDelivery
      .findMany({ where: { webhookId: h.id }, orderBy: { createdAt: 'desc' }, skip: 100, select: { id: true } })
      .catch(() => [])
    if (stale.length) await db.webhookDelivery.deleteMany({ where: { id: { in: stale.map((s: any) => s.id) } } }).catch(() => {})
  }
}

// ── Automation rules ──────────────────────────────────────────────────────────

type Cond = { field: string; op: string; value: unknown }

function deref(payload: EventPayload, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), payload)
}

function evalConditions(conds: Cond[], payload: EventPayload): boolean {
  if (!conds.length) return true
  return conds.every((c) => {
    const actual = deref(payload, c.field)
    switch (c.op) {
      case 'eq':       return String(actual) === String(c.value)
      case 'neq':      return String(actual) !== String(c.value)
      case 'gt':       return Number(actual) > Number(c.value)
      case 'gte':      return Number(actual) >= Number(c.value)
      case 'lt':       return Number(actual) < Number(c.value)
      case 'lte':      return Number(actual) <= Number(c.value)
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(c.value).toLowerCase())
      default:         return false
    }
  })
}

function interpolate(tpl: string, payload: EventPayload): string {
  return String(tpl ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => {
    const v = deref(payload, k)
    return v == null ? '' : String(v)
  })
}

function describeAction(type: string, cfg: any): string {
  if (type === 'notify')   return `notify: ${cfg.title ?? ''}`
  if (type === 'telegram') return `telegram: ${cfg.message ?? cfg.title ?? ''}`
  if (type === 'webhook')  return `POST ${cfg.url ?? ''}`
  return type
}

async function executeAction(
  app: FastifyInstance, type: string, cfg: any, eventType: string, payload: EventPayload
): Promise<string> {
  if (type === 'notify') {
    await createNotification(app, {
      type: 'automation',
      level: (cfg.level as any) ?? 'info',
      title: interpolate(cfg.title ?? `Automation: ${eventType}`, payload),
      body: interpolate(cfg.body ?? '', payload)
    })
    return 'notification created'
  }
  if (type === 'telegram') {
    await sendNotification(app, {
      title: interpolate(cfg.title ?? eventType, payload),
      subject: interpolate(cfg.message ?? '', payload),
      status: cfg.level === 'critical' ? 'failed' : 'warning',
      fields: []
    })
    return 'telegram sent'
  }
  if (type === 'webhook') {
    const url = cfg.url
    if (!url) throw new Error('webhook action has no url')
    const body = JSON.stringify({ event: eventType, data: payload, at: new Date().toISOString() })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal })
      return `POST ${url} → ${res.status}`
    } finally {
      clearTimeout(timer)
    }
  }
  // Site-affecting actions are intentionally NOT implemented in this build, so no
  // automation can ever disrupt a hosted site.
  throw new Error(`Unknown or disabled action type: ${type}`)
}

async function runAutomation(app: FastifyInstance, type: string, payload: EventPayload): Promise<void> {
  const db = app.prisma as any
  const rules = await db.automationRule.findMany({ where: { enabled: true, trigger: type } }).catch(() => [])
  for (const rule of rules) {
    let conds: Cond[] = []
    try { conds = JSON.parse(rule.conditions || '[]') } catch { /* [] */ }
    const matched = evalConditions(conds, payload)

    if (!matched) {
      await db.automationRun.create({ data: { ruleId: rule.id, event: type, matched: false, dryRun: rule.dryRun } }).catch(() => {})
      continue
    }

    let cfg: any = {}
    try { cfg = JSON.parse(rule.actionConfig || '{}') } catch { /* {} */ }

    let actionTaken = ''
    let detail = ''
    if (rule.dryRun) {
      actionTaken = `would ${rule.actionType}`
      detail = describeAction(rule.actionType, cfg)
    } else {
      try {
        detail = await executeAction(app, rule.actionType, cfg, type, payload)
        actionTaken = rule.actionType
      } catch (e) {
        actionTaken = 'error'
        detail = (e as Error).message
      }
    }

    await db.automationRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } }).catch(() => {})
    await db.automationRun.create({
      data: { ruleId: rule.id, event: type, matched: true, dryRun: rule.dryRun, actionTaken, detail }
    }).catch(() => {})

    const stale = await db.automationRun
      .findMany({ where: { ruleId: rule.id }, orderBy: { createdAt: 'desc' }, skip: 100, select: { id: true } })
      .catch(() => [])
    if (stale.length) await db.automationRun.deleteMany({ where: { id: { in: stale.map((s: any) => s.id) } } }).catch(() => {})
  }
}

// The catalogue of events the panel can emit (for the UI dropdowns).
export const EVENT_TYPES = [
  'deploy.succeeded',
  'deploy.failed',
  'site.down',
  'site.up',
  'ssl.expiring',
  'billing.invoice_paid',
  'billing.suspended',
  'billing.restored'
] as const
