import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { EventEmitter } from 'events'
import { writeSecret } from '../lib/crypto'
import { execOn, spawnOn, ServerCtx } from '../lib/server-exec'
import { statsFor } from '../lib/server-stats'
import { ensureScriptsSynced } from '../lib/server-sync'

// In-memory streaming state for the (long-running) server bootstrap.
const prepEmitters = new Map<number, EventEmitter>()
const prepBuffers = new Map<number, string[]>()

// Never leak the private key. Public projection of a Server row.
function publicServer(s: any, siteCount = 0) {
  return {
    id: s.id, name: s.name, kind: s.kind, host: s.host, port: s.port,
    sshUser: s.sshUser, hasKey: !!s.sshKey, sshKeyFingerprint: s.sshKeyFingerprint,
    status: s.status, lastSeenAt: s.lastSeenAt, scriptsSynced: s.scriptsSynced,
    notes: s.notes, createdAt: s.createdAt, siteCount
  }
}

function keyChecksum(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
}

// Build an ad-hoc remote exec context from raw (unsaved) form values so the
// "Test connection" button works before the server is persisted. writeKeyFile
// accepts a plaintext key directly.
function rawCtx(b: { host: string; port?: number; sshUser?: string; sshKey: string }): ServerCtx {
  return { kind: 'remote', host: b.host, port: b.port ?? 22, sshUser: b.sshUser ?? 'root', sshKey: b.sshKey }
}

// Reachability probe: run a marker echo + capture basic identity. Never throws.
async function probe(ctx: ServerCtx): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const { stdout } = await execOn(ctx, 'bash', ['-lc', 'echo __ORCH_OK__; uname -sr; id -un'], { timeout: 15_000 })
    if (!stdout.includes('__ORCH_OK__')) return { ok: false, error: 'Unexpected response from server' }
    const info = stdout.replace('__ORCH_OK__', '').trim().replace(/\s+/g, ' ')
    return { ok: true, info }
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string }
    return { ok: false, error: (err.stderr || err.message || 'Connection failed').toString().trim().slice(0, 300) }
  }
}

// Managed servers registry. Admin-only. The single kind="local" row is the
// panel host and cannot be edited into a remote or deleted.
export const serversRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  const prisma = app.prisma as any

  // List servers (+ site counts). Never returns keys.
  app.get('/', async () => {
    const servers = await prisma.server.findMany({ orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] })
    const counts = await prisma.site.groupBy({ by: ['serverId'], _count: { _all: true } }).catch(() => [])
    const localId = servers.find((s: any) => s.kind === 'local')?.id
    const countFor = (id: number) => {
      let n = 0
      for (const c of counts) {
        if (c.serverId === id) n += c._count._all
        if (id === localId && c.serverId === null) n += c._count._all // null → local
      }
      return n
    }
    return { servers: servers.map((s: any) => publicServer(s, countFor(s.id))) }
  })

  // Create a remote server.
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'host', 'sshKey'],
        properties: {
          name:    { type: 'string', minLength: 1, maxLength: 100 },
          host:    { type: 'string', minLength: 1, maxLength: 255 },
          port:    { type: 'integer', minimum: 1, maximum: 65535 },
          sshUser: { type: 'string', minLength: 1, maxLength: 64 },
          sshKey:  { type: 'string', minLength: 1, maxLength: 20000 },
          notes:   { type: 'string', maxLength: 1000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const b = request.body as { name: string; host: string; port?: number; sshUser?: string; sshKey: string; notes?: string }
    const server = await prisma.server.create({
      data: {
        name: b.name, kind: 'remote', host: b.host, port: b.port ?? 22,
        sshUser: b.sshUser ?? 'root', sshKey: writeSecret(b.sshKey),
        sshKeyFingerprint: keyChecksum(b.sshKey), notes: b.notes ?? null
      }
    })
    app.audit('server.created', { req: request, meta: { serverId: server.id, host: b.host } })
    reply.code(201)
    return publicServer(server)
  })

  // Update a server (name/host/port/user/key/notes). Local row: label/notes only.
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          name:    { type: 'string', minLength: 1, maxLength: 100 },
          host:    { type: 'string', minLength: 1, maxLength: 255 },
          port:    { type: 'integer', minimum: 1, maximum: 65535 },
          sshUser: { type: 'string', minLength: 1, maxLength: 64 },
          sshKey:  { type: 'string', minLength: 1, maxLength: 20000 },
          notes:   { type: 'string', maxLength: 1000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const server = await prisma.server.findUnique({ where: { id } })
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    const b = request.body as { name?: string; host?: string; port?: number; sshUser?: string; sshKey?: string; notes?: string }
    const data: any = {}
    if (b.name !== undefined) data.name = b.name
    if (b.notes !== undefined) data.notes = b.notes
    if (server.kind !== 'local') {
      if (b.host !== undefined) data.host = b.host
      if (b.port !== undefined) data.port = b.port
      if (b.sshUser !== undefined) data.sshUser = b.sshUser
      if (b.sshKey) { data.sshKey = writeSecret(b.sshKey); data.sshKeyFingerprint = keyChecksum(b.sshKey); data.scriptsSynced = false }
    }
    const updated = await prisma.server.update({ where: { id }, data })
    app.audit('server.updated', { req: request, meta: { serverId: id } })
    return publicServer(updated)
  })

  // Delete a remote server (blocked if it still hosts sites, or if it's local).
  app.delete('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const server = await prisma.server.findUnique({ where: { id } })
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (server.kind === 'local') return reply.code(400).send({ error: 'The local server cannot be deleted.' })
    const siteCount = await prisma.site.count({ where: { serverId: id } })
    if (siteCount > 0) return reply.code(409).send({ error: `Server still hosts ${siteCount} site(s). Move or remove them first.` })
    await prisma.server.delete({ where: { id } })
    app.audit('server.deleted', { req: request, meta: { serverId: id } })
    return { ok: true }
  })

  // Test an UNSAVED config (add form) — body carries host/port/user/key.
  app.post('/test-connection', {
    schema: {
      body: {
        type: 'object',
        required: ['host', 'sshKey'],
        properties: {
          host:    { type: 'string', minLength: 1, maxLength: 255 },
          port:    { type: 'integer', minimum: 1, maximum: 65535 },
          sshUser: { type: 'string', minLength: 1, maxLength: 64 },
          sshKey:  { type: 'string', minLength: 1, maxLength: 20000 }
        },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const b = request.body as { host: string; port?: number; sshUser?: string; sshKey: string }
    return probe(rawCtx(b))
  })

  // Test a SAVED server; updates status/lastSeenAt.
  app.post('/:id/test', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const server = await prisma.server.findUnique({ where: { id } })
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    const ctx: ServerCtx = server.kind === 'local' || !server.host
      ? null
      : { kind: 'remote', host: server.host, port: server.port, sshUser: server.sshUser, sshKey: server.sshKey }
    const r = await probe(ctx)
    await prisma.server.update({ where: { id }, data: { status: r.ok ? 'online' : 'offline', lastSeenAt: r.ok ? new Date() : server.lastSeenAt } })
    app.audit('server.test', { req: request, meta: { serverId: id, ok: r.ok } })
    return r
  })

  // Live system stats for a server (CPU/RAM/disk/swap/uptime). Local → in-process
  // os stats; remote → one SSH round-trip.
  app.get('/:id/health', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const server = await prisma.server.findUnique({ where: { id } })
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    const ctx: ServerCtx = server.kind === 'local' || !server.host
      ? null
      : { kind: 'remote', host: server.host, port: server.port, sshUser: server.sshUser, sshKey: server.sshKey }
    try {
      const stats = await statsFor(ctx)
      await prisma.server.update({ where: { id }, data: { status: 'online', lastSeenAt: new Date() } }).catch(() => {})
      return { ok: true, stats }
    } catch (e: unknown) {
      await prisma.server.update({ where: { id }, data: { status: 'offline' } }).catch(() => {})
      const err = e as { stderr?: string; message?: string }
      return reply.code(502).send({ error: (err.stderr || err.message || 'Failed to reach server').toString().slice(0, 300) })
    }
  })

  // POST /:id/prepare — install the full LEMP stack (PHP 8.1–8.5 + extensions,
  // nginx, MariaDB, Composer, Supervisor, Certbot, Redis) on a remote server.
  // Streams output via /:id/prepare/stream. Remote-only (the local host is
  // already set up and must not be re-bootstrapped from the panel).
  app.post('/:id/prepare', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const server = await prisma.server.findUnique({ where: { id } })
    if (!server) return reply.code(404).send({ error: 'Server not found' })
    if (server.kind === 'local' || !server.host) {
      return reply.code(400).send({ error: 'The local server is already set up and cannot be bootstrapped from the panel.' })
    }
    if (prepEmitters.has(id)) return reply.code(409).send({ error: 'A bootstrap is already running for this server.' })

    let synced
    try {
      synced = await ensureScriptsSynced(app.prisma, id)
    } catch (e: unknown) {
      return reply.code(502).send({ error: `Could not reach the server: ${(e as Error).message}` })
    }

    const ctx: ServerCtx = { kind: 'remote', host: server.host, port: server.port, sshUser: server.sshUser, sshKey: server.sshKey }
    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    prepEmitters.set(id, emitter)
    const buffer: string[] = []
    prepBuffers.set(id, buffer)

    const addLine = (raw: string) => { buffer.push(raw); emitter.emit('log', raw) }

    // No pty: apt/needrestart must see a non-interactive session (a tty would let
    // them try to prompt and hang forever).
    const proc = await spawnOn(ctx, 'bash', [`${synced.scriptsDir}/bootstrap-server.sh`], { tty: false })
    proc.stdout.on('data', (c: Buffer) => addLine(c.toString()))
    proc.stderr.on('data', (c: Buffer) => addLine(c.toString()))
    proc.on('close', (code) => {
      const status = code === 0 ? 'success' : 'failed'
      emitter.emit('done', status)
      prepEmitters.delete(id)
      setTimeout(() => prepBuffers.delete(id), 30 * 60 * 1000)
    })
    app.audit('server.prepare', { req: request, meta: { serverId: id, host: server.host } })
    return { started: true }
  })

  // GET /:id/prepare/stream — SSE of a running bootstrap.
  app.get('/:id/prepare/stream', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const send = (data: object) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`) }

    for (const line of prepBuffers.get(id) ?? []) send({ line })
    const emitter = prepEmitters.get(id)
    if (!emitter) { send({ done: true, status: 'idle' }); reply.raw.end(); return }

    await new Promise<void>((resolve) => {
      const onLog = (line: string) => send({ line })
      const onDone = (status: string) => { send({ done: true, status }); reply.raw.end(); cleanup(); resolve() }
      const ka = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ka\n\n') }, 20_000)
      const cleanup = () => { emitter.off('log', onLog); emitter.off('done', onDone); clearInterval(ka) }
      emitter.on('log', onLog); emitter.on('done', onDone)
      request.raw.on('close', () => { cleanup(); resolve() })
    })
  })
}
