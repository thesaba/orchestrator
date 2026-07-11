/**
 * The daily billing tick — the single entry point used by BOTH the cron and
 * the manual "run now" button, so what an operator previews is exactly what
 * the scheduler will do.
 *
 * It is safe to run any number of times a day:
 *   • invoice issuing is idempotent per billing period,
 *   • `resolveLadder` returns an absolute level, not a transition,
 *   • each notification is recorded as a BillingEvent and never re-sent,
 *   • enforcement is a no-op when the site is already at the target level.
 */

import { FastifyInstance } from 'fastify'
import { createNotification } from '../notifications'
import { sendNotification } from '../notify'
import {
  parsePolicy,
  resolveLadder,
  nextStep,
  daysOverdue,
  EnforcementLevel,
  DunningAction,
  BILLING_TZ
} from './dunning'
import { formatMoney, balanceDue } from './money'
import { issueInvoiceForSubscription } from './invoices'
import { applyEnforcement, enforcementMode, setWorkersRunning } from './enforce'

export interface TickReport {
  mode: 'off' | 'dry_run' | 'on'
  issued: string[]
  notified: string[]
  escalated: string[]
  restored: string[]
  skipped: string[]
  errors: string[]
}

/** Human copy for each notify-only rung, in the client's language. */
function notifyCopy(action: DunningAction, locale: string, domain: string, amount: string, days: number) {
  const ka = locale !== 'en'
  switch (action) {
    case 'remind':
      return ka
        ? { title: 'ჰოსტინგის გადასახადი მალე იხურება', body: `${domain} — ${amount}, გადახდის ვადა ${Math.abs(days)} დღეში.` }
        : { title: 'Hosting payment due soon', body: `${domain} — ${amount}, due in ${Math.abs(days)} days.` }
    case 'invoice_due':
      return ka
        ? { title: 'ჰოსტინგის გადასახადი დღეს იხურება', body: `${domain} — ${amount}.` }
        : { title: 'Hosting payment due today', body: `${domain} — ${amount}.` }
    case 'final_warning':
      return ka
        ? { title: 'ბოლო გაფრთხილება', body: `${domain} — ${amount}, ვადაგადაცილება ${days} დღე. საიტი მალე დაარქივდება.` }
        : { title: 'Final warning', body: `${domain} — ${amount}, ${days} days overdue. The site will be archived soon.` }
    default:
      return { title: 'Billing', body: `${domain} — ${amount}` }
  }
}

const SUB_STATUS_FOR_LEVEL: Record<EnforcementLevel, string> = {
  none: 'active',
  banner: 'past_due',
  restrict: 'past_due',
  suspend: 'suspended',
  archived: 'suspended'
}

export async function runBillingTick(
  app: FastifyInstance,
  opts: { now?: Date; dryRun?: boolean } = {}
): Promise<TickReport> {
  const prisma = app.prisma as any
  const now = opts.now ?? new Date()
  const mode = opts.dryRun ? 'dry_run' : await enforcementMode(app)

  const report: TickReport = {
    mode,
    issued: [],
    notified: [],
    escalated: [],
    restored: [],
    skipped: [],
    errors: []
  }

  // A dry run must be perfectly side-effect free: it may not create invoices,
  // send messages, or write status rows. It only *reports* what a real run
  // would do.
  const commit = mode !== 'dry_run'

  // ── 1. Issue invoices whose anchor date has arrived ───────────────────────
  // Bookkeeping runs even when enforcement is off — you always want the ledger.
  const dueSubs = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'past_due', 'suspended'] }, nextInvoiceAt: { lte: now } },
    select: { id: true, site: { select: { domain: true } } }
  })
  for (const s of dueSubs) {
    try {
      if (!commit) {
        report.issued.push(`would issue for ${s.site?.domain ?? `sub #${s.id}`}`)
        continue
      }
      const inv = await issueInvoiceForSubscription(prisma, s.id, now)
      if (inv) report.issued.push(inv.number)
    } catch (e) {
      report.errors.push(`issue #${s.id}: ${(e as Error).message}`)
    }
  }

  // ── 2. Walk every subscription and reconcile it with the ladder ───────────
  // Only states that may legitimately be enforced. An allowlist (not "!=
  // cancelled") so that a future/unexpected status — e.g. a paused account —
  // can never be silently swept into the enforcement path.
  const subs = await prisma.subscription.findMany({
    where: { status: { in: ['active', 'past_due', 'suspended'] } },
    include: { site: true, client: true, plan: true }
  })

  for (const sub of subs) {
    try {
      if (!sub.site) continue

      // Oldest still-unpaid invoice drives the ladder.
      const unpaid = await prisma.invoice.findFirst({
        where: { subscriptionId: sub.id, status: { in: ['open', 'partial', 'overdue'] } },
        orderBy: { dueDate: 'asc' }
      })

      // 2a. Nothing owed → make sure the site is free of any enforcement.
      if (!unpaid) {
        if (sub.enforcementLevel !== 'none') {
          // restoreSite/force deliberately bypasses the master switch (relaxing
          // is always safe), so a dry run must be short-circuited here instead.
          if (!commit) {
            report.restored.push(`${sub.site.domain}: would restore (${sub.enforcementLevel} → none)`)
            continue
          }
          const r = await applyEnforcement(
            app,
            {
              siteId: sub.siteId,
              domain: sub.site.domain,
              serverId: sub.site.serverId,
              currentLevel: sub.enforcementLevel,
              neverAutoSuspend: sub.neverAutoSuspend,
              locale: sub.client?.locale
            },
            'none',
            { subscriptionId: sub.id, force: true }
          )
          if (r.applied) {
            await prisma.subscription.update({
              where: { id: sub.id },
              data: { enforcementLevel: 'none', status: 'active', suspendedAt: null, lastEnforcedAt: now }
            })
            await setWorkersRunning(app, sub.siteId, true)
            report.restored.push(sub.site.domain)
          }
        } else if (commit && sub.status !== 'active') {
          await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'active' } })
        }
        continue
      }

      const overdue = daysOverdue(unpaid.dueDate, now, BILLING_TZ)
      const due = balanceDue(unpaid.amount, unpaid.amountPaid)
      const amountStr = formatMoney(due, unpaid.currency)

      // Flip open → overdue once the due date passes (display only).
      if (commit && overdue > 0 && unpaid.status === 'open') {
        await prisma.invoice.update({ where: { id: unpaid.id }, data: { status: 'overdue' } })
      }

      const policy = parsePolicy(sub.dunningPolicy || sub.plan?.dunningPolicy)
      const ladder = resolveLadder(unpaid.dueDate, now, policy, {
        gracePeriodDays: sub.gracePeriodDays ?? sub.plan?.gracePeriodDays ?? 0,
        autoSuspend: sub.plan?.autoSuspend ?? true,
        neverAutoSuspend: sub.neverAutoSuspend
      })

      // 2b. Notifications — send each rung at most once per invoice, ever.
      for (const action of ladder.notifyActions) {
        const eventType = `notify:${action}`
        // Only a REAL send counts as "already notified". A dry run must never
        // poison this check, or the subsequent live run would silently skip
        // the reminder it was previewing.
        const already = await prisma.billingEvent.findFirst({
          where: { subscriptionId: sub.id, invoiceId: unpaid.id, type: eventType, dryRun: false }
        })
        if (already) continue

        const copy = notifyCopy(action, sub.client?.locale ?? 'ka', sub.site.domain, amountStr, overdue)
        if (!commit) {
          report.notified.push(`${sub.site.domain}: would send ${action}`)
          continue
        }
        {
          await createNotification(app, {
            type: 'billing',
            level: action === 'final_warning' ? 'critical' : 'warning',
            title: copy.title,
            body: copy.body,
            meta: { invoice: unpaid.number, domain: sub.site.domain, clientId: sub.clientId }
          })
          await sendNotification(app, {
            title: copy.title,
            subject: sub.site.domain,
            status: action === 'final_warning' ? 'failed' : 'warning',
            fields: [
              { label: 'Invoice', value: unpaid.number },
              { label: 'Amount due', value: amountStr },
              { label: 'Client', value: sub.client?.name ?? '—' }
            ]
          }).catch(() => {})
        }
        await prisma.billingEvent.create({
          data: {
            subscriptionId: sub.id,
            invoiceId: unpaid.id,
            type: eventType,
            detail: copy.title,
            dryRun: false
          }
        }).catch(() => {})
        report.notified.push(`${sub.site.domain}: ${action}`)
      }

      // 2c. Enforcement — only when the target differs from what's applied.
      if (ladder.targetLevel !== sub.enforcementLevel) {
        const r = await applyEnforcement(
          app,
          {
            siteId: sub.siteId,
            domain: sub.site.domain,
            serverId: sub.site.serverId,
            currentLevel: sub.enforcementLevel as EnforcementLevel,
            neverAutoSuspend: sub.neverAutoSuspend,
            amountDueMinor: due,
            currency: unpaid.currency,
            contact: sub.client?.email ?? sub.client?.phone ?? null,
            locale: sub.client?.locale
          },
          ladder.targetLevel,
          { subscriptionId: sub.id, invoiceId: unpaid.id }
        )

        if (r.applied) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              enforcementLevel: r.to,
              status: SUB_STATUS_FOR_LEVEL[r.to],
              suspendedAt: r.to === 'suspend' || r.to === 'archived' ? now : null,
              lastEnforcedAt: now
            }
          })
          report.escalated.push(`${sub.site.domain}: ${r.from} → ${r.to}`)
        } else {
          report.skipped.push(`${sub.site.domain}: ${r.reason ?? 'no change'}`)
        }
      }

      // 2d. Workers are stopped only once the ladder explicitly says so.
      if (ladder.stopWorkers && mode === 'on') {
        await setWorkersRunning(app, sub.siteId, false)
      }

      // Keep `past_due` accurate even when no level changed.
      if (commit && overdue > 0 && sub.status === 'active') {
        await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'past_due' } })
      }
    } catch (e) {
      report.errors.push(`sub #${sub.id}: ${(e as Error).message}`)
    }
  }

  return report
}

/**
 * Read-only "what happens next" for one subscription — powers the preview so an
 * operator is never surprised by an automatic suspension.
 */
export async function previewSubscription(app: FastifyInstance, subscriptionId: number, now = new Date()) {
  const prisma = app.prisma as any
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { site: true, client: true, plan: true }
  })
  if (!sub) return null

  const unpaid = await prisma.invoice.findFirst({
    where: { subscriptionId: sub.id, status: { in: ['open', 'partial', 'overdue'] } },
    orderBy: { dueDate: 'asc' }
  })

  const policy = parsePolicy(sub.dunningPolicy || sub.plan?.dunningPolicy)
  if (!unpaid) {
    return {
      domain: sub.site?.domain,
      currentLevel: sub.enforcementLevel,
      balance: 0,
      daysOverdue: null,
      targetLevel: 'none',
      next: null,
      policy
    }
  }

  const suspendAllowed = (sub.plan?.autoSuspend ?? true) && !sub.neverAutoSuspend
  const ladder = resolveLadder(unpaid.dueDate, now, policy, {
    gracePeriodDays: sub.gracePeriodDays ?? sub.plan?.gracePeriodDays ?? 0,
    autoSuspend: sub.plan?.autoSuspend ?? true,
    neverAutoSuspend: sub.neverAutoSuspend
  })
  // The preview must respect the same cap the enforcer does, or it promises
  // rungs (stop_workers, archive) that a capped subscription can never reach.
  const next = nextStep(unpaid.dueDate, now, policy, {
    maxLevel: suspendAllowed ? 'archived' : 'banner'
  })

  return {
    domain: sub.site?.domain,
    invoice: unpaid.number,
    balance: balanceDue(unpaid.amount, unpaid.amountPaid),
    currency: unpaid.currency,
    daysOverdue: ladder.daysOverdue,
    currentLevel: sub.enforcementLevel,
    targetLevel: ladder.targetLevel,
    withinGrace: ladder.withinGrace,
    cappedByPolicy: ladder.cappedByPolicy,
    next: next
      ? { action: next.step.action, level: next.level, date: next.date, daysAway: next.daysAway }
      : null,
    policy
  }
}
