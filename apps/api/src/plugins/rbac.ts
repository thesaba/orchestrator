import fp from 'fastify-plugin'
import { FastifyRequest, FastifyReply } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    requireRole: (roles: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireSiteAccess: () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export const rbacPlugin = fp(async (app) => {
  app.decorate('requireRole', (roles: string[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as { userId?: number; role?: string } | undefined
    const role = user?.role ?? 'admin'
    if (!roles.includes(role)) {
      return reply.code(403).send({ error: 'Forbidden: insufficient role' })
    }
  })

  app.decorate('requireSiteAccess', () => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user as { userId?: number; role?: string } | undefined
    if (!user?.userId) return reply.code(401).send({ error: 'Unauthorized' })

    const role = user.role ?? 'admin'
    if (role === 'admin') return // admins always have access

    // Route params name the site id either `id` (most site-scoped routes,
    // mounted under /api/sites/:id/...) or `siteId` (s3backup.ts).
    const params = req.params as { id?: string; siteId?: string }
    const rawId = params.id ?? params.siteId
    const siteId = rawId ? Number(rawId) : null
    if (!siteId || isNaN(siteId)) return // no siteId param — allow through

    // Viewer role: block all writes regardless of which access path applies
    const blockWrite = () => {
      if (role !== 'viewer') return undefined
      const method = req.method.toUpperCase()
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return reply.code(403).send({ error: 'Forbidden: viewer role is read-only' })
      }
      return undefined
    }

    // Users granted blanket access bypass the per-site SiteUser check —
    // this also covers sites created after the grant was made.
    const dbUser = await app.prisma.user.findUnique({
      where: { id: user.userId },
      select: { allSitesAccess: true }
    })
    if (dbUser?.allSitesAccess) return blockWrite()

    const access = await app.prisma.siteUser.findUnique({
      where: { userId_siteId: { userId: user.userId, siteId } }
    })
    if (!access) {
      return reply.code(403).send({ error: 'Forbidden: no access to this site' })
    }

    return blockWrite()
  })
})
