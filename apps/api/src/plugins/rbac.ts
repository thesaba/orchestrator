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

    const params = req.params as { id?: string }
    const siteId = params.id ? Number(params.id) : null
    if (!siteId || isNaN(siteId)) return // no siteId param — allow through

    const access = await app.prisma.siteUser.findUnique({
      where: { userId_siteId: { userId: user.userId, siteId } }
    })
    if (!access) {
      return reply.code(403).send({ error: 'Forbidden: no access to this site' })
    }

    // Viewer role: block all writes
    if (role === 'viewer') {
      const method = req.method.toUpperCase()
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return reply.code(403).send({ error: 'Forbidden: viewer role is read-only' })
      }
    }
  })
})
