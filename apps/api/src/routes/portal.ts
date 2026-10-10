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
import { promises as fs, createReadStream } from 'fs'
import path from 'path'
import { formatMoney } from '../lib/billing/money'
import { invoiceBalance } from '../lib/billing/invoices'
import { serverCtxForSite } from '../lib/servers'
import { isLocal } from '../lib/server-exec'

// Backup filenames the client may list/download — same shape provisioning writes.
const SAFE_BACKUP = /^[\w.\-]+\.sql(\.gz)?$/

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
      sites: await Promise.all(client.subscriptions
        .filter((s: any) => s.site && s.status !== 'cancelled')
        .map(async (s: any) => {
          const siteId = s.site.id
          const since = new Date(Date.now() - 86_400_000)
          const checks = await db.uptimeCheck.findMany({ where: { siteId, checkedAt: { gte: since } }, select: { status: true } }).catch(() => [])
          const up = checks.filter((c: any) => c.status === 'up').length
          const latest = await db.uptimeCheck.findFirst({ where: { siteId }, orderBy: { checkedAt: 'desc' }, select: { status: true, checkedAt: true } }).catch(() => null)
          return {
            domain: s.site.domain,
            // Coarse state only — never expose the internal enforcement ladder.
            active: s.enforcementLevel !== 'suspend' && s.enforcementLevel !== 'archived',
            amountFormatted: formatMoney(s.amount, s.currency),
            nextInvoiceAt: s.nextInvoiceAt,
            uptime24h: checks.length ? Math.round((up / checks.length) * 1000) / 10 : null,
            currentStatus: latest?.status ?? 'unknown',
            lastCheckedAt: latest?.checkedAt ?? null
          }
        })),
      outstanding,
      outstandingFormatted: formatMoney(outstanding, client.currency),
      invoices
    }
  })

  // Resolve the client + their non-cancelled sites from the token (shared by the
  // self-service endpoints below). Returns null on any miss so callers can 404.
  async function clientSites(token: string): Promise<{ client: any; sites: any[] } | null> {
    if (!token || token.length < 24) return null
    const client = await db.client.findUnique({
      where: { portalToken: token },
      include: { subscriptions: { include: { site: true } } }
    })
    if (!client || client.archived) return null
    if (!client.subscriptions.some((s: any) => s.status !== 'cancelled')) return null
    const sites = client.subscriptions
      .filter((s: any) => s.site && s.status !== 'cancelled')
      .map((s: any) => s.site)
    return { client, sites }
  }

  // ── Support request → operator notification (write, tightly rate-limited) ──
  app.post('/:token/support', {
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          subject: { type: 'string', maxLength: 200 },
          message: { type: 'string', minLength: 1, maxLength: 2000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { token } = request.params as { token: string }
    const r = await clientSites(token)
    if (!r) return reply.code(404).send({ error: 'Not found' })
    const { subject, message } = request.body as { subject?: string; message: string }
    await db.notification.create({
      data: {
        type: 'support',
        level: 'info',
        title: `Support request — ${r.client.name}`,
        body: (subject ? `${subject}\n\n` : '') + message,
        meta: JSON.stringify({ clientId: r.client.id })
      }
    }).catch(() => {})
    app.audit('portal.support', { meta: { clientId: r.client.id } })
    return { ok: true }
  })

  // ── List the client's own backups (local sites only) ──────────────────────
  app.get('/:token/backups', async (request, reply) => {
    const r = await clientSites((request.params as { token: string }).token)
    if (!r) return reply.code(404).send({ error: 'Not found' })

    const out: Array<{ siteId: number; domain: string; files: any[] }> = []
    for (const site of r.sites) {
      const ctx = await serverCtxForSite(app.prisma, site)
      if (!isLocal(ctx)) continue // backups for remote sites live off-panel
      const dir = path.join(site.rootPath, 'backups')
      let files: any[] = []
      try {
        const names = await fs.readdir(dir)
        files = (await Promise.all(
          names.filter((n) => SAFE_BACKUP.test(n)).map(async (n) => {
            const st = await fs.stat(path.join(dir, n)).catch(() => null)
            return st ? { filename: n, sizeBytes: st.size, createdAt: st.mtime } : null
          })
        )).filter(Boolean)
          .sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(0, 20)
      } catch { /* no backups dir yet */ }
      out.push({ siteId: site.id, domain: site.domain, files })
    }
    return { sites: out }
  })

  // ── Download one backup — strictly scoped to the client's own site ─────────
  app.get('/:token/backups/:siteId/:filename', async (request, reply) => {
    const { token, siteId, filename } = request.params as { token: string; siteId: string; filename: string }
    if (!SAFE_BACKUP.test(filename)) return reply.code(400).send({ error: 'Invalid filename' })
    const r = await clientSites(token)
    if (!r) return reply.code(404).send({ error: 'Not found' })
    const site = r.sites.find((s: any) => s.id === Number(siteId))
    if (!site) return reply.code(404).send({ error: 'Not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    if (!isLocal(ctx)) return reply.code(404).send({ error: 'Not found' })

    // filename is SAFE_BACKUP-validated (no slashes, no ..), so path.join can't escape.
    const filePath = path.join(site.rootPath, 'backups', filename)
    const st = await fs.stat(filePath).catch(() => null)
    if (!st?.isFile()) return reply.code(404).send({ error: 'Not found' })

    app.audit('portal.backup_download', { meta: { clientId: r.client.id, siteId: site.id, filename } })
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Content-Type', 'application/gzip')
    reply.header('Content-Length', st.size)
    return reply.send(createReadStream(filePath))
  })
}
