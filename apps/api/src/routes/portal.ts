/**
 * Public, read-only client portal.
 *
 * Reached with an unguessable per-client token (same pattern as the public
 * status pages). A client never gets a panel login. It is strictly read-only:
 * payment confirmation stays with the operator (panel or Telegram), so nobody
 * can mark their own invoice paid.
 *
 * Care is taken to leak nothing beyond the client's own data — no ids of other
 * clients, no server/infrastructure detail.
 */

import { FastifyPluginAsync } from 'fastify'
import { formatMoney } from '../lib/billing/money'
import { invoiceBalance } from '../lib/billing/invoices'

export const portalRoutes: FastifyPluginAsync = async (app) => {
  const db = app.prisma as any

  // Deliberately no `authenticate` hook: the token IS the credential.
  // Rate-limited by the global limiter so the token can't be brute-forced.
  app.get('/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    if (!token || token.length < 24) return reply.code(404).send({ error: 'Not found' })

    const client = await db.client.findUnique({
      where: { portalToken: token },
      include: {
        subscriptions: { include: { site: true } },
        invoices: { orderBy: { createdAt: 'desc' }, take: 50, include: { payments: true } }
      }
    })
    if (!client || client.archived) return reply.code(404).send({ error: 'Not found' })

    // A portal exists to show a client what they owe. Once the client has no
    // active billing at all (every subscription cancelled), the link should go
    // dead rather than keep exposing stale invoices — this is what makes
    // "cancel billing" also retire the client's portal. It comes back on its
    // own if billing is re-added (the token lives on the client).
    const hasActiveBilling = client.subscriptions.some((s: any) => s.status !== 'cancelled')
    if (!hasActiveBilling) return reply.code(404).send({ error: 'Not found' })

    const invoices = client.invoices
      // Voided invoices (incl. those voided by a cancellation) are internal
      // history — never show them to the client.
      .filter((i: any) => i.status !== 'draft' && i.status !== 'void')
      .map((i: any) => {
        // A voided invoice stays visible as history, but nobody owes it a
        // tetri. Shared helper so the portal and the panel can never disagree.
        const balance = invoiceBalance(i)
        return ({
        number: i.number,
        periodStart: i.periodStart,
        periodEnd: i.periodEnd,
        dueDate: i.dueDate,
        status: i.status,
        amount: i.amount,
        amountPaid: i.amountPaid,
        balance,
        currency: i.currency,
        amountFormatted: formatMoney(i.amount, i.currency),
        balanceFormatted: formatMoney(balance, i.currency),
        paidAt: i.paidAt,
        payments: i.payments.map((p: any) => ({
          amount: p.amount,
          amountFormatted: formatMoney(p.amount, p.currency),
          method: p.method,
          receivedAt: p.receivedAt
        }))
        })
      })

    const outstanding = invoices.reduce((s: number, i: any) => s + i.balance, 0)

    return {
      client: { name: client.name, company: client.company, locale: client.locale, currency: client.currency },
      sites: client.subscriptions
        .filter((s: any) => s.site && s.status !== 'cancelled')
        .map((s: any) => ({
          domain: s.site.domain,
          // Coarse state only — never expose the internal enforcement ladder.
          active: s.enforcementLevel !== 'suspend' && s.enforcementLevel !== 'archived',
          amountFormatted: formatMoney(s.amount, s.currency),
          nextInvoiceAt: s.nextInvoiceAt
        })),
      outstanding,
      outstandingFormatted: formatMoney(outstanding, client.currency),
      invoices
    }
  })
}
