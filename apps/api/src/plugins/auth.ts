import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import crypto from 'crypto'

// Personal Access Tokens are prefixed so the authenticate hook can tell them
// apart from JWT session tokens without a DB lookup on every request.
export const PAT_PREFIX = 'orch_'

export const jwtPlugin = fp(async (app) => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET environment variable is required — refusing to start')

  await app.register(jwt, { secret })

  app.decorate('authenticate', async (request: any, reply: any) => {
    const header: string = request.headers?.authorization ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''

    // ── Personal Access Token path (additive) ────────────────────────────────
    // Only engaged for our prefixed tokens; every other request falls straight
    // through to the unchanged JWT verification below, so existing sessions and
    // hosted-site behaviour are completely unaffected.
    if (bearer.startsWith(PAT_PREFIX)) {
      try {
        const tokenHash = crypto.createHash('sha256').update(bearer).digest('hex')
        const pat = await app.prisma.personalAccessToken.findUnique({
          where: { tokenHash },
          include: { user: { select: { id: true, email: true, role: true } } }
        })
        if (!pat || (pat.expiresAt && pat.expiresAt.getTime() < Date.now())) {
          return reply.code(401).send({ error: 'Invalid or expired access token' })
        }
        // Mimic the JWT payload shape so every route works unchanged.
        request.user = { userId: pat.user.id, email: pat.user.email, role: pat.user.role, viaPat: true }
        // Best-effort "last used" — never blocks the request.
        app.prisma.personalAccessToken.update({ where: { id: pat.id }, data: { lastUsedAt: new Date() } }).catch(() => {})
        return
      } catch {
        return reply.code(401).send({ error: 'Unauthorized' })
      }
    }

    // ── Default JWT session path (unchanged) ─────────────────────────────────
    try {
      await request.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  })
})
