import { FastifyPluginAsync } from 'fastify'

// Admin-only view of what MCP/AI clients have done (reads + actions).
export const mcpActivityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET / — recent activity, newest first, with optional filters.
  app.get('/', async (request) => {
    const q = request.query as {
      tokenId?: string; siteId?: string; tool?: string; type?: string; q?: string; limit?: string
    }
    const where: any = {}
    if (q.tokenId) where.tokenId = Number(q.tokenId)
    if (q.siteId) where.siteId = Number(q.siteId)
    if (q.tool) where.tool = q.tool
    if (q.type === 'write') where.method = { in: ['POST', 'PUT', 'PATCH', 'DELETE'] }
    else if (q.type === 'read') where.method = 'GET'
    if (q.q) where.path = { contains: String(q.q) }

    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100))
    const items = await app.prisma.mcpActivity.findMany({
      where, orderBy: { createdAt: 'desc' }, take: limit
    })

    // Lightweight summary for the header (last 24h).
    const since = new Date(Date.now() - 24 * 3600_000)
    const recent = await app.prisma.mcpActivity.findMany({
      where: { createdAt: { gte: since } }, select: { method: true, ok: true }
    })
    const summary = {
      last24h: recent.length,
      actions24h: recent.filter((r: any) => r.method !== 'GET').length,
      errors24h: recent.filter((r: any) => !r.ok).length
    }
    return { items, summary }
  })

  // GET /filters — distinct tokens and tools, to populate the UI dropdowns.
  app.get('/filters', async () => {
    const tokens = await app.prisma.mcpActivity.findMany({
      where: { tokenId: { not: null } },
      distinct: ['tokenId'],
      select: { tokenId: true, tokenName: true },
      take: 100
    })
    const toolRows = await app.prisma.mcpActivity.findMany({
      where: { tool: { not: null } },
      distinct: ['tool'],
      select: { tool: true },
      orderBy: { tool: 'asc' },
      take: 200
    })
    return { tokens, tools: toolRows.map((t: any) => t.tool).filter(Boolean) }
  })
}
