/**
 * Billing REST API — admin only.
 *
 * Everything destructive funnels through lib/billing/enforce.ts, which refuses
 * to act unless the master switch is on. The one exception is `restore`, which
 * an operator may always trigger: relaxing enforcement is never dangerous.
 */

import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { parseMoney, formatMoney, balanceDue } from '../lib/billing/money'
import { DEFAULT_DUNNING_POLICY, parsePolicy, EnforcementLevel } from '../lib/billing/dunning'
import {
  issueInvoiceForSubscription,
  recordPayment,
  openInvoices,
  agingBuckets,
  invoiceBalance,
  mrr
} from '../lib/billing/invoices'
import { applyEnforcement, restoreSite, enforcementMode, ENFORCEMENT_KEY, EnforcementMode } from '../lib/billing/enforce'
import { runBillingTick, previewSubscription } from '../lib/billing/tick'
import { nextInvoiceDate } from '../lib/billing/dunning'

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  const db = app.prisma as any

  // Build the enforcement subject a site needs for apply/restore.
  async function subjectFor(subscriptionId: number) {
    const sub = await db.subscription.findUnique({
      where: { id: subscriptionId },
      include: { site: true, client: true }
    })
    if (!sub || !sub.site) return null
    const unpaid = await db.invoice.findFirst({
      where: { subscriptionId: sub.id, status: { in: ['open', 'partial', 'overdue'] } },
      orderBy: { dueDate: 'asc' }
    })
    return {
      sub,
      subject: {
        siteId: sub.siteId,
        domain: sub.site.domain,
        serverId: sub.site.serverId,
        currentLevel: sub.enforcementLevel as EnforcementLevel,
        neverAutoSuspend: sub.neverAutoSuspend,
        amountDueMinor: unpaid ? balanceDue(unpaid.amount, unpaid.amountPaid) : 0,
        currency: unpaid?.currency ?? sub.currency,
        contact: sub.client?.email ?? sub.client?.phone ?? null,
        locale: sub.client?.locale
      },
      unpaid
    }
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  app.get('/overview', async () => {
    const [subs, unpaid, clients] = await Promise.all([
      db.subscription.findMany({ where: { status: { not: 'cancelled' } } }),
      openInvoices(db),
      db.client.count({ where: { archived: false } })
    ])
    const aging = agingBuckets(unpaid)
    const currency = subs[0]?.currency ?? 'GEL'
    return {
      mode: await enforcementMode(app),
      currency,
      clients,
      subscriptions: subs.length,
      mrr: mrr(subs),
      outstanding: aging.total,
      aging,
      suspended: subs.filter((s: any) => s.enforcementLevel === 'suspend' || s.enforcementLevel === 'archived').length,
      pastDue: subs.filter((s: any) => s.status === 'past_due').length
    }
  })

  // ── Master switch ─────────────────────────────────────────────────────────

  app.get('/enforcement', async () => ({ mode: await enforcementMode(app) }))

  app.put('/enforcement', {
    schema: {
      body: {
        type: 'object',
        required: ['mode'],
        properties: { mode: { type: 'string', enum: ['off', 'dry_run', 'on'] } },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const { mode } = request.body as { mode: EnforcementMode }
    await db.setting.upsert({
      where: { key: ENFORCEMENT_KEY },
      update: { value: mode },
      create: { key: ENFORCEMENT_KEY, value: mode }
    })
    app.audit('billing.enforcement_mode', { req: request, meta: { mode } })
    return { mode }
  })

  /** Run the daily tick now. `dryRun` forces a no-op preview regardless of the switch. */
  app.post('/run-tick', async (request) => {
    const { dryRun } = (request.body ?? {}) as { dryRun?: boolean }
    const report = await runBillingTick(app, { dryRun: !!dryRun })
    app.audit('billing.tick_manual', { req: request, meta: { dryRun: !!dryRun } })
    return report
  })

  // ── Clients ───────────────────────────────────────────────────────────────

  app.get('/clients', async () => {
    const clients = await db.client.findMany({
      orderBy: { name: 'asc' },
      include: { subscriptions: { include: { site: true } } }
    })
    const unpaid = await openInvoices(db)
    return clients.map((c: any) => ({
      ...c,
      outstanding: unpaid
        .filter((i: any) => i.clientId === c.id)
        .reduce((sum: number, i: any) => sum + balanceDue(i.amount, i.amountPaid), 0),
      sites: c.subscriptions.map((s: any) => s.site?.domain).filter(Boolean)
    }))
  })

  app.post('/clients', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          email: { type: 'string', maxLength: 200 },
          phone: { type: 'string', maxLength: 60 },
          telegramChatId: { type: 'string', maxLength: 60 },
          company: { type: 'string', maxLength: 200 },
          taxId: { type: 'string', maxLength: 60 },
          currency: { type: 'string', enum: ['GEL', 'USD', 'EUR'] },
          locale: { type: 'string', enum: ['ka', 'en'] },
          notes: { type: 'string', maxLength: 2000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const client = await db.client.create({
      data: { ...body, portalToken: crypto.randomBytes(24).toString('hex') }
    })
    app.audit('billing.client_created', { req: request, meta: { clientId: client.id } })
    return reply.code(201).send(client)
  })

  app.patch('/clients/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const body = request.body as Record<string, unknown>
    delete body.id; delete body.portalToken
    const client = await db.client.update({ where: { id }, data: body })
    app.audit('billing.client_updated', { req: request, meta: { clientId: id } })
    return client
  })

  app.delete('/clients/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const [subs, invs] = await Promise.all([
      db.subscription.count({ where: { clientId: id } }),
      db.invoice.count({ where: { clientId: id } })
    ])
    if (subs > 0 || invs > 0) {
      return reply.code(400).send({
        error: `Client has ${subs} subscription(s) and ${invs} invoice(s). Archive the client instead of deleting.`
      })
    }
    await db.client.delete({ where: { id } })
    app.audit('billing.client_deleted', { req: request, meta: { clientId: id } })
    return { deleted: true }
  })

  /** Rotate the read-only portal link. */
  app.post('/clients/:id/rotate-token', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const portalToken = crypto.randomBytes(24).toString('hex')
    await db.client.update({ where: { id }, data: { portalToken } })
    app.audit('billing.portal_token_rotated', { req: request, meta: { clientId: id } })
    return { portalToken }
  })

  // ── Plans ─────────────────────────────────────────────────────────────────

  app.get('/plans', async () => db.plan.findMany({ orderBy: { name: 'asc' } }))

  app.post('/plans', async (request, reply) => {
    const b = request.body as Record<string, any>
    const amount = typeof b.amount === 'number' ? b.amount : parseMoney(String(b.amount ?? ''), b.currency)
    if (amount === null) return reply.code(400).send({ error: 'Invalid amount' })
    const plan = await db.plan.create({
      data: {
        name: b.name,
        amount,
        currency: b.currency ?? 'GEL',
        interval: b.interval ?? 'monthly',
        intervalDays: b.intervalDays ?? null,
        gracePeriodDays: b.gracePeriodDays ?? 3,
        autoSuspend: b.autoSuspend ?? true,
        dunningPolicy: b.dunningPolicy ? JSON.stringify(b.dunningPolicy) : ''
      }
    })
    return reply.code(201).send(plan)
  })

  app.patch('/plans/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const b = request.body as Record<string, any>
    const data: Record<string, unknown> = { ...b }
    delete data.id
    if (typeof b.amount === 'string') {
      const parsed = parseMoney(b.amount, b.currency)
      if (parsed !== null) data.amount = parsed
      else delete data.amount
    }
    if (b.dunningPolicy && typeof b.dunningPolicy !== 'string') data.dunningPolicy = JSON.stringify(b.dunningPolicy)
    return db.plan.update({ where: { id }, data })
  })

  /** The built-in ladder, so the UI can show/seed it. */
  app.get('/default-policy', async () => ({ policy: DEFAULT_DUNNING_POLICY }))

  // ── Subscriptions ─────────────────────────────────────────────────────────

  app.get('/subscriptions', async () =>
    db.subscription.findMany({
      include: { site: true, client: true, plan: true },
      orderBy: { id: 'asc' }
    })
  )

  app.post('/subscriptions', {
    schema: {
      body: {
        type: 'object',
        required: ['siteId', 'clientId'],
        properties: {
          siteId: { type: 'integer' },
          clientId: { type: 'integer' },
          planId: { type: 'integer', nullable: true },
          amount: { type: ['integer', 'string'] },
          currency: { type: 'string', enum: ['GEL', 'USD', 'EUR'] },
          interval: { type: 'string', enum: ['monthly', 'yearly', 'custom_days'] },
          intervalDays: { type: 'integer', nullable: true },
          anchorDay: { type: 'integer', minimum: 1, maximum: 28, nullable: true },
          startDate: { type: 'string' },
          gracePeriodDays: { type: 'integer', minimum: 0, maximum: 60 },
          neverAutoSuspend: { type: 'boolean' },
          dunningPolicy: {}
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const b = request.body as Record<string, any>

    // `siteId` is unique, so a site can hold only one subscription row. A
    // *cancelled* one shouldn't block re-adding billing later — we reactivate
    // it in place (keeping its id and invoice history) rather than 409-ing.
    const existing = await db.subscription.findUnique({ where: { siteId: b.siteId } })
    if (existing && existing.status !== 'cancelled') {
      return reply.code(409).send({ error: 'This site already has a subscription.' })
    }

    const plan = b.planId ? await db.plan.findUnique({ where: { id: b.planId } }) : null
    const currency = b.currency ?? plan?.currency ?? 'GEL'
    const rawAmount = b.amount ?? plan?.amount
    const amount = typeof rawAmount === 'number' ? rawAmount : parseMoney(String(rawAmount ?? ''), currency)
    if (amount === null || amount <= 0) return reply.code(400).send({ error: 'Invalid amount' })

    const start = b.startDate ? new Date(b.startDate) : new Date()
    const interval = b.interval ?? plan?.interval ?? 'monthly'
    const data = {
      clientId: b.clientId,
      planId: b.planId ?? null,
      amount,
      currency,
      interval,
      intervalDays: b.intervalDays ?? plan?.intervalDays ?? null,
      anchorDay: b.anchorDay ?? null,
      startDate: start,
      nextInvoiceAt: start,
      gracePeriodDays: b.gracePeriodDays ?? plan?.gracePeriodDays ?? 3,
      neverAutoSuspend: b.neverAutoSuspend ?? false,
      dunningPolicy: b.dunningPolicy ? JSON.stringify(b.dunningPolicy) : ''
    }

    // First invoice is due immediately at `start`; the anchor then repeats.
    let sub
    if (existing) {
      // Belt-and-braces: void any leftover open invoices from the previous life
      // BEFORE reactivating, so the ladder can never suspend the site over a
      // stale period (covers subscriptions cancelled before void-on-cancel
      // existed).
      await db.invoice.updateMany({
        where: { subscriptionId: existing.id, status: { in: ['open', 'partial', 'overdue'] } },
        data: { status: 'void' }
      })
      sub = await db.subscription.update({
        where: { id: existing.id },
        // Reactivate: fresh billing state, enforcement cleared, cancel undone.
        data: { ...data, status: 'active', enforcementLevel: 'none', cancelledAt: null, suspendedAt: null },
        include: { site: true, client: true }
      })
    } else {
      sub = await db.subscription.create({
        data: { siteId: b.siteId, ...data },
        include: { site: true, client: true }
      })
    }

    app.audit(existing ? 'billing.subscription_reactivated' : 'billing.subscription_created', {
      req: request,
      meta: { subscriptionId: sub.id, siteId: b.siteId }
    })
    return reply.code(201).send(sub)
  })

  app.patch('/subscriptions/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const b = request.body as Record<string, any>
    const data: Record<string, unknown> = { ...b }
    delete data.id; delete data.siteId
    if (typeof b.amount === 'string') {
      const parsed = parseMoney(b.amount, b.currency)
      if (parsed !== null) data.amount = parsed
      else delete data.amount
    }
    if (b.dunningPolicy !== undefined && typeof b.dunningPolicy !== 'string') {
      data.dunningPolicy = b.dunningPolicy ? JSON.stringify(b.dunningPolicy) : ''
    }
    if (b.startDate) data.startDate = new Date(b.startDate)
    if (b.nextInvoiceAt) data.nextInvoiceAt = new Date(b.nextInvoiceAt)
    const sub = await db.subscription.update({ where: { id }, data })
    app.audit('billing.subscription_updated', { req: request, meta: { subscriptionId: id } })
    return sub
  })

  app.delete('/subscriptions/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    // Always lift enforcement before detaching billing from a site.
    const found = await subjectFor(id)
    if (found && found.sub.enforcementLevel !== 'none') {
      await restoreSite(app, found.subject, { subscriptionId: id })
    }

    // Void the still-open invoices. Two reasons:
    //  • the client should no longer owe for a site we stopped billing, so
    //    their portal outstanding drops to 0; and
    //  • it removes the trap where re-adding billing later (reactivation)
    //    would resurrect a months-old overdue invoice and INSTANTLY suspend
    //    the site over a period that no longer applies.
    const voided = await db.invoice.updateMany({
      where: { subscriptionId: id, status: { in: ['open', 'partial', 'overdue'] } },
      data: { status: 'void' }
    })

    await db.subscription.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: new Date(), enforcementLevel: 'none', suspendedAt: null }
    })
    await db.billingEvent.create({
      data: {
        subscriptionId: id,
        type: 'cancelled',
        detail: voided.count ? `billing cancelled; ${voided.count} open invoice(s) voided` : 'billing cancelled'
      }
    }).catch(() => {})
    app.audit('billing.subscription_cancelled', { req: request, meta: { subscriptionId: id, invoicesVoided: voided.count } })
    return { cancelled: true, invoicesVoided: voided.count }
  })

  /** "What happens next" — never surprise the operator. */
  app.get('/subscriptions/:id/preview', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const p = await previewSubscription(app, id)
    if (!p) return reply.code(404).send({ error: 'Subscription not found' })
    return p
  })

  app.get('/subscriptions/:id/events', async (request) => {
    const id = Number((request.params as { id: string }).id)
    return db.billingEvent.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
  })

  /** Issue this subscription's next invoice immediately. */
  app.post('/subscriptions/:id/issue-invoice', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const inv = await issueInvoiceForSubscription(db, id)
    if (!inv) return reply.code(400).send({ error: 'Nothing to invoice (cancelled/paused subscription?)' })
    app.audit('billing.invoice_issued', { req: request, meta: { subscriptionId: id, invoice: inv.number } })
    return inv
  })

  /** Manually force an enforcement level (respects the master switch, except restore). */
  app.post('/subscriptions/:id/enforce', {
    schema: {
      body: {
        type: 'object',
        required: ['level'],
        properties: { level: { type: 'string', enum: ['none', 'banner', 'restrict', 'suspend'] } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { level } = request.body as { level: EnforcementLevel }
    const found = await subjectFor(id)
    if (!found) return reply.code(404).send({ error: 'Subscription not found' })

    const result =
      level === 'none'
        ? await restoreSite(app, found.subject, { subscriptionId: id })
        : await applyEnforcement(app, found.subject, level, { subscriptionId: id })

    if (result.applied) {
      await db.subscription.update({
        where: { id },
        data: {
          enforcementLevel: result.to,
          status: result.to === 'none' ? 'active' : result.to === 'suspend' ? 'suspended' : 'past_due',
          suspendedAt: result.to === 'suspend' ? new Date() : null,
          lastEnforcedAt: new Date()
        }
      })
    }
    return result
  })

  // ── Invoices ──────────────────────────────────────────────────────────────

  app.get('/invoices', async (request) => {
    const q = request.query as { status?: string; clientId?: string; siteId?: string }
    const where: Record<string, unknown> = {}
    if (q.status) where.status = q.status
    if (q.clientId) where.clientId = Number(q.clientId)
    if (q.siteId) where.siteId = Number(q.siteId)
    const invoices = await db.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: { client: true, site: true, payments: true }
    })
    return invoices.map((i: any) => ({
      ...i,
      balance: invoiceBalance(i),
      amountFormatted: formatMoney(i.amount, i.currency)
    }))
  })

  app.get('/invoices/overdue', async () => {
    const invoices = await openInvoices(db)
    const now = new Date()
    return invoices
      .filter((i: any) => new Date(i.dueDate) < now)
      .map((i: any) => ({
        id: i.id,
        number: i.number,
        client: i.client?.name,
        domain: i.site?.domain,
        balance: balanceDue(i.amount, i.amountPaid),
        currency: i.currency,
        dueDate: i.dueDate
      }))
  })

  /**
   * Record a payment. Omit `amount` to settle the full remaining balance.
   * When the invoice becomes fully paid and the client owes nothing else on
   * that site, the site is restored immediately — no waiting for the cron.
   */
  app.post('/invoices/:id/pay', {
    schema: {
      body: {
        type: 'object',
        properties: {
          amount: { type: ['integer', 'string'] },
          method: { type: 'string', enum: ['cash', 'bank_transfer', 'card', 'other'] },
          reference: { type: 'string', maxLength: 200 },
          note: { type: 'string', maxLength: 500 },
          receivedAt: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const b = (request.body ?? {}) as Record<string, any>

    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return reply.code(404).send({ error: 'Invoice not found' })

    let amount: number | undefined
    if (b.amount !== undefined) {
      const parsed = typeof b.amount === 'number' ? b.amount : parseMoney(String(b.amount), invoice.currency)
      if (parsed === null || parsed <= 0) return reply.code(400).send({ error: 'Invalid amount' })
      amount = parsed
    }

    const result = await recordPayment(db, id, {
      amount,
      method: b.method ?? 'cash',
      source: 'manual',
      reference: b.reference ?? null,
      note: b.note ?? null,
      recordedById: (request.user as { id?: number } | undefined)?.id ?? null,
      receivedAt: b.receivedAt ? new Date(b.receivedAt) : undefined
    })
    if (!result) return reply.code(400).send({ error: 'Could not record payment (void invoice or zero amount)' })

    app.audit('billing.payment_recorded', {
      req: request,
      meta: { invoiceId: id, amount: amount ?? 'full', method: b.method ?? 'cash' }
    })

    // Auto-restore the moment the client owes nothing more on this site.
    let restored = false
    if (result.fullyPaid && invoice.subscriptionId) {
      const stillOwing = await db.invoice.count({
        where: { subscriptionId: invoice.subscriptionId, status: { in: ['open', 'partial', 'overdue'] } }
      })
      if (stillOwing === 0) {
        const found = await subjectFor(invoice.subscriptionId)
        if (found && found.sub.enforcementLevel !== 'none') {
          const r = await restoreSite(app, found.subject, { subscriptionId: invoice.subscriptionId, invoiceId: id })
          if (r.applied) {
            await db.subscription.update({
              where: { id: invoice.subscriptionId },
              data: { enforcementLevel: 'none', status: 'active', suspendedAt: null, lastEnforcedAt: new Date() }
            })
            restored = true
          }
        } else if (found) {
          await db.subscription.update({ where: { id: invoice.subscriptionId }, data: { status: 'active' } })
        }
      }
    }

    return { ...result, restored }
  })

  app.post('/invoices/:id/void', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const invoice = await db.invoice.findUnique({ where: { id } })
    if (!invoice) return reply.code(404).send({ error: 'Invoice not found' })
    if (invoice.status === 'paid') return reply.code(400).send({ error: 'A paid invoice cannot be voided.' })
    if (invoice.status === 'void') return { voided: true }

    await db.invoice.update({ where: { id }, data: { status: 'void' } })

    // Issuing an invoice advances the subscription's anchor to the next period.
    // Voiding it must GIVE THAT PERIOD BACK, otherwise the period is silently
    // skipped forever: the next tick would jump straight to the following one
    // and the client would never be billed for it.
    let periodRestored = false
    if (invoice.subscriptionId) {
      const sub = await db.subscription.findUnique({ where: { id: invoice.subscriptionId } })
      if (sub && new Date(sub.nextInvoiceAt) > new Date(invoice.periodStart)) {
        await db.subscription.update({
          where: { id: sub.id },
          data: { nextInvoiceAt: invoice.periodStart }
        })
        periodRestored = true
      }
      await db.billingEvent.create({
        data: {
          subscriptionId: invoice.subscriptionId,
          invoiceId: id,
          type: 'invoice_voided',
          detail: periodRestored
            ? `${invoice.number} voided; billing anchor rolled back to ${new Date(invoice.periodStart).toISOString().slice(0, 10)}`
            : `${invoice.number} voided`
        }
      }).catch(() => {})
    }

    app.audit('billing.invoice_voided', {
      req: request,
      meta: { invoiceId: id, number: invoice.number, periodRestored }
    })
    return { voided: true, periodRestored }
  })

  // ── Profitability: revenue vs what the site actually consumes ──────────────

  app.get('/profitability', async () => {
    const subs = await db.subscription.findMany({
      where: { status: { not: 'cancelled' } },
      include: { site: true, client: true }
    })

    // Crowding must be measured against EVERY site on the box, not just the
    // billed ones. A server full of unbilled sites is exactly the situation
    // this report exists to surface — counting only subscriptions would have
    // reported "1 site on server" for a box hosting seven.
    const allSites = await db.site.findMany({ select: { serverId: true } })
    const sitesPerServer = new Map<number | null, number>()
    for (const s of allSites) {
      const key = s.serverId ?? null
      sitesPerServer.set(key, (sitesPerServer.get(key) ?? 0) + 1)
    }
    return subs.map((s: any) => ({
      siteId: s.siteId,
      domain: s.site?.domain,
      client: s.client?.name,
      amount: s.amount,
      currency: s.currency,
      amountFormatted: formatMoney(s.amount, s.currency),
      serverId: s.site?.serverId ?? null,
      sitesOnServer: sitesPerServer.get(s.site?.serverId ?? null) ?? 1,
      status: s.status,
      enforcementLevel: s.enforcementLevel
    }))
  })
}
