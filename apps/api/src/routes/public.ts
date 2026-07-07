import { FastifyPluginAsync } from 'fastify'

// Public, UNAUTHENTICATED endpoints (status pages). Everything here is
// read-only, token-scoped, and derived from data already collected — it never
// touches the hosted sites. Reachable at /api/public/... (nginx only denies
// /api/internal).
export const publicRoutes: FastifyPluginAsync = async (app) => {
  // GET /status/:token — public uptime/status data for one site.
  app.get('/status/:token', async (request, reply) => {
    const token = (request.params as { token: string }).token
    if (!token || token.length < 8) return reply.code(404).send({ error: 'Not found' })

    const site = await app.prisma.site.findFirst({
      where: { statusPageToken: token, statusPageEnabled: true },
      select: { id: true, domain: true, name: true }
    })
    if (!site) return reply.code(404).send({ error: 'Not found' })

    const since = new Date(Date.now() - 90 * 86_400_000)
    const checks = await app.prisma.uptimeCheck.findMany({
      where: { siteId: site.id, checkedAt: { gte: since } },
      orderBy: { checkedAt: 'asc' },
      select: { status: true, responseMs: true, checkedAt: true }
    })

    // Per-day uptime %.
    const byDay = new Map<string, { up: number; total: number }>()
    for (const c of checks) {
      const key = c.checkedAt.toISOString().slice(0, 10)
      const g = byDay.get(key) ?? { up: 0, total: 0 }
      g.total++
      if (c.status === 'up') g.up++
      byDay.set(key, g)
    }
    const days = [...byDay.entries()]
      .map(([date, g]) => ({ date, upPct: Math.round((g.up / g.total) * 1000) / 10 }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))

    const total = checks.length
    const up = checks.filter((c) => c.status === 'up').length
    const rts = checks.map((c) => c.responseMs).filter((n): n is number => typeof n === 'number')

    // Incidents = consecutive non-up runs.
    const incidents: { from: string; to: string }[] = []
    let start: Date | null = null
    let last: Date | null = null
    for (const c of checks) {
      if (c.status !== 'up') { if (!start) start = c.checkedAt; last = c.checkedAt }
      else if (start) { incidents.push({ from: start.toISOString(), to: (last ?? start).toISOString() }); start = null }
    }
    if (start) incidents.push({ from: start.toISOString(), to: (last ?? start).toISOString() })

    return {
      domain: site.domain,
      name: site.name,
      current: checks[checks.length - 1]?.status ?? 'unknown',
      overallPct: total ? Math.round((up / total) * 1000) / 10 : null,
      avgMs: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null,
      days,
      incidents: incidents.slice(-10).reverse()
    }
  })
}
