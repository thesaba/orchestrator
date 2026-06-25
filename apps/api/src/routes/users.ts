import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'

export const usersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET /api/users
  app.get('/', async () => {
    const users = await app.prisma.user.findMany({
      select: { id: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    })
    return { users }
  })

  // POST /api/users
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password', 'role'],
        properties: {
          email:    { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 8, maxLength: 128 },
          role:     { type: 'string', enum: ['admin', 'developer', 'viewer'] }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { email, password, role } = request.body as { email: string; password: string; role: string }

    const existing = await app.prisma.user.findUnique({ where: { email } })
    if (existing) return reply.code(409).send({ error: 'A user with this email already exists.' })

    const hash = await bcrypt.hash(password, 12)
    const user = await app.prisma.user.create({
      data: { email, password: hash, role },
      select: { id: true, email: true, role: true, createdAt: true }
    })

    app.audit('user.created', { req: request, meta: { email, role } })
    reply.code(201)
    return user
  })

  // PATCH /api/users/:id
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', minLength: 3, maxLength: 254 },
          role:  { type: 'string', enum: ['admin', 'developer', 'viewer'] }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const targetId = Number((request.params as { id: string }).id)
    const caller = request.user as { userId: number }
    const { email, role } = request.body as { email?: string; role?: string }

    if (role && caller.userId === targetId) {
      return reply.code(400).send({ error: 'You cannot change your own role.' })
    }

    const target = await app.prisma.user.findUnique({ where: { id: targetId } })
    if (!target) return reply.code(404).send({ error: 'User not found.' })

    const updated = await app.prisma.user.update({
      where: { id: targetId },
      data: { ...(email ? { email } : {}), ...(role ? { role } : {}) },
      select: { id: true, email: true, role: true, createdAt: true }
    })

    app.audit('user.updated', { req: request, meta: { targetId, email, role } })
    return updated
  })

  // DELETE /api/users/:id
  app.delete('/:id', async (request, reply) => {
    const targetId = Number((request.params as { id: string }).id)
    const caller = request.user as { userId: number }

    if (caller.userId === targetId) {
      return reply.code(400).send({ error: 'You cannot delete your own account.' })
    }

    const target = await app.prisma.user.findUnique({ where: { id: targetId } })
    if (!target) return reply.code(404).send({ error: 'User not found.' })

    // Prevent deleting the last admin
    if (target.role === 'admin') {
      const adminCount = await app.prisma.user.count({ where: { role: 'admin' } })
      if (adminCount <= 1) {
        return reply.code(400).send({ error: 'Cannot delete the last admin user.' })
      }
    }

    await app.prisma.user.delete({ where: { id: targetId } })
    app.audit('user.deleted', { req: request, meta: { email: target.email } })
    return { ok: true }
  })

  // GET /api/users/:id/sites — list assigned site IDs
  app.get('/:id/sites', async (request, reply) => {
    const userId = Number((request.params as { id: string }).id)
    const user = await app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'User not found.' })

    const access = await app.prisma.siteUser.findMany({
      where: { userId },
      select: { siteId: true }
    })
    return { siteIds: access.map((a) => a.siteId) }
  })

  // PUT /api/users/:id/sites — replace all site assignments
  app.put('/:id/sites', {
    schema: {
      body: {
        type: 'object',
        required: ['siteIds'],
        properties: {
          siteIds: { type: 'array', items: { type: 'integer' } }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const userId = Number((request.params as { id: string }).id)
    const { siteIds } = request.body as { siteIds: number[] }

    const user = await app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'User not found.' })

    // Replace all site assignments in a transaction
    await app.prisma.$transaction(async (tx) => {
      await tx.siteUser.deleteMany({ where: { userId } })
      for (const siteId of siteIds) {
        await tx.siteUser.create({ data: { userId, siteId } })
      }
    })

    app.audit('user.sites_updated', { req: request, meta: { userId, siteIds } })
    return { ok: true, siteIds }
  })
}
