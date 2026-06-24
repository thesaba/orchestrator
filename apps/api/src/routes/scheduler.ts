import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'

const exec = promisify(execCb)

// orchestrator-api runs as the unprivileged 'deployer' user, which cannot
// write into /etc/cron.d directly — hand off to root via a narrowly-scoped
// sudoers rule (see DEPLOY_GUIDE.md — /etc/sudoers.d/deployer-fpm).
async function sudoWriteCron(filePath: string, content: string) {
  const tmp = path.join(os.tmpdir(), `cron-${Date.now()}`)
  await fs.writeFile(tmp, content, { mode: 0o644 })
  try {
    await exec(`sudo /usr/bin/install -m 0644 "${tmp}" "${filePath}"`)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

async function sudoRemoveCron(filePath: string) {
  await exec(`sudo /usr/bin/rm -f "${filePath}"`)
}

export const schedulerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

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

    const filePath = cronPath(site.domain)
    let active = false
    try {
      await fs.access(filePath)
      active = true
    } catch { /* not enabled */ }

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

    const filePath = cronPath(site.domain)
    const content = cronContent(site.domain, site.phpVersion, site.rootPath)

    try {
      await sudoWriteCron(filePath, content)
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
      await sudoRemoveCron(cronPath(site.domain))
    } catch { /* already gone — ok */ }

    app.audit('scheduler.disabled', { siteId: site.id, meta: { domain: site.domain } })
    return { ok: true }
  })
}
