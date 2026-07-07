import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { getSetting } from '../lib/telegram'

// Admin control for a site's public status page (enable + get the public URL).
// Registered under /api/sites, so it inherits per-site access checks.
export const statusPageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  async function urlFor(token: string | null): Promise<string | null> {
    if (!token) return null
    const base = (await getSetting(app, 'panel_url')).replace(/\/+$/, '')
    return base ? `${base}/status/${token}` : `/status/${token}`
  }

  app.get('/:id/status-page', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) },
      select: { statusPageEnabled: true, statusPageToken: true }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    return { enabled: site.statusPageEnabled, token: site.statusPageToken, url: await urlFor(site.statusPageToken) }
  })

  app.post('/:id/status-page', {
    schema: { body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } }, additionalProperties: false } }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { enabled } = request.body as { enabled: boolean }
    const site = await app.prisma.site.findUnique({ where: { id }, select: { statusPageToken: true } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    // Generate a token the first time it's enabled; keep it stable afterwards.
    const token = site.statusPageToken ?? (enabled ? crypto.randomBytes(12).toString('hex') : null)
    await app.prisma.site.update({
      where: { id },
      data: { statusPageEnabled: enabled, ...(token && !site.statusPageToken ? { statusPageToken: token } : {}) }
    })
    app.audit('site.status_page', { req: request, siteId: id, meta: { enabled } })
    return { enabled, token, url: await urlFor(token) }
  })
}
