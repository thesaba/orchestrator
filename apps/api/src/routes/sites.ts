import { FastifyPluginAsync } from 'fastify'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const exec = promisify(execCb)

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

export const sitesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  function redactGitToken<T extends { gitToken?: string | null }>(site: T) {
    const { gitToken, ...rest } = site
    return { ...rest, hasGitToken: !!gitToken }
  }

  app.get('/', async (request) => {
    const payload = request.user as { userId: number; role?: string }
    const role = payload.role ?? 'admin'

    let hasAllSitesAccess = role === 'admin'
    if (!hasAllSitesAccess) {
      const dbUser = await app.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { allSitesAccess: true }
      })
      hasAllSitesAccess = !!dbUser?.allSitesAccess
    }

    const where = hasAllSitesAccess
      ? {}
      : { siteUsers: { some: { userId: payload.userId } } }

    const sites = await app.prisma.site.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: { deployments: { take: 1, orderBy: { createdAt: 'desc' } } }
    })
    return sites.map(redactGitToken)
  })

  app.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const site = await app.prisma.site.findUnique({
      where: { id: Number(id) },
      include: { deployments: { orderBy: { createdAt: 'desc' }, take: 20 } }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    return redactGitToken(site)
  })

  // GET /tags — all distinct tags across all sites
  app.get('/tags', async () => {
    const sites = await app.prisma.site.findMany({ select: { tags: true } })
    const allTags = new Set<string>()
    sites.forEach((s) => {
      try { JSON.parse(s.tags).forEach((t: string) => allTags.add(t)) } catch { /* ignore */ }
    })
    return { tags: [...allTags].sort() }
  })

  app.post('/', {
    preHandler: [app.requireRole(['admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'domain'],
        properties: {
          name:       { type: 'string', minLength: 1, maxLength: 100 },
          domain:     { type: 'string', minLength: 3, maxLength: 253,
                        pattern: '^[a-zA-Z0-9][a-zA-Z0-9\\-\\.]*[a-zA-Z0-9]$' },
          phpVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { name, domain, phpVersion } = request.body as {
      name: string; domain: string; phpVersion?: string
    }
    const site = await app.prisma.site.create({
      data: { name, domain, phpVersion: phpVersion ?? '8.2', rootPath: `/var/www/sites/${domain}` }
    })
    app.audit('site.created', { siteId: site.id, meta: { domain, phpVersion: site.phpVersion } })
    reply.code(201)
    return redactGitToken(site)
  })

  // POST /:id/clone — duplicate a site's config to a new site
  app.post('/:id/clone', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'domain'],
        properties: {
          name:   { type: 'string', minLength: 1, maxLength: 100 },
          domain: { type: 'string', minLength: 3, maxLength: 253 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const sourceId = Number((request.params as { id: string }).id)
    const { name, domain } = request.body as { name: string; domain: string }

    const source = await app.prisma.site.findUnique({ where: { id: sourceId } })
    if (!source) return reply.code(404).send({ error: 'Source site not found' })

    const clone = await app.prisma.site.create({
      data: {
        name,
        domain,
        phpVersion: source.phpVersion,
        rootPath: `/var/www/sites/${domain}`,
        repoUrl: source.repoUrl,
        branch: source.branch,
        preDeploy: source.preDeploy,
        postDeploy: source.postDeploy,
        healthCheck: source.healthCheck,
        healthCheckUrl: source.healthCheckUrl,
        tags: source.tags,
        // don't copy: gitToken, webhookToken, deployments, dbName/dbUser
      }
    })

    app.audit('site.cloned', { siteId: clone.id, meta: { from: source.domain, to: domain } })
    reply.code(201)
    return redactGitToken(clone)
  })

  // NOTE: PATCH /:id (tags/pinned/notes/repo/hooks/etc.) lives in deploy.ts —
  // both this file and deploy.ts are registered under the same '/api/sites'
  // prefix, and Fastify doesn't allow two plugins to declare the same
  // method+path under one prefix (FST_ERR_DUPLICATED_ROUTE).

  app.delete('/:id', { preHandler: [app.requireRole(['admin'])] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { cleanup } = request.query as { cleanup?: string }

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    let cleanupLog = ''
    let cleanupOk: boolean | null = null
    if (cleanup === 'true') {
      try {
        const script = path.join(scriptsDir(), 'cleanup.sh')
        const { stdout, stderr } = await exec(
          `bash "${script}" "${site.domain}" "${site.rootPath}" "${site.dbName ?? ''}" "${site.dbUser ?? ''}"`,
          { timeout: 60_000 }
        )
        cleanupLog = (stdout + stderr).trim()
        cleanupOk  = true
        app.audit('site.cleanup_ok', { meta: { domain: site.domain } })
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string }
        cleanupLog = (e.stdout ?? e.stderr ?? e.message ?? 'Unknown error').trim()
        cleanupOk  = false
        app.audit('site.cleanup_failed', { meta: { domain: site.domain, error: cleanupLog } })
      }
    }

    await app.prisma.site.delete({ where: { id: Number(id) } })
    app.audit('site.deleted', { meta: { domain: site.domain } })

    if (cleanup === 'true') return { ok: true, cleanupOk, cleanupLog }
    reply.code(204).send()
  })

  // GET /branches — list remote branches for a site's repo
  app.get('/:id/branches', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site || !site.repoUrl) return reply.code(400).send({ error: 'No repository configured' })

    try {
      const { stdout } = await exec(
        `git ls-remote --heads "${site.repoUrl}" 2>&1`,
        { timeout: 15_000 }
      )
      const branches = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t')[1]?.replace('refs/heads/', '').trim())
        .filter(Boolean)
      return { branches }
    } catch {
      // If auth fails (private repo without token), return empty
      return { branches: [] }
    }
  })
}
