import { FastifyPluginAsync } from 'fastify'
import { getSetting, setSetting } from '../lib/telegram'
import { buildDigest, sendWeeklyDigest } from '../lib/digest'

// Weekly digest configuration + manual send. Admin-only.
export const digestRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // GET / — config + a live preview of the current digest.
  app.get('/', async () => {
    const [enabled, day, last] = await Promise.all([
      getSetting(app, 'weekly_digest_enabled'),
      getSetting(app, 'weekly_digest_day'),
      getSetting(app, 'weekly_digest_last')
    ])
    return {
      enabled: enabled === '1',
      day: day ? Number(day) : 1,
      lastSent: last || null,
      preview: await buildDigest(app)
    }
  })

  // PATCH / — enable/disable + weekday.
  app.patch('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          day: { type: 'integer', minimum: 0, maximum: 6 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const b = request.body as { enabled?: boolean; day?: number }
    if (b.enabled !== undefined) await setSetting(app, 'weekly_digest_enabled', b.enabled ? '1' : '')
    if (b.day !== undefined) await setSetting(app, 'weekly_digest_day', String(b.day))
    app.audit('digest.config', { req: request, meta: b })
    return { ok: true }
  })

  // POST /send-now — build + send immediately (also useful as a test).
  app.post('/send-now', async (request) => {
    const digest = await sendWeeklyDigest(app)
    app.audit('digest.sent_manually', { req: request })
    return { ok: true, digest }
  })
}
