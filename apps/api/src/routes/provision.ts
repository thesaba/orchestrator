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
          template:   { type: 'string', enum: ['laravel', 'wordpress', 'static'] }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const siteId = Number(id)
    const { dbName, dbUser, dbPassword, template = 'laravel' } = request.body as {
      dbName: string
      dbUser: string
      dbPassword: string
      template?: 'laravel' | 'wordpress' | 'static'
    }

    if (emitters.has(siteId)) {
      return reply.code(409).send({ error: 'Provisioning already running for this site' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    await app.prisma.site.update({
      where: { id: siteId },
      data: { status: 'provisioning', dbName, dbUser }
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

    const script = localServer ? path.join(resolvedScriptsDir(), 'provision.sh') : `${scriptDir}/provision.sh`
    const proc = await spawnOn(serverCtx, 'bash', [script, site.domain, site.phpVersion, dbName, dbUser, dbPassword, template], { tty: !localServer })

    const addLine = (raw: string) => {
      const buf = logBuffers.get(siteId)!
      buf.lines.push(raw)
      emitter.emit('log', raw)
    }

    proc.stdout.on('data', (chunk: Buffer) => addLine(chunk.toString()))
    proc.stderr.on('data', (chunk: Buffer) => addLine(chunk.toString()))

    proc.on('close', async (code) => {
      const status = code === 0 ? 'active' : 'error'
      await app.prisma.site.update({ where: { id: siteId }, data: { status } })

      if (code === 0) {
        // Register the primary database so the Databases page shows it
        // immediately instead of the "will appear here once migrated" message.
        // dbPass is intentionally empty — primary credentials live in shared/.env.
        try {
          await app.prisma.siteDatabase.upsert({
            where:  { dbName },
            create: { siteId, dbName, dbUser, dbPass: '', isPrimary: true },
            update: {}  // already registered — leave it alone
          })
        } catch (err) {
          console.error('[provision] Failed to create SiteDatabase record:', err)
        }

        // Best-effort: point DNS at this server via Cloudflare, if configured.
        // Never blocks or fails provisioning — the outcome is just logged.
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

      emitter.emit('done', status)
      emitters.delete(siteId)

      // Keep log in memory for 30 min in case user reconnects
      setTimeout(() => logBuffers.delete(siteId), 30 * 60 * 1000)
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
