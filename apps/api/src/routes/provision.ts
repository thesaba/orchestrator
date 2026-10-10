import { FastifyPluginAsync } from 'fastify'
import { EventEmitter } from 'events'
import path from 'path'
import { getCloudflareCreds, isCloudflareConfigured, upsertARecord } from '../lib/cloudflare'
import { spawnOn } from '../lib/server-exec'
import { serverCtxById } from '../lib/servers'
import { ensureScriptsSynced } from '../lib/server-sync'

interface LogBuffer {
  lines: string[]
}

// In-memory state — survives across requests during a single process lifetime
const emitters = new Map<number, EventEmitter>()
const logBuffers = new Map<number, LogBuffer>()

function resolvedScriptsDir(): string {
  const fromEnv = process.env.SCRIPTS_DIR
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv)
  }
  // Default: monorepo root /scripts
  return path.resolve(__dirname, '../../../../scripts')
}

export const provisionRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── POST /:id/provision ─────────────────────────────────────────────────
  app.post('/:id/provision', {
    schema: {
      body: {
        type: 'object',
        required: ['dbName', 'dbUser', 'dbPassword'],
        properties: {
          dbName:     { type: 'string', minLength: 1, maxLength: 64,  pattern: '^[a-zA-Z0-9_]+$' },
          dbUser:     { type: 'string', minLength: 1, maxLength: 32,  pattern: '^[a-zA-Z0-9_]+$' },
          // Forbid quote/backslash/backtick so the value can never break out of
          // the single-quoted MySQL string literal in provision.sh (IDENTIFIED
          // BY '...') — i.e. no SQL injection into the privileged mysql session.
          dbPassword: { type: 'string', minLength: 8, maxLength: 128, pattern: "^[^'\"\\\\`]+$" },
          template:   { type: 'string', enum: ['laravel', 'wordpress', 'static', 'node'] },
          // 1-click install: when true, a fresh app of `template` is installed into
          // this site (and this site only) right after the base provision.
          installApp:   { type: 'boolean' },
          // WordPress install (only read when template=wordpress && installApp):
          siteTitle:    { type: 'string', maxLength: 120, pattern: "^[^'\"\\\\`$\\n]*$" },
          wpAdminUser:  { type: 'string', maxLength: 60,  pattern: '^[A-Za-z0-9_.@ -]+$' },
          wpAdminEmail: { type: 'string', maxLength: 120, pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
          wpAdminPass:  { type: 'string', minLength: 8, maxLength: 128, pattern: "^[^'\"\\\\`$ ]+$" }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const siteId = Number(id)
    const {
      dbName, dbUser, dbPassword, template = 'laravel',
      installApp = false, siteTitle, wpAdminUser, wpAdminEmail, wpAdminPass
    } = request.body as {
      dbName: string
      dbUser: string
      dbPassword: string
      template?: 'laravel' | 'wordpress' | 'static' | 'node'
      installApp?: boolean
      siteTitle?: string
      wpAdminUser?: string
      wpAdminEmail?: string
      wpAdminPass?: string
    }

    // WordPress 1-click install needs an admin email + password up front.
    if (installApp && template === 'wordpress' && (!wpAdminEmail || !wpAdminPass)) {
      return reply.code(400).send({ error: 'WordPress install requires an admin email and password.' })
    }

    if (emitters.has(siteId)) {
      return reply.code(409).send({ error: 'Provisioning already running for this site' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    await app.prisma.site.update({
      where: { id: siteId },
      data: { status: 'provisioning', dbName, dbUser, stackType: template }
    })

    // Resolve the target server (null → local). For a remote server, make sure
    // the bash scripts are present on it first, then run provision.sh over SSH.
    let serverCtx, scriptDir: string, localServer: boolean
    try {
      serverCtx = await serverCtxById(app.prisma, (site as any).serverId ?? null)
      const synced = await ensureScriptsSynced(app.prisma, (site as any).serverId ?? null)
      scriptDir = synced.scriptsDir
      localServer = synced.local
    } catch (e: unknown) {
      await app.prisma.site.update({ where: { id: siteId }, data: { status: 'pending' } })
      return reply.code(502).send({ error: `Could not reach target server: ${(e as Error).message}` })
    }

    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    emitters.set(siteId, emitter)
    logBuffers.set(siteId, { lines: [] })

    // Node apps are reverse-proxied to a loopback port. Derive one deterministically
    // from the site id so the Nginx vhost and the supervisor program always agree,
    // and two sites never collide. Range 3000–~13000, well clear of system ports.
    const nodePort = template === 'node' ? 3000 + siteId : 0

    const scriptFor = (name: string) =>
      localServer ? path.join(resolvedScriptsDir(), name) : `${scriptDir}/${name}`

    const proc = await spawnOn(
      serverCtx, 'bash',
      [scriptFor('provision.sh'), site.domain, site.phpVersion, dbName, dbUser, dbPassword, template, String(nodePort)],
      { tty: !localServer }
    )

    const addLine = (raw: string) => {
      const buf = logBuffers.get(siteId)
      if (buf) buf.lines.push(raw)
      emitter.emit('log', raw)
    }

    proc.stdout.on('data', (chunk: Buffer) => addLine(chunk.toString()))
    proc.stderr.on('data', (chunk: Buffer) => addLine(chunk.toString()))

    // Register the primary DB + best-effort Cloudflare DNS. Runs once, only after
    // the whole flow (base provision, plus the 1-click install if requested) is OK.
    const finalizeSuccess = async () => {
      try {
        await app.prisma.siteDatabase.upsert({
          where:  { dbName },
          create: { siteId, dbName, dbUser, dbPass: '', isPrimary: true },
          update: {}
        })
      } catch (err) {
        console.error('[provision] Failed to create SiteDatabase record:', err)
      }
      try {
        const creds = await getCloudflareCreds(app.prisma)
        if (isCloudflareConfigured(creds)) {
          addLine('\n[dns] Creating Cloudflare A record...\n')
          const r = await upsertARecord(creds, site.domain)
          addLine(`[dns] ${r.ok ? '✓' : '✗'} ${r.message}\n`)
        }
      } catch (err) {
        addLine(`[dns] ✗ ${(err as Error).message}\n`)
      }
    }

    const finish = (status: string) => {
      emitter.emit('done', status)
      emitters.delete(siteId)
      setTimeout(() => logBuffers.delete(siteId), 30 * 60 * 1000)
    }

    const fail = async (msg?: string) => {
      if (msg) addLine(msg)
      await app.prisma.site.update({ where: { id: siteId }, data: { status: 'error' } }).catch(() => {})
      finish('error')
    }

    proc.on('close', async (code) => {
      if (code !== 0) return fail()

      // Base provision (dirs + DB + vhost) succeeded. Without 1-click install we're done.
      if (!installApp) {
        await app.prisma.site.update({ where: { id: siteId }, data: { status: 'active' } })
        await finalizeSuccess()
        return finish('active')
      }

      // ── 1-click install: scaffold a fresh app into THIS site only ──────────────
      // Optional/sensitive values go via env so titles & passwords can't be
      // mis-split and never appear in argv. starter-install.sh re-validates them.
      addLine(`\n[install] Installing a fresh ${template} app — this can take a minute...\n`)
      const env: Record<string, string> = { APP_URL: `https://${site.domain}` }
      if (template === 'node') env.NODE_PORT = String(nodePort)
      if (template === 'wordpress') {
        env.WP_TITLE       = siteTitle || site.name || site.domain
        env.WP_ADMIN_USER  = wpAdminUser || 'admin'
        env.WP_ADMIN_EMAIL = wpAdminEmail || ''
        env.WP_ADMIN_PASS  = wpAdminPass || ''
      }

      try {
        const starter = await spawnOn(
          serverCtx, 'bash',
          [scriptFor('starter-install.sh'), site.domain, site.phpVersion, dbName, dbUser, dbPassword, template],
          { tty: !localServer, env }
        )
        starter.stdout.on('data', (c: Buffer) => addLine(c.toString()))
        starter.stderr.on('data', (c: Buffer) => addLine(c.toString()))
        starter.on('error', (err: Error) => { void fail(`\n[install] ✗ ${err.message}\n`) })
        starter.on('close', async (scode) => {
          if (scode === 0) {
            await app.prisma.site.update({ where: { id: siteId }, data: { status: 'active' } })
            await finalizeSuccess()
            return finish('active')
          }
          await fail(`\n[install] ✗ Install failed (exit ${scode}). The site & vhost exist — you can deploy from Git instead.\n`)
        })
      } catch (err) {
        await fail(`\n[install] ✗ ${(err as Error).message}\n`)
      }
    })

    return { started: true, siteId }
  })

  // ── GET /:id/provision/stream (SSE) ─────────────────────────────────────
  app.get('/:id/provision/stream', async (request, reply) => {
    const { id } = request.params as { id: string }
    const siteId = Number(id)

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    // Take full control — Fastify won't touch the response after this
    reply.hijack()

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const send = (data: object) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
      }
    }

    // Flush buffered log lines to the new subscriber
    const buf = logBuffers.get(siteId)
    if (buf) {
      for (const line of buf.lines) send({ line })
    }

    await new Promise<void>((resolve) => {
      const emitter = emitters.get(siteId)

      // Process already finished (or never started)
      if (!emitter) {
        send({ done: true, status: site.status })
        reply.raw.end()
        resolve()
        return
      }

      const onLog = (line: string) => send({ line })
      const onDone = (status: string) => {
        send({ done: true, status })
        reply.raw.end()
        emitter.off('log', onLog)
        emitter.off('done', onDone)
        clearInterval(keepAlive)
        resolve()
      }

      const keepAlive = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ka\n\n')
      }, 20_000)

      emitter.on('log', onLog)
      emitter.on('done', onDone)

      request.raw.on('close', () => {
        emitter.off('log', onLog)
        emitter.off('done', onDone)
        clearInterval(keepAlive)
        resolve()
      })
    })
  })

}
