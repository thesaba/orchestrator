import { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { spawn, exec as execCb } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { promisify } from 'util'
import path from 'path'
import crypto from 'crypto'
import { notifyDeploy } from '../lib/notify'
import { decryptSecret, encryptSecret } from '../lib/crypto'

const exec = promisify(execCb)

// Keyed by siteId — only one deploy runs per site at a time
const deployEmitters = new Map<number, EventEmitter>()

// Keyed by deploymentId — logs persist 30 min after completion
const deployLogBuffers = new Map<number, string[]>()

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

// For private repos: inject the access token into the HTTPS clone URL.
// Works for GitHub/GitLab/Bitbucket PATs ("https://<token>@host/owner/repo.git").
// Only applied to http(s) URLs — SSH-style URLs (git@host:owner/repo.git) are left
// untouched and rely on the host's own SSH key/agent, as before.
function buildAuthenticatedUrl(repoUrl: string, token?: string | null): string {
  if (!token) return repoUrl
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return repoUrl
    url.username = token
    return url.toString()
  } catch {
    return repoUrl
  }
}

export async function runDeploy(
  app: FastifyInstance,
  siteId: number,
  opts: {
    rootPath: string
    repoUrl: string
    branch: string
    phpVersion: string
    domain?: string
    gitToken?: string | null
  }
): Promise<number> {
  if (deployEmitters.has(siteId)) {
    throw Object.assign(new Error('Deploy already in progress'), { code: 409 })
  }

  const deployment = await app.prisma.deployment.create({
    data: { siteId, branch: opts.branch, status: 'running' }
  })

  const emitter = new EventEmitter()
  emitter.setMaxListeners(20)
  deployEmitters.set(siteId, emitter)
  deployLogBuffers.set(deployment.id, [])

  const authenticatedRepoUrl = buildAuthenticatedUrl(opts.repoUrl, opts.gitToken)

  const proc = spawn(
    'bash',
    [path.join(scriptsDir(), 'deploy.sh'), opts.rootPath, opts.branch, opts.phpVersion],
    {
      // Pass the (possibly token-embedded) URL via env instead of argv so it
      // never shows up in `ps`/process listings on the server.
      env: { ...process.env, REPO_URL: authenticatedRepoUrl }
    }
  )

  let commitHash = ''

  // Defense in depth: if git ever echoes the clone URL back (e.g. in a
  // "repository not found" error), strip the token out of the stored/streamed log.
  const sanitize = (line: string) =>
    opts.gitToken ? line.split(opts.gitToken).join('***') : line

  const addLine = (raw: string) => {
    const line = sanitize(raw)
    deployLogBuffers.get(deployment.id)!.push(line)
    emitter.emit('log', line)
    const m = line.match(/__COMMIT__:([a-f0-9]+)/)
    if (m) commitHash = m[1]
  }

  proc.stdout.on('data', (c: Buffer) => addLine(c.toString()))
  proc.stderr.on('data', (c: Buffer) => addLine(c.toString()))

  proc.on('close', async (code) => {
    const status = code === 0 ? 'success' : 'failed'
    const log = deployLogBuffers.get(deployment.id)!.join('')

    await app.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status, log, commit: commitHash || null }
    })

    // Audit log
    app.audit(`deploy.${status}`, {
      siteId,
      meta: { domain: opts.domain, branch: opts.branch, commit: commitHash || null }
    })

    // Slack notification (best-effort)
    if (opts.domain) {
      notifyDeploy(app, {
        domain: opts.domain,
        branch: opts.branch,
        commit: commitHash || null,
        status,
        siteId
      })
    }

    emitter.emit('done', status)
    deployEmitters.delete(siteId)

    setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60 * 1000)
  })

  return deployment.id
}

export const deployRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // ── POST /:id/deploy — trigger deploy ────────────────────────────────────
  app.post('/:id/deploy', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.repoUrl) return reply.code(400).send({ error: 'No repository URL configured' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    try {
      const deploymentId = await runDeploy(app, siteId, {
        rootPath: site.rootPath,
        repoUrl: site.repoUrl,
        branch: site.branch,
        phpVersion: site.phpVersion,
        domain: site.domain,
        gitToken: site.gitToken ? decryptSecret(site.gitToken) : null
      })
      return { started: true, deploymentId }
    } catch (err: unknown) {
      const e = err as { code?: number; message: string }
      return reply.code(e.code ?? 500).send({ error: e.message })
    }
  })

  // ── GET /:id/deploy/stream — SSE of current deploy ───────────────────────
  app.get('/:id/deploy/stream', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    const running = await app.prisma.deployment.findFirst({
      where: { siteId, status: 'running' },
      orderBy: { createdAt: 'desc' }
    })

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const send = (data: object) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Flush buffered log lines (reconnect resilience)
    if (running) {
      for (const line of deployLogBuffers.get(running.id) ?? []) send({ line })
    }

    await new Promise<void>((resolve) => {
      const emitter = deployEmitters.get(siteId)

      if (!emitter) {
        send({ done: true, status: running?.status ?? 'unknown' })
        reply.raw.end()
        resolve()
        return
      }

      const onLog = (line: string) => send({ line })
      const onDone = (status: string) => {
        send({ done: true, status })
        reply.raw.end()
        cleanup()
        resolve()
      }
      const ka = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ka\n\n')
      }, 20_000)
      const cleanup = () => {
        emitter.off('log', onLog)
        emitter.off('done', onDone)
        clearInterval(ka)
      }

      emitter.on('log', onLog)
      emitter.on('done', onDone)
      request.raw.on('close', () => { cleanup(); resolve() })
    })
  })

  // ── PATCH /:id — update repo settings ────────────────────────────────────
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          repoUrl:  { type: 'string', maxLength: 500 },
          branch:   { type: 'string', minLength: 1, maxLength: 100 },
          name:     { type: 'string', minLength: 1, maxLength: 100 },
          // Write-only: a Personal Access Token for cloning private repos.
          // Send '' to clear a previously saved token.
          gitToken: { type: 'string', maxLength: 500 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { repoUrl, branch, name, gitToken } = request.body as {
      repoUrl?: string
      branch?: string
      name?: string
      gitToken?: string
    }
    const site = await app.prisma.site.update({
      where: { id: siteId },
      data: {
        ...(repoUrl !== undefined && { repoUrl }),
        ...(branch !== undefined && { branch }),
        ...(name !== undefined && { name }),
        ...(gitToken !== undefined && { gitToken: gitToken ? encryptSecret(gitToken) : null })
      }
    })
    // Never echo the encrypted token back — just whether one is set.
    const { gitToken: _omit, ...safeSite } = site
    return { ...safeSite, hasGitToken: !!site.gitToken }
  })

  // ── POST /:id/webhook-token — generate unique webhook secret ─────────────
  app.post('/:id/webhook-token', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const token = crypto.randomBytes(24).toString('hex')
    const site = await app.prisma.site.update({
      where: { id: siteId },
      data: { webhookToken: token }
    })
    return { webhookToken: site.webhookToken }
  })

  // ── GET /:id/releases — list on-disk releases + active symlink ────────────
  app.get('/:id/releases', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const releasesDir = path.join(site.rootPath, 'releases')

    try {
      const entries = await fs.readdir(releasesDir)

      // Resolve the current symlink to find the active release name
      let currentRelease = ''
      try {
        const target = await fs.readlink(path.join(site.rootPath, 'current'))
        currentRelease = path.basename(target)
      } catch { /* no symlink yet */ }

      const releases = (
        await Promise.all(
          entries.map(async (name) => {
            const stat = await fs.stat(path.join(releasesDir, name)).catch(() => null)
            if (!stat?.isDirectory()) return null
            return {
              name,
              isCurrent: name === currentRelease,
              createdAt: stat.birthtime.toISOString()
            }
          })
        )
      )
        .filter(Boolean)
        .sort((a, b) => b!.name.localeCompare(a!.name)) // newest first (14-digit timestamp)

      return { releases, current: currentRelease }
    } catch {
      return { releases: [], current: '' }
    }
  })

  // ── POST /:id/rollback — atomic symlink swap to a previous release ─────────
  app.post('/:id/rollback', {
    schema: {
      body: {
        type: 'object',
        required: ['release'],
        properties: {
          release: { type: 'string', pattern: '^\\d{14}$' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { release } = request.body as { release: string }

    // Strict validation: only 14-digit timestamps from deploy.sh are allowed
    if (!/^\d{14}$/.test(release)) {
      return reply.code(400).send({ error: 'Invalid release name.' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (deployEmitters.has(siteId)) {
      return reply.code(409).send({ error: 'A deploy / rollback is already running for this site.' })
    }

    const releasePath = path.join(site.rootPath, 'releases', release)
    try {
      await fs.access(releasePath)
    } catch {
      return reply.code(404).send({ error: `Release ${release} not found on disk.` })
    }

    // Create a deployment record to track this rollback
    const deployment = await app.prisma.deployment.create({
      data: { siteId, branch: 'rollback', commit: release, status: 'running' }
    })

    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    deployEmitters.set(siteId, emitter)
    const buffer: string[] = []
    deployLogBuffers.set(deployment.id, buffer)

    const push = (line: string) => {
      buffer.push(line)
      emitter.emit('log', line)
    }

    // Run rollback asynchronously so the HTTP response returns immediately
    ;(async () => {
      const currentPath = path.join(site.rootPath, 'current')
      try {
        push(`↩  Rolling back to release ${release}…`)

        // Atomic symlink swap — ln -sfn is safe on Linux (replaces in one syscall)
        await exec(`ln -sfn "${releasePath}" "${currentPath}"`)
        push(`✓  current → releases/${release}`)

        // Restart queue workers so they pick up the rolled-back codebase
        try {
          await exec(`php${site.phpVersion} "${currentPath}/artisan" queue:restart --no-interaction`)
          push('✓  queue:restart signal sent')
        } catch {
          push('⚠  queue:restart failed (supervisor may not be running — that is okay)')
        }

        push('Rollback complete.')

        await app.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'success', log: buffer.join('\n') }
        })
        app.audit('rollback.success', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'success')
      } catch (err: unknown) {
        const msg = (err as Error).message ?? 'Unknown error'
        push(`✗  Rollback failed: ${msg}`)
        await app.prisma.deployment.update({
          where: { id: deployment.id },
          data: { status: 'failed', log: buffer.join('\n') }
        })
        app.audit('rollback.failed', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'failed')
      } finally {
        deployEmitters.delete(siteId)
        setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60 * 1000)
      }
    })()

    return { started: true, deploymentId: deployment.id }
  })
}
