import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { writeSecret } from '../lib/crypto'

// Stored encrypted at rest (AES-256-GCM). Read back via readSecret() at the
// point of use (db-manage, s3backup, digitalocean, notify).
const ENCRYPTED_SETTING_KEYS = new Set([
  'mysql_root_password', 's3_secret_key', 'do_api_token', 'deploy_telegram_bot_token'
])

const ALLOWED_KEYS = new Set([
  'panel_title',
  'panel_url',
  'notify_email',
  'deploy_slack_webhook',
  // Additional notification channels
  'deploy_discord_webhook',
  'deploy_telegram_bot_token',
  'deploy_telegram_chat_id',
  'deploy_generic_webhook',
  // S3/R2 backup
  's3_access_key',
  's3_secret_key',
  's3_region',
  's3_bucket',
  's3_endpoint',
  // MySQL root credentials (for creating/dropping databases)
  'mysql_root_user',
  'mysql_root_password',
  // DigitalOcean API (Server page — droplet control)
  'do_api_token',
  'do_droplet_id'
])

// These keys have their values redacted (write-only) in GET responses
const REDACTED_KEYS = new Set(['s3_secret_key', 'mysql_root_password', 'do_api_token', 'deploy_telegram_bot_token'])

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => {
    const rows = await app.prisma.setting.findMany({
      where: { key: { in: [...ALLOWED_KEYS] } }
    })
    return Object.fromEntries(
      rows.map((r) => [r.key, REDACTED_KEYS.has(r.key) ? (r.value ? '••••••••' : '') : r.value])
    )
  })

  app.put('/', { preHandler: [app.requireRole(['admin'])] }, async (request, reply) => {
    const body = request.body as Record<string, string>
    const allowed = Object.entries(body)
      .filter(([k]) => ALLOWED_KEYS.has(k))
      // Ignore the redaction placeholder echoed back by the UI for write-only
      // fields — otherwise we'd overwrite a real secret with "••••••••".
      .filter(([k, v]) => !(REDACTED_KEYS.has(k) && v === '••••••••'))
    if (allowed.length === 0) return reply.code(400).send({ error: 'No valid settings keys provided.' })

    await Promise.all(
      allowed.map(([key, rawValue]) => {
        const value = ENCRYPTED_SETTING_KEYS.has(key) ? writeSecret(rawValue) : rawValue
        return app.prisma.setting.upsert({
          where:  { key },
          update: { value },
          create: { key, value }
        })
      })
    )
    return { ok: true, updated: allowed.map(([k]) => k) }
  })

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
    const { oldPassword, newPassword } = request.body as { oldPassword: string; newPassword: string }
    if (newPassword.length < 8) return reply.code(400).send({ error: 'New password must be at least 8 characters.' })

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
