import { FastifyPluginAsync } from 'fastify'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'

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
          dbPassword: { type: 'string', minLength: 8, maxLength: 128 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const siteId = Number(id)
    const { dbName, dbUser, dbPassword } = request.body as {
      dbName: string
      dbUser: string
      dbPassword: string
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

    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    emitters.set(siteId, emitter)
    logBuffers.set(siteId, { lines: [] })

    const script = path.join(resolvedScriptsDir(), 'provision.sh')
    const proc = spawn('bash', [script, site.domain, site.phpVersion, dbName, dbUser, dbPassword])

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
