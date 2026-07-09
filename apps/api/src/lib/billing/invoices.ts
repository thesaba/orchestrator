/**
 * Invoice lifecycle: numbering, issuing, and recording payments.
 *
 * Invoice numbers are sequential per calendar year and allocated inside a
 * transaction against `BillingCounter`, so two invoices issued in the same
 * millisecond can never share a number. Once issued, an invoice's number and
 * `amount` are a snapshot: changing a Plan's price later must never rewrite
 * history.
 *
 * The new billing models aren't in the checked-in generated Prisma client yet
 * (it is regenerated on deploy), so `prisma` is typed loosely here — the same
 * convention `server-sync.ts` already uses for the `Server` model.
 */

import { nextInvoiceDate } from './dunning'
import { balanceDue } from './money'

export type InvoiceStatus = 'draft' | 'open' | 'partial' | 'paid' | 'overdue' | 'void'

/** Allocate the next `INV-<year>-<seq>` atomically. */
export async function nextInvoiceNumber(prisma: any, when: Date = new Date()): Promise<string> {
  const year = when.getUTCFullYear()
  const row = await prisma.$transaction(async (tx: any) => {
    const existing = await tx.billingCounter.findUnique({ where: { year } })
    if (!existing) return tx.billingCounter.create({ data: { year, seq: 1 } })
    return tx.billingCounter.update({ where: { year }, data: { seq: { increment: 1 } } })
  })
  return `INV-${year}-${String(row.seq).padStart(4, '0')}`
}

export interface IssuedInvoice {
  id: number
  number: string
  amount: number
  currency: string
  dueDate: Date
}

/**
 * Issue the invoice a subscription is due for and advance its billing anchor.
 * Idempotent per period: if an invoice already covers `periodStart`, it is
 * returned instead of a duplicate being created — so a double cron run is safe.
 */
export async function issueInvoiceForSubscription(
  prisma: any,
  subscriptionId: number,
  now: Date = new Date()
): Promise<IssuedInvoice | null> {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { site: true }
  })
  if (!sub) return null
  if (sub.status === 'cancelled' || sub.status === 'paused') return null

  const periodStart: Date = sub.nextInvoiceAt
  const periodEnd = nextInvoiceDate(periodStart, sub.interval, sub.intervalDays, sub.anchorDay)

  // Idempotence guard: never bill the same period twice.
  const dup = await prisma.invoice.findFirst({
    where: { subscriptionId: sub.id, periodStart, status: { not: 'void' } }
  })
  if (dup) return { id: dup.id, number: dup.number, amount: dup.amount, currency: dup.currency, dueDate: dup.dueDate }

  const number = await nextInvoiceNumber(prisma, now)
  const invoice = await prisma.invoice.create({
    data: {
      number,
      clientId: sub.clientId,
      subscriptionId: sub.id,
      siteId: sub.siteId,
      periodStart,
      periodEnd,
      issuedAt: now,
      dueDate: periodStart, // due on issue; the ladder's grace period softens this
      amount: sub.amount,
      currency: sub.currency,
      status: 'open',
      lineItems: JSON.stringify([
        {
          description: `Hosting — ${sub.site?.domain ?? 'site'}`,
          periodStart,
          periodEnd,
          amount: sub.amount,
          currency: sub.currency
        }
      ])
    }
  })

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { nextInvoiceAt: periodEnd }
  })

  await prisma.billingEvent.create({
    data: { subscriptionId: sub.id, invoiceId: invoice.id, type: 'invoice_issued', detail: number }
  }).catch(() => {})

  return { id: invoice.id, number, amount: invoice.amount, currency: invoice.currency, dueDate: invoice.dueDate }
}

export interface RecordPaymentInput {
  /** Minor units. Omit to settle the exact remaining balance. */
  amount?: number
  method?: 'cash' | 'bank_transfer' | 'card' | 'other'
  source?: 'manual' | 'telegram' | 'bank_import' | 'gateway'
  reference?: string | null
  /** Idempotency key for imports/gateways — a duplicate is rejected, not double-credited. */
  externalId?: string | null
  recordedById?: number | null
  note?: string | null
  receivedAt?: Date
}

export interface RecordPaymentResult {
  invoiceId: number
  status: InvoiceStatus
  amount: number
  amountPaid: number
  balance: number
  fullyPaid: boolean
  duplicate: boolean
}

/**
 * Record a payment against an invoice and recompute its status from the sum of
 * its payments (never by incrementing a counter — that way a deleted/corrected
 * payment can't leave the invoice permanently wrong).
 */
export async function recordPayment(
  prisma: any,
  invoiceId: number,
  input: RecordPaymentInput = {}
): Promise<RecordPaymentResult | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!invoice) return null
  if (invoice.status === 'void') return null

  if (input.externalId) {
    const existing = await prisma.payment.findUnique({ where: { externalId: input.externalId } })
    if (existing) {
      return {
        invoiceId,
        status: invoice.status,
        amount: invoice.amount,
        amountPaid: invoice.amountPaid,
        balance: balanceDue(invoice.amount, invoice.amountPaid),
        fullyPaid: invoice.status === 'paid',
        duplicate: true
      }
    }
  }

  const remaining = balanceDue(invoice.amount, invoice.amountPaid)
  const amount = Math.trunc(input.amount ?? remaining)
  if (amount <= 0) return null

  await prisma.payment.create({
    data: {
      invoiceId,
      amount,
      currency: invoice.currency,
      method: input.method ?? 'cash',
      source: input.source ?? 'manual',
      reference: input.reference ?? null,
      externalId: input.externalId ?? null,
      recordedById: input.recordedById ?? null,
      note: input.note ?? null,
      receivedAt: input.receivedAt ?? new Date()
    }
  })

  const agg = await prisma.payment.aggregate({ where: { invoiceId }, _sum: { amount: true } })
  const amountPaid: number = agg._sum.amount ?? 0
  const fullyPaid = amountPaid >= invoice.amount
  const status: InvoiceStatus = fullyPaid ? 'paid' : amountPaid > 0 ? 'partial' : 'open'

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, status, paidAt: fullyPaid ? new Date() : null }
  })

  if (invoice.subscriptionId) {
    await prisma.billingEvent.create({
      data: {
        subscriptionId: invoice.subscriptionId,
        invoiceId,
        type: 'payment_recorded',
        detail: `${amount} ${invoice.currency} (${input.method ?? 'cash'})`
      }
    }).catch(() => {})
  }

  return {
    invoiceId,
    status,
    amount: updated.amount,
    amountPaid,
    balance: balanceDue(updated.amount, amountPaid),
    fullyPaid,
    duplicate: false
  }
}

/** All invoices still owing money, oldest first. */
export async function openInvoices(prisma: any, clientId?: number) {
  return prisma.invoice.findMany({
    where: {
      status: { in: ['open', 'partial', 'overdue'] },
      ...(clientId ? { clientId } : {})
    },
    orderBy: { dueDate: 'asc' },
    include: { client: true, site: true }
  })
}

export interface AgingBuckets {
  current: number
  d1_30: number
  d31_60: number
  d61_plus: number
  total: number
}

/** Classic receivables aging report, in minor units. */
export function agingBuckets(
  invoices: Array<{ amount: number; amountPaid: number; dueDate: Date }>,
  now: Date = new Date()
): AgingBuckets {
  const b: AgingBuckets = { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0, total: 0 }
  for (const inv of invoices) {
    const due = balanceDue(inv.amount, inv.amountPaid)
    if (due <= 0) continue
    const days = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / 86_400_000)
    if (days <= 0) b.current += due
    else if (days <= 30) b.d1_30 += due
    else if (days <= 60) b.d31_60 += due
    else b.d61_plus += due
    b.total += due
  }
  return b
}

/** Monthly recurring revenue across active subscriptions (minor units). */
export function mrr(subs: Array<{ amount: number; interval: string; intervalDays?: number | null; status: string }>): number {
  let total = 0
  for (const s of subs) {
    if (s.status !== 'active' && s.status !== 'past_due' && s.status !== 'suspended') continue
    if (s.interval === 'monthly') total += s.amount
    else if (s.interval === 'yearly') total += Math.round(s.amount / 12)
    else if (s.interval === 'custom_days' && s.intervalDays) total += Math.round((s.amount * 30) / s.intervalDays)
  }
  return total
}
