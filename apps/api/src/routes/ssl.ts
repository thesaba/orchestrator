import { FastifyPluginAsync } from 'fastify'
import { EventEmitter } from 'events'
import dns from 'dns'
import { getCertInfo } from '../lib/ssl'
import { spawnOn, execOn, isLocal } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'

// One certbot process per site at a time
const sslEmitters = new Map<number, EventEmitter>()
const sslLogBuffers = new Map<number, string[]>()

/**
 * Does `www.<domain>` actually exist in DNS?
 *
 * The vhost lists `www.<domain>` in server_name so the www host lands on the
 * right site, but the certificate must cover it too or browsers get a name
 * mismatch. We only ask certbot for the www name when it really resolves —
 * requesting a name with no DNS record makes certbot fail the WHOLE issuance,
 * which would leave the site with no certificate at all.
 */
async function wwwResolves(domain: string): Promise<boolean> {
  if (domain.startsWith('www.')) return false
  const name = `www.${domain}`
  try {
    const a = await dns.promises.resolve4(name)
    if (a.length) return true
  } catch { /* fall through to CNAME */ }
  try {
    const c = await dns.promises.resolveCname(name)
    return c.length > 0
  } catch {
    return false
  }
}

export const sslRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── GET /:id/ssl — cert status ───────────────────────────────────────────
  app.get('/:id/ssl', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const cert = await getCertInfo(site.domain, await serverCtxForSite(app.prisma, site))
    const running = sslEmitters.has(site.id)

    return { ...cert, sslEnabled: site.sslEnabled, running }
  })

  // ── POST /:id/ssl — issue certificate ────────────────────────────────────
  app.post('/:id/ssl', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    if (sslEmitters.has(siteId)) {
      return reply.code(409).send({ error: 'Certbot is already running for this site.' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (site.status !== 'active') {
      return reply.code(400).send({ error: 'Site must be active before issuing SSL.' })
    }

    // Get admin email from settings. Let's Encrypt rejects bogus addresses
    // (e.g. the old `admin@localhost` default), so only pass --email for a
    // genuinely valid address; otherwise register without one.
    const emailSetting = await app.prisma.setting
      .findUnique({ where: { key: 'notify_email' } })
      .catch(() => null)
    const email = emailSetting?.value?.trim() || ''
    // Basic RFC-ish check + reject non-public TLDs (localhost, .local, .internal).
    const validEmail =
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) &&
      !/@(localhost|.*\.(local|internal|test|invalid))$/i.test(email)
    const acctArgs = validEmail
      ? ['--email', email]
      : ['--register-unsafely-without-email']

    const emitter = new EventEmitter()
    emitter.setMaxListeners(10)
    sslEmitters.set(siteId, emitter)
    const buffer: string[] = []
    sslLogBuffers.set(siteId, buffer)

    // Cover www.<domain> too when it resolves, so visiting the www host doesn't
    // hit a certificate-name mismatch. --expand lets an existing certificate
    // gain the extra name instead of erroring.
    const domainArgs = ['-d', site.domain]
    if (await wwwResolves(site.domain)) domainArgs.push('-d', `www.${site.domain}`)

    const ctx = await serverCtxForSite(app.prisma, site)
    const proc = await spawnOn(ctx, 'certbot', [
      '--nginx',
      ...domainArgs,
      '--expand',
      '--non-interactive',
      '--agree-tos',
      ...acctArgs,
      '--redirect'
    ], { tty: !isLocal(ctx) })

    const addLine = (raw: string) => {
      buffer.push(raw)
      emitter.emit('log', raw)
    }

    proc.stdout.on('data', (c: Buffer) => addLine(c.toString()))
    proc.stderr.on('data', (c: Buffer) => addLine(c.toString()))

    proc.on('close', async (code) => {
      const success = code === 0
      if (success) {
        await app.prisma.site.update({ where: { id: siteId }, data: { sslEnabled: true } })
        app.audit('ssl.issued', { siteId, meta: { domain: site.domain } })
      } else {
        app.audit('ssl.issue_failed', { siteId, meta: { domain: site.domain } })
      }
      emitter.emit('done', success ? 'success' : 'failed')
      sslEmitters.delete(siteId)
      setTimeout(() => sslLogBuffers.delete(siteId), 10 * 60 * 1000)
    })

    return { started: true }
  })

  // ── POST /:id/ssl/renew — force-renew ────────────────────────────────────
  app.post('/:id/ssl/renew', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    if (sslEmitters.has(siteId)) {
      return reply.code(409).send({ error: 'Certbot is already running for this site.' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.sslEnabled) {
      return reply.code(400).send({ error: 'SSL is not enabled for this site.' })
    }

    const emitter = new EventEmitter()
    emitter.setMaxListeners(10)
    sslEmitters.set(siteId, emitter)
    const buffer: string[] = []
    sslLogBuffers.set(siteId, buffer)

    const ctx = await serverCtxForSite(app.prisma, site)
    const proc = await spawnOn(ctx, 'certbot', [
      'renew',
      '--cert-name', site.domain,
      '--force-renewal',
      '--non-interactive'
    ], { tty: !isLocal(ctx) })

    const addLine = (raw: string) => {
      buffer.push(raw)
      emitter.emit('log', raw)
    }

    proc.stdout.on('data', (c: Buffer) => addLine(c.toString()))
    proc.stderr.on('data', (c: Buffer) => addLine(c.toString()))

    proc.on('close', async (code) => {
      const success = code === 0
      app.audit(success ? 'ssl.renewed' : 'ssl.renew_failed', {
        siteId,
        meta: { domain: site.domain }
      })
      emitter.emit('done', success ? 'success' : 'failed')
      sslEmitters.delete(siteId)
      setTimeout(() => sslLogBuffers.delete(siteId), 10 * 60 * 1000)
    })

    return { started: true }
  })

  // ── DELETE /:id/ssl — revoke + delete cert ───────────────────────────────
  app.delete('/:id/ssl', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    if (sslEmitters.has(siteId)) {
      return reply.code(409).send({ error: 'Certbot is already running for this site.' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    try {
      const ctx = await serverCtxForSite(app.prisma, site)
      await execOn(ctx, 'bash', ['-lc', `certbot delete --cert-name "${site.domain}" --non-interactive 2>&1 || true`])
    } catch { /* best-effort */ }

    await app.prisma.site.update({ where: { id: siteId }, data: { sslEnabled: false } })
    app.audit('ssl.removed', { siteId, meta: { domain: site.domain } })

    return { ok: true }
  })

  // ── GET /:id/ssl/stream — SSE of running certbot process ─────────────────
  app.get('/:id/ssl/stream', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

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

    // Replay buffered log (reconnect resilience)
    for (const line of sslLogBuffers.get(siteId) ?? []) send({ line })

    await new Promise<void>((resolve) => {
      const emitter = sslEmitters.get(siteId)

      if (!emitter) {
        send({ done: true, status: 'unknown' })
        reply.raw.end()
        resolve()
        return
      }

      const onLog  = (line: string)   => send({ line })
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
}
