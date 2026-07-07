import { FastifyPluginAsync } from 'fastify'
import os from 'os'
import path from 'path'
import { execOn, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import { writeFileOn, unlinkOn, existsOn } from '../lib/server-fs'

// Cron files live in /etc/cron.d, which needs root — hand off via a temp file +
// sudo install. Runs on the SITE'S server (local in-process, remote over SSH).
async function sudoWriteCron(ctx: ServerCtx, filePath: string, content: string) {
  const tmp = path.join(os.tmpdir(), `cron-${Date.now()}`)
  await writeFileOn(ctx, tmp, content, { mode: 0o644 })
  try {
    await execOn(ctx, 'bash', ['-lc', `sudo /usr/bin/install -m 0644 "${tmp}" "${filePath}"`])
  } finally {
    await unlinkOn(ctx, tmp)
  }
}

async function sudoRemoveCron(ctx: ServerCtx, filePath: string) {
  await execOn(ctx, 'bash', ['-lc', `sudo /usr/bin/rm -f "${filePath}"`])
}

export const schedulerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  function cronPath(domain: string) {
    return `/etc/cron.d/${domain.replace(/[^a-zA-Z0-9-]/g, '-')}-scheduler`
  }

  function cronContent(domain: string, phpVersion: string, rootPath: string) {
    const artisan = `${rootPath}/current/artisan`
    return `# Laravel Scheduler — managed by Orchestrator
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
* * * * * www-data php${phpVersion} "${artisan}" schedule:run >> /dev/null 2>&1\n`
  }

  // GET /:id/scheduler
  app.get('/:id/scheduler', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const filePath = cronPath(site.domain)
    const active = await existsOn(ctx, filePath)

    return {
      active,
      cronPath: filePath,
      cronContent: cronContent(site.domain, site.phpVersion, site.rootPath)
    }
  })

  // PUT /:id/scheduler — enable
  app.put('/:id/scheduler', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const filePath = cronPath(site.domain)
    const content = cronContent(site.domain, site.phpVersion, site.rootPath)

    try {
      await sudoWriteCron(ctx, filePath, content)
      app.audit('scheduler.enabled', { siteId: site.id, meta: { domain: site.domain } })
      return { ok: true, cronPath: filePath }
    } catch (err: unknown) {
      const msg = (err as Error).message
      return reply.code(500).send({ error: `Failed to write cron file: ${msg}` })
    }
  })

  // DELETE /:id/scheduler — disable
  app.delete('/:id/scheduler', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    try {
      const ctx = await serverCtxForSite(app.prisma, site)
      await sudoRemoveCron(ctx, cronPath(site.domain))
    } catch { /* already gone — ok */ }

    app.audit('scheduler.disabled', { siteId: site.id, meta: { domain: site.domain } })
    return { ok: true }
  })
}
