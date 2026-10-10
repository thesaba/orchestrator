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
          package: { type: 'string', maxLength: 200 }, // empty = update all
          // Present → MAJOR upgrade: bump the composer.json constraint to
          // ^targetVersion via `composer require`. Requires `package`.
          targetVersion: { type: 'string', maxLength: 32 }
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
    const { package: pkg, targetVersion } = (request.body ?? {}) as { package?: string; targetVersion?: string }

    // The package name is interpolated into a bash -lc string; validate it to a
    // strict Composer spec (vendor/name[:constraint]) so no shell metacharacter
    // ($, backtick, ", \, ;, |, spaces) can ever reach the shell. Rejecting the
    // whole shape is simpler and safer than escaping.
    if (pkg && !/^[a-z0-9]([a-z0-9._-]*)\/[a-z0-9]([a-z0-9._-]*)(:[A-Za-z0-9._^~*<>=. -]+)?$/.test(pkg)) {
      return reply.code(400).send({ error: 'Invalid composer package name' })
    }
    // A major upgrade targets one package and a plain version number (e.g. 13.4.1).
    if (targetVersion !== undefined) {
      if (!pkg) return reply.code(400).send({ error: 'A package is required for a major upgrade' })
      if (!/^\d+(\.\d+){0,2}$/.test(targetVersion)) {
        return reply.code(400).send({ error: 'Invalid target version (expected e.g. 13 or 13.4.1)' })
      }
    }

    const cwd = path.join(site.rootPath, 'current')
    const php = `php${site.phpVersion}`

    // Run composer AS www-data (the app owner), not as the panel's root user.
    // Running as root in a www-data-owned Laravel release makes git refuse the
    // repo ("dubious ownership") and makes post-update artisan scripts fail when
    // they write to www-data-owned storage/bootstrap-cache. A writable
    // COMPOSER_HOME under the site's shared/ dir also enables the package cache.
    const sharedHome    = `${site.rootPath}/shared`
    const composerHome  = `${sharedHome}/.composer`
    const prep = `mkdir -p "${composerHome}" && chown www-data:www-data "${composerHome}" "${sharedHome}" 2>/dev/null || true`
    const asWww = `sudo -u www-data env HOME="${sharedHome}" COMPOSER_HOME="${composerHome}"`

    let coreCmd: string
    if (pkg && targetVersion) {
      // MAJOR upgrade — change the constraint to ^targetVersion via `composer
      // require`, preserving whether the package lives in require vs require-dev
      // (detected from composer.json so a dev tool like phpunit isn't promoted to
      // a production dependency). -W lets its dependencies move too.
      const detectDev = `DEV=$(${php} -r '$j=json_decode(@file_get_contents("composer.json"),true)?:[]; echo isset($j["require-dev"]["${pkg}"])?"--dev":"";')`
      coreCmd = `${detectDev}; ${asWww} ${php} $(command -v composer) require $DEV "${pkg}:^${targetVersion}" -W --no-interaction --no-ansi --ignore-platform-reqs`
    } else if (pkg) {
      coreCmd = `${asWww} ${php} $(command -v composer) update "${pkg}" --no-interaction --no-ansi --ignore-platform-reqs -W`
    } else {
      coreCmd = `${asWww} ${php} $(command -v composer) update --no-interaction --no-ansi --ignore-platform-reqs`
    }
    const cmd = `${prep}; ${coreCmd} 2>&1`

    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc', cmd], { cwd, timeout: 300_000 })
      app.audit('composer.update', { siteId: site.id, meta: { package: pkg ?? 'all', domain: site.domain, ...(targetVersion ? { majorTo: targetVersion } : {}) } })
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
