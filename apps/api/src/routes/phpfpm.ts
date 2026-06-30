import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'

const exec = promisify(execCb)

// The orchestrator-api process runs as an unprivileged 'deployer' user (see
// scripts/orchestrator-api.service), so it cannot write into /etc/php/* or
// reload php-fpm directly. We write the new config to a temp file we DO own,
// then hand off to root only for the copy + reload via a narrowly-scoped
// sudoers rule (see DEPLOY_GUIDE.md — /etc/sudoers.d/deployer-fpm).
async function sudoWriteAndReload(filePath: string, content: string, phpVersion: string) {
  const tmp = path.join(os.tmpdir(), `fpm-pool-${Date.now()}.conf`)
  await fs.writeFile(tmp, content, { mode: 0o644 })
  try {
    await exec(`sudo /usr/bin/install -m 0644 "${tmp}" "${filePath}"`)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }

  const { stdout: testOut } = await exec(`sudo /usr/sbin/php-fpm${phpVersion} -t 2>&1`)
    .catch((e: any) => ({ stdout: e.stdout ?? e.stderr ?? '' }))
  if (testOut.includes('FAILED')) {
    throw new Error(`Config syntax error: ${testOut}`)
  }

  let reloaded = false
  try {
    await exec(`sudo /usr/bin/systemctl reload php${phpVersion}-fpm`)
    reloaded = true
  } catch { /* fpm reload optional */ }

  return reloaded
}

export const phpFpmRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  function poolPath(domain: string, phpVersion: string) {
    return `/etc/php/${phpVersion}/fpm/pool.d/${domain.replace(/[^a-zA-Z0-9.-]/g, '_')}.conf`
  }

  function defaultPool(domain: string, phpVersion: string, user = 'www-data'): string {
    const sock = `/run/php/php${phpVersion}-fpm-${domain.replace(/[^a-zA-Z0-9.-]/g, '_')}.sock`
    return `[${domain}]
user = ${user}
group = ${user}
listen = ${sock}
listen.owner = www-data
listen.group = www-data
listen.mode = 0660

pm = dynamic
pm.max_children = 10
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 500

php_admin_value[error_log] = /var/log/php${phpVersion}-fpm-${domain}.log
php_admin_flag[log_errors] = on
`
  }

  // GET /:id/phpfpm
  app.get('/:id/phpfpm', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const filePath = poolPath(site.domain, site.phpVersion)
    let content = ''
    let exists = false
    try {
      content = await fs.readFile(filePath, 'utf-8')
      exists = true
    } catch {
      content = defaultPool(site.domain, site.phpVersion)
    }
    return { content, path: filePath, exists }
  })

  // PUT /:id/phpfpm
  app.put('/:id/phpfpm', {
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', minLength: 1, maxLength: 20_000 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { content } = request.body as { content: string }
    const filePath = poolPath(site.domain, site.phpVersion)

    // Basic sanity check — must contain a pool name
    if (!content.includes('[')) return reply.code(400).send({ error: 'Invalid PHP-FPM pool config' })

    try {
      const reloaded = await sudoWriteAndReload(filePath, content, site.phpVersion)
      app.audit('phpfpm.updated', { siteId: site.id, meta: { domain: site.domain } })
      return { ok: true, reloaded, path: filePath }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}
