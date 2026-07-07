import { FastifyPluginAsync } from 'fastify'
import path from 'path'
import { execOn } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'

export const maintenanceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // POST /:id/maintenance { action: 'down'|'up', secret?: string }
  app.post('/:id/maintenance', {
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['down', 'up'] },
          secret: { type: 'string', maxLength: 128 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { action, secret } = request.body as { action: 'down' | 'up'; secret?: string }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    const artisan = path.join(site.rootPath, 'current', 'artisan')
    const php = `php${site.phpVersion}`

    try {
      let cmd: string
      if (action === 'down') {
        cmd = secret
          ? `${php} "${artisan}" down --secret="${secret.replace(/"/g, '\\"')}" 2>&1`
          : `${php} "${artisan}" down 2>&1`
      } else {
        cmd = `${php} "${artisan}" up 2>&1`
      }

      const ctx = await serverCtxForSite(app.prisma, site)
      const { stdout } = await execOn(ctx, 'bash', ['-lc', cmd], { timeout: 15_000 })

      await app.prisma.site.update({
        where: { id: siteId },
        data: { maintenanceMode: action === 'down' }
      })

      app.audit(action === 'down' ? 'maintenance.enabled' : 'maintenance.disabled', {
        siteId, meta: { domain: site.domain }
      })

      return { ok: true, action, output: stdout.trim() }
    } catch (err: unknown) {
      const e = err as { stdout?: string; message?: string }
      return reply.code(500).send({ error: (e.stdout ?? (err as Error).message ?? 'Command failed') })
    }
  })

  // GET /:id/maintenance — current maintenance state
  app.get('/:id/maintenance', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) },
      select: { id: true, maintenanceMode: true, domain: true }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    return { maintenanceMode: site.maintenanceMode }
  })
}
