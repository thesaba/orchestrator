import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { PAT_PREFIX } from '../plugins/auth'

function userId(request: { user: unknown }): number {
  return (request.user as { userId: number }).userId
}

// Personal Access Tokens for scripting the panel API. Scoped to the
// authenticated user; only a hash is stored, so the plaintext is returned
// exactly once at creation.
export const tokensRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET / — list the caller's tokens (never the secret).
  app.get('/', async (request) => {
    const tokens = await app.prisma.personalAccessToken.findMany({
      where: { userId: userId(request) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, tokenPrefix: true, lastUsedAt: true, expiresAt: true, createdAt: true }
    })
    return { tokens }
  })

  // POST / — create a token. Returns the plaintext ONCE.
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          expiresInDays: { type: 'integer', minimum: 1, maximum: 3650 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { name, expiresInDays } = request.body as { name: string; expiresInDays?: number }

    // 32 random bytes → 64 hex chars, prefixed so the auth hook recognises it.
    const plaintext = PAT_PREFIX + crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(plaintext).digest('hex')
    const tokenPrefix = plaintext.slice(0, PAT_PREFIX.length + 6) // e.g. "orch_1a2b3c"
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null

    const created = await app.prisma.personalAccessToken.create({
      data: { userId: userId(request), name, tokenHash, tokenPrefix, expiresAt },
      select: { id: true, name: true, tokenPrefix: true, expiresAt: true, createdAt: true }
    })

    app.audit('token.created', { req: request, meta: { tokenId: created.id, name } })
    reply.code(201)
    // `token` is present only in this response and never stored in plaintext.
    return { ...created, token: plaintext }
  })

  // DELETE /:id — revoke one of the caller's tokens.
  app.delete('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const token = await app.prisma.personalAccessToken.findUnique({ where: { id } })
    if (!token || token.userId !== userId(request)) {
      return reply.code(404).send({ error: 'Token not found' })
    }
    await app.prisma.personalAccessToken.delete({ where: { id } })
    app.audit('token.revoked', { req: request, meta: { tokenId: id, name: token.name } })
    return { ok: true }
  })
}
