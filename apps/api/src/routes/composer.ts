import { FastifyPluginAsync } from 'fastify'
import path from 'path'
import { execOn } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'

export const composerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // GET /:id/composer/outdated — list outdated packages
  app.get('/:id/composer/outdated', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const cwd = path.join(site.rootPath, 'current')

    const php = `php${site.phpVersion}`
    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc',
        `${php} $(command -v composer) outdated --no-interaction --format=json --no-ansi 2>/dev/null || ${php} $(command -v composer) outdated --no-interaction --format=json 2>/dev/null`],
        { cwd, timeout: 60_000 }
      )
      const parsed = JSON.parse(stdout)
      return { packages: parsed.installed ?? parsed ?? [] }
    } catch (err: unknown) {
      // composer may exit non-zero even with valid JSON output
      const e = err as { stdout?: string; message?: string }
      try {
        const parsed = JSON.parse(e.stdout ?? '{}')
        return { packages: parsed.installed ?? parsed ?? [] }
      } catch {
        return reply.code(500).send({ error: (err as Error).message })
      }
    }
  })

  // POST /:id/composer/update — update one or all packages
  app.post('/:id/composer/update', {
    schema: {
      body: {
        type: 'object',
        properties: {
          package: { type: 'string', maxLength: 200 } // empty = update all
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const { package: pkg } = (request.body ?? {}) as { package?: string }
    const cwd = path.join(site.rootPath, 'current')
    const php = `php${site.phpVersion}`

    const cmd = pkg
      ? `${php} $(command -v composer) update "${pkg}" --no-interaction --no-ansi --ignore-platform-reqs -W 2>&1`
      : `${php} $(command -v composer) update --no-interaction --no-ansi --ignore-platform-reqs 2>&1`

    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc', cmd], { cwd, timeout: 300_000, env: { COMPOSER_ALLOW_SUPERUSER: '1' } })
      app.audit('composer.update', { siteId: site.id, meta: { package: pkg ?? 'all', domain: site.domain } })
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      return reply.code(500).send({ error: (e.stdout ?? e.stderr ?? e.message ?? 'Failed') })
    }
  })

  // GET /:id/composer/info — composer.json name + require count
  app.get('/:id/composer/info', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const cwd = path.join(site.rootPath, 'current')
    const php = `php${site.phpVersion}`
    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc', `${php} $(command -v composer) show --self --format=json --no-ansi 2>/dev/null`], {
        cwd, timeout: 15_000
      })
      const info = JSON.parse(stdout)
      return { name: info.name, description: info.description, version: info.versions?.[0] }
    } catch {
      return { name: null, description: null, version: null }
    }
  })
}
