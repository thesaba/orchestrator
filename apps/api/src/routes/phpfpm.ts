import { FastifyPluginAsync } from 'fastify'
import path from 'path'
import os from 'os'
import { execOn, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import { readFileOn, writeFileOn, unlinkOn } from '../lib/server-fs'

// The orchestrator-api process may run as an unprivileged user, so it writes the
// new config to a temp file it owns, then hands off to root only for the copy +
// reload via a narrowly-scoped sudoers rule. This runs on the SITE'S server:
// local → in-process; remote → over SSH (server-fs writes the temp file there).
async function sudoWriteAndReload(ctx: ServerCtx, filePath: string, content: string, phpVersion: string) {
  const tmp = path.join(os.tmpdir(), `fpm-pool-${Date.now()}.conf`)
  await writeFileOn(ctx, tmp, content, { mode: 0o644 })
  try {
    await execOn(ctx, 'bash', ['-lc', `sudo /usr/bin/install -m 0644 "${tmp}" "${filePath}"`])
  } finally {
    await unlinkOn(ctx, tmp)
  }

  const { stdout: testOut } = await execOn(ctx, 'bash', ['-lc', `sudo /usr/sbin/php-fpm${phpVersion} -t 2>&1`])
    .catch((e: any) => ({ stdout: e.stdout ?? e.stderr ?? '' }))
  if (testOut.includes('FAILED')) {
    throw new Error(`Config syntax error: ${testOut}`)
  }

  let reloaded = false
  try {
    await execOn(ctx, 'bash', ['-lc', `sudo /usr/bin/systemctl reload php${phpVersion}-fpm`])
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

    const ctx = await serverCtxForSite(app.prisma, site)
    const filePath = poolPath(site.domain, site.phpVersion)
    let content = ''
    let exists = false
    try {
      content = await readFileOn(ctx, filePath)
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
      const ctx = await serverCtxForSite(app.prisma, site)
      const reloaded = await sudoWriteAndReload(ctx, filePath, content, site.phpVersion)
      app.audit('phpfpm.updated', { siteId: site.id, meta: { domain: site.domain } })
      return { ok: true, reloaded, path: filePath }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}
