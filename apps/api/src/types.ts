import { PrismaClient } from '@prisma/client'
import { FastifyRequest, FastifyReply } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireRole: (roles: string[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireSiteAccess: () => (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    audit: (action: string, opts?: import('./plugins/audit').AuditOpts) => void
  }
}
