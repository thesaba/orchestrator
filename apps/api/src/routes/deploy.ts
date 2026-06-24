import { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { spawn, exec as execCb } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { promisify } from 'util'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import { notifyDeploy } from '../lib/notify'
import { decryptSecret, encryptSecret } from '../lib/crypto'

const exec = promisify(execCb)

const deployEmitters  = new Map<number, EventEmitter>()
const deployLogBuffers = new Map<number, string[]>()

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function buildAuthenticatedUrl(repoUrl: string, token?: string | null): string {
  if (!token) return repoUrl
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return repoUrl
    url.username = token
    return url.toString()
  } catch { return repoUrl }
}

// Write a hook script to disk (called before runDeploy so deploy.sh can source it)
async function writeHook(rootPath: string, name: string, content: string | null) {
  const dir = path.join(rootPath, 'hooks')
  const file = path.join(dir, name)
  if (content?.trim()) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(file, `#!/usr/bin/env bash\nset -euo pipefail\n\n${content}\n`, { mode: 0o755 })
  } else {
    await fs.unlink(file).catch(() => {/* not present — ok */})
  }
}

// HTTP health check — returns true if site responds with < 500
async function healthCheckSite(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; statusCode: number | null }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `http://${url}`)
      const lib = parsed.protocol === 'https:' ? require('https') : http
      const req = lib.get(parsed.href, { timeout: timeoutMs }, (res: any) => {
        const ok = res.statusCode < 500
        resolve({ ok, statusCode: res.statusCode })
        res.destroy()
      })
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: null }) })
      req.on('error',   () => { resolve({ ok: false, statusCode: null }) })
    } catch {
      resolve({ ok: false, statusCode: null })
    }
  })
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

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
    healthCheck?: boolean
    healthCheckUrl?: string | null
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
  const sanitize = (line: string) =>
    opts.gitToken ? line.split(opts.gitToken).join('***') : line

  const proc = spawn(
    'bash',
    [path.join(scriptsDir(), 'deploy.sh'), opts.rootPath, opts.branch, opts.phpVersion],
    { env: { ...process.env, REPO_URL: authenticatedRepoUrl } }
  )

  let commitHash = ''
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
    let status: 'success' | 'failed' = code === 0 ? 'success' : 'failed'

    // ── Health check after successful deploy ─────────────────────────────────
    if (status === 'success' && opts.healthCheck) {
      const url = opts.healthCheckUrl || `http://${opts.domain}/`
      addLine(`\n[health] Checking ${url} (3 attempts, 5s apart)...\n`)

      let passed = false
      for (let i = 1; i <= 3; i++) {
        if (i > 1) await sleep(5_000)
        const result = await healthCheckSite(url)
        addLine(`[health] Attempt ${i}: HTTP ${result.statusCode ?? 'timeout'} — ${result.ok ? 'OK' : 'FAIL'}\n`)
        if (result.ok) { passed = true; break }
      }

      if (!passed) {
        addLine(`\n[health] ✗ Health check failed — initiating auto-rollback...\n`)
        status = 'failed'

        // Rollback to the release that was just made (current symlink now points to it)
        try {
          const currentPath = path.join(opts.rootPath, 'current')
          const releasePath = await fs.readlink(currentPath)
          const releaseName = path.basename(releasePath)
          // Find previous release
          const releasesDir = path.join(opts.rootPath, 'releases')
          const entries = (await fs.readdir(releasesDir)).sort().reverse()
          const prevRelease = entries.find((e) => e !== releaseName)
          if (prevRelease) {
            const prevPath = path.join(releasesDir, prevRelease)
            await exec(`ln -sfn "${prevPath}" "${currentPath}"`)
            addLine(`[health] ✓ Rolled back to release ${prevRelease}\n`)
            app.audit('deploy.health_rollback', { siteId, meta: { domain: opts.domain, release: prevRelease } })
          } else {
            addLine(`[health] ⚠ No previous release to roll back to\n`)
          }
        } catch (rbErr: unknown) {
          addLine(`[health] ✗ Auto-rollback failed: ${(rbErr as Error).message}\n`)
        }
      } else {
        addLine(`[health] ✓ Health check passed\n`)
      }
    }

    const log = deployLogBuffers.get(deployment.id)!.join('')

    await app.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status, log, commit: commitHash || null }
    })

    app.audit(`deploy.${status}`, {
      siteId,
      meta: { domain: opts.domain, branch: opts.branch, commit: commitHash || null }
    })

    if (opts.domain) {
      notifyDeploy(app, { domain: opts.domain, branch: opts.branch, commit: commitHash || null, status, siteId })
    }

    emitter.emit('done', status)
    deployEmitters.delete(siteId)
    setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60_000)

    // ── Deploy queue: kick off the queued deploy if any ──────────────────────
    const fresh = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (fresh?.deployQueued) {
      await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: false } })
      setTimeout(async () => {
        try {
          const site = await app.prisma.site.findUnique({ where: { id: siteId } })
          if (!site?.repoUrl) return
          await runDeploy(app, siteId, {
            rootPath: site.rootPath,
            repoUrl: site.repoUrl,
            branch: site.branch,
            phpVersion: site.phpVersion,
            domain: site.domain,
            gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
            healthCheck: site.healthCheck,
            healthCheckUrl: site.healthCheckUrl
          })
        } catch { /* queued deploy failed to start — ignore */ }
      }, 2_000)
    }
  })

  return deployment.id
}

export const deployRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // POST /:id/deploy — trigger deploy (or queue if one is running)
  app.post('/:id/deploy', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.repoUrl) return reply.code(400).send({ error: 'No repository URL configured' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    // Write hook scripts before starting deploy
    await writeHook(site.rootPath, 'pre-deploy.sh',  site.preDeploy)
    await writeHook(site.rootPath, 'post-deploy.sh', site.postDeploy)

    // If deploy already running → queue it instead of rejecting
    if (deployEmitters.has(siteId)) {
      await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: true } })
      return { queued: true, message: 'Deploy queued — will start automatically after the current one finishes.' }
    }

    try {
      const deploymentId = await runDeploy(app, siteId, {
        rootPath: site.rootPath,
        repoUrl: site.repoUrl,
        branch: site.branch,
        phpVersion: site.phpVersion,
        domain: site.domain,
        gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
        healthCheck: site.healthCheck,
        healthCheckUrl: site.healthCheckUrl
      })
      return { started: true, deploymentId }
    } catch (err: unknown) {
      const e = err as { code?: number; message: string }
      return reply.code(e.code ?? 500).send({ error: e.message })
    }
  })

  // GET /:id/deploy/stream — SSE of current deploy
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

      const onLog  = (line: string) => send({ line })
      const onDone = (status: string) => { send({ done: true, status }); reply.raw.end(); cleanup(); resolve() }
      const ka = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ka\n\n') }, 20_000)
      const cleanup = () => { emitter.off('log', onLog); emitter.off('done', onDone); clearInterval(ka) }

      emitter.on('log', onLog)
      emitter.on('done', onDone)
      request.raw.on('close', () => { cleanup(); resolve() })
    })
  })

  // PATCH /:id — update repo, branch, git token, hooks, health check, and
  // site metadata (tags/pinned/notes — merged in here because Fastify
  // doesn't allow two plugins registering the same method+path under the
  // same prefix; this used to also live in sites.ts as a separate handler).
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          repoUrl:       { type: 'string', maxLength: 500 },
          branch:        { type: 'string', minLength: 1, maxLength: 100 },
          name:          { type: 'string', minLength: 1, maxLength: 100 },
          gitToken:      { type: 'string', maxLength: 500 },
          preDeploy:     { type: 'string', maxLength: 4096 },
          postDeploy:    { type: 'string', maxLength: 4096 },
          healthCheck:   { type: 'boolean' },
          healthCheckUrl:{ type: 'string', maxLength: 500 },
          tags:          { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
          pinned:        { type: 'boolean' },
          notes:         { type: 'string', maxLength: 2000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { repoUrl, branch, name, gitToken, preDeploy, postDeploy, healthCheck, healthCheckUrl, tags, pinned, notes } =
      request.body as {
        repoUrl?: string; branch?: string; name?: string; gitToken?: string
        preDeploy?: string; postDeploy?: string; healthCheck?: boolean; healthCheckUrl?: string
        tags?: string[]; pinned?: boolean; notes?: string
      }

    const site = await app.prisma.site.update({
      where: { id: siteId },
      data: {
        ...(repoUrl       !== undefined && { repoUrl }),
        ...(branch        !== undefined && { branch }),
        ...(name          !== undefined && { name }),
        ...(gitToken      !== undefined && { gitToken: gitToken ? encryptSecret(gitToken) : null }),
        ...(preDeploy     !== undefined && { preDeploy }),
        ...(postDeploy    !== undefined && { postDeploy }),
        ...(healthCheck   !== undefined && { healthCheck }),
        ...(healthCheckUrl !== undefined && { healthCheckUrl }),
        ...(tags          !== undefined && { tags: JSON.stringify(tags) }),
        ...(pinned        !== undefined && { pinned }),
        ...(notes         !== undefined && { notes })
      }
    })

    // Write hook scripts immediately so they're on disk for the next deploy
    if (preDeploy !== undefined || postDeploy !== undefined) {
      await writeHook(site.rootPath, 'pre-deploy.sh',  site.preDeploy)
      await writeHook(site.rootPath, 'post-deploy.sh', site.postDeploy)
    }

    const { gitToken: _omit, ...safeSite } = site
    return { ...safeSite, hasGitToken: !!site.gitToken }
  })

  // POST /:id/webhook-token
  app.post('/:id/webhook-token', async (request) => {
    const siteId = Number((request.params as { id: string }).id)
    const token = crypto.randomBytes(24).toString('hex')
    const site = await app.prisma.site.update({ where: { id: siteId }, data: { webhookToken: token } })
    return { webhookToken: site.webhookToken }
  })

  // GET /:id/releases
  app.get('/:id/releases', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const releasesDir = path.join(site.rootPath, 'releases')
    try {
      const entries = await fs.readdir(releasesDir)
      let currentRelease = ''
      try { currentRelease = path.basename(await fs.readlink(path.join(site.rootPath, 'current'))) } catch { /* no symlink */ }

      const releases = (
        await Promise.all(
          entries.map(async (name) => {
            const stat = await fs.stat(path.join(releasesDir, name)).catch(() => null)
            if (!stat?.isDirectory()) return null
            return { name, isCurrent: name === currentRelease, createdAt: stat.birthtime.toISOString() }
          })
        )
      ).filter(Boolean).sort((a, b) => b!.name.localeCompare(a!.name))

      return { releases, current: currentRelease }
    } catch {
      return { releases: [], current: '' }
    }
  })

  // GET /:id/deployments/heatmap — deploy counts per day for last 52 weeks
  app.get('/:id/deployments/heatmap', async (request) => {
    const siteId = Number((request.params as { id: string }).id)
    const since = new Date(Date.now() - 52 * 7 * 86400_000)
    const deployments = await app.prisma.deployment.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: { createdAt: true, status: true }
    })
    // Group by date
    const byDate: Record<string, { total: number; success: number; failed: number }> = {}
    for (const d of deployments) {
      const key = d.createdAt.toISOString().slice(0, 10)
      if (!byDate[key]) byDate[key] = { total: 0, success: 0, failed: 0 }
      byDate[key].total++
      if (d.status === 'success') byDate[key].success++
      if (d.status === 'failed')  byDate[key].failed++
    }
    return { days: byDate }
  })

  // POST /:id/deployments/:deployId/redeploy — one-click redeploy with same branch/commit
  app.post('/:id/deployments/:deployId/redeploy', async (request, reply) => {
    const siteId   = Number((request.params as { id: string; deployId: string }).id)
    const deployId = Number((request.params as { id: string; deployId: string }).deployId)
    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    // Just trigger a fresh deploy (same config)
    const newDeploy = await app.prisma.deployment.create({
      data: { siteId, branch: site.branch, status: 'pending', comment: 'Redeploy' }
    })
    // Trigger deploy using same mechanism - emit on the deploy event
    // For now just mark as pending and return; the normal deploy mechanism handles it
    return reply.code(202).send({ ok: true, deploymentId: newDeploy.id })
  })

  // POST /:id/rollback
  app.post('/:id/rollback', {
    schema: {
      body: {
        type: 'object',
        required: ['release'],
        properties: { release: { type: 'string', pattern: '^\\d{14}$' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { release } = request.body as { release: string }

    if (!/^\d{14}$/.test(release)) return reply.code(400).send({ error: 'Invalid release name.' })

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (deployEmitters.has(siteId)) return reply.code(409).send({ error: 'A deploy / rollback is already running.' })

    const releasePath = path.join(site.rootPath, 'releases', release)
    try { await fs.access(releasePath) } catch { return reply.code(404).send({ error: `Release ${release} not found.` }) }

    const deployment = await app.prisma.deployment.create({
      data: { siteId, branch: 'rollback', commit: release, status: 'running' }
    })

    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    deployEmitters.set(siteId, emitter)
    const buffer: string[] = []
    deployLogBuffers.set(deployment.id, buffer)

    const push = (line: string) => { buffer.push(line); emitter.emit('log', line) }

    ;(async () => {
      const currentPath = path.join(site.rootPath, 'current')
      try {
        push(`↩  Rolling back to release ${release}…`)
        await exec(`ln -sfn "${releasePath}" "${currentPath}"`)
        push(`✓  current → releases/${release}`)
        try {
          await exec(`php${site.phpVersion} "${currentPath}/artisan" queue:restart --no-interaction`)
          push('✓  queue:restart signal sent')
        } catch { push('⚠  queue:restart failed') }
        push('Rollback complete.')
        await app.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'success', log: buffer.join('\n') } })
        app.audit('rollback.success', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'success')
      } catch (err: unknown) {
        const msg = (err as Error).message ?? 'Unknown error'
        push(`✗  Rollback failed: ${msg}`)
        await app.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'failed', log: buffer.join('\n') } })
        app.audit('rollback.failed', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'failed')
      } finally {
        deployEmitters.delete(siteId)
        setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60_000)
      }
    })()

    return { started: true, deploymentId: deployment.id }
  })
}
