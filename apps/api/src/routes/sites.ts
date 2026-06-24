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

  // Strip the encrypted gitToken column before sending a site to the client —
  // it's write-only; the UI only needs to know whether one is set.
  function redactGitToken<T extends { gitToken?: string | null }>(site: T) {
    const { gitToken, ...rest } = site
    return { ...rest, hasGitToken: !!gitToken }
  }

  app.get('/', async () => {
    const sites = await app.prisma.site.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        deployments: { take: 1, orderBy: { createdAt: 'desc' } }
      }
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

  app.post('/', {
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
      name: string
      domain: string
      phpVersion?: string
    }
    const site = await app.prisma.site.create({
      data: {
        name,
        domain,
        phpVersion: phpVersion ?? '8.2',
        rootPath: `/var/www/sites/${domain}`
      }
    })
    app.audit('site.created', { siteId: site.id, meta: { domain, phpVersion: site.phpVersion } })
    reply.code(201)
    return redactGitToken(site)
  })

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { cleanup } = request.query as { cleanup?: string }

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    // Run server cleanup before removing DB record so we still have the metadata
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

    if (cleanup === 'true') {
      return { ok: true, cleanupOk, cleanupLog }
    }
    reply.code(204).send()
  })
}
