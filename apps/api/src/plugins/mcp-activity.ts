import fp from 'fastify-plugin'

// Records every PAT-authenticated request (i.e. everything an MCP/AI client does,
// reads and actions alike) into the McpActivity table. Runs as a global
// onResponse hook; it is best-effort and never affects the response. Requests
// made with a normal panel session (JWT) are ignored — only `viaPat` is logged.
export const mcpActivityPlugin = fp(async (app) => {
  app.addHook('onResponse', async (request, reply) => {
    const u = (request as any).user
    if (!u?.viaPat) return
    try {
      const idParam = (request.params as any)?.id
      const siteId = /\/sites\/\d+/.test(request.url) && idParam != null && /^\d+$/.test(String(idParam))
        ? Number(idParam) : null
      const status = reply.statusCode
      const tool = (request.headers['x-mcp-tool'] as string | undefined)?.slice(0, 64) || null

      await app.prisma.mcpActivity.create({
        data: {
          tokenId: u.patId ?? null,
          tokenName: u.patName ?? null,
          userEmail: u.email ?? null,
          tool,
          method: request.method,
          path: request.url.split('?')[0].slice(0, 300),
          siteId,
          status,
          ok: status < 400,
          durationMs: Math.round((reply as any).elapsedTime ?? 0),
          ip: request.ip ?? null
        }
      })

      // Keep the table bounded — occasionally prune to the most recent ~10k rows.
      if (Math.random() < 0.02) {
        const stale = await app.prisma.mcpActivity.findMany({
          orderBy: { createdAt: 'desc' }, skip: 10000, select: { id: true }
        })
        if (stale.length) {
          await app.prisma.mcpActivity.deleteMany({ where: { id: { in: stale.map((s: any) => s.id) } } })
        }
      }
    } catch { /* logging must never break a request */ }
  })
})
