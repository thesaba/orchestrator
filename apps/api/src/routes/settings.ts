import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'

// Only these keys can be read or written via the API
const ALLOWED_KEYS = new Set([
  'panel_title',
  'panel_url',
  'notify_email',
  'deploy_slack_webhook'
])

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // ── GET /api/settings ──────────────────────────────────────────────────────
  app.get('/', async () => {
    const rows = await app.prisma.setting.findMany({
      where: { key: { in: [...ALLOWED_KEYS] } }
    })
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  })

  // ── PUT /api/settings ──────────────────────────────────────────────────────
  app.put('/', async (request, reply) => {
    const body = request.body as Record<string, string>

    const allowed = Object.entries(body).filter(([k]) => ALLOWED_KEYS.has(k))
    if (allowed.length === 0) {
      return reply.code(400).send({ error: 'No valid settings keys provided.' })
    }

    await Promise.all(
      allowed.map(([key, value]) =>
        app.prisma.setting.upsert({
          where:  { key },
          update: { value },
          create: { key, value }
        })
      )
    )

    return { ok: true, updated: allowed.map(([k]) => k) }
  })

  // ── POST /api/settings/change-password ─────────────────────────────────────
  app.post('/change-password', {
    schema: {
      body: {
        type: 'object',
        required: ['oldPassword', 'newPassword'],
        properties: {
          oldPassword: { type: 'string', minLength: 1, maxLength: 128 },
          newPassword: { type: 'string', minLength: 8, maxLength: 128 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { oldPassword, newPassword } = request.body as {
      oldPassword: string
      newPassword: string
    }

    if (!newPassword || newPassword.length < 8) {
      return reply.code(400).send({ error: 'New password must be at least 8 characters.' })
    }

    const userId = (request.user as { userId: number }).userId
    const user = await app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'User not found.' })

    const valid = await bcrypt.compare(oldPassword, user.password)
    if (!valid) return reply.code(400).send({ error: 'Current password is incorrect.' })

    const hash = await bcrypt.hash(newPassword, 12)
    await app.prisma.user.update({ where: { id: userId }, data: { password: hash } })

    return { ok: true, message: 'Password changed successfully.' }
  })
}
