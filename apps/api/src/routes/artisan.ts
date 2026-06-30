import { FastifyPluginAsync } from 'fastify'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'

// Only commands in this map can be executed
const ALLOWED: Record<string, { label: string; description: string; group: string }> = {
  'cache:clear':      { label: 'Clear cache',        description: 'Clear the application cache',                    group: 'Cache'    },
  'config:cache':     { label: 'Cache config',        description: 'Create a cache file for faster config loading',  group: 'Cache'    },
  'config:clear':     { label: 'Clear config',        description: 'Remove the config cache file',                   group: 'Cache'    },
  'view:clear':       { label: 'Clear views',         description: 'Clear compiled view files',                      group: 'Cache'    },
  'route:cache':      { label: 'Cache routes',        description: 'Create a route cache file',                      group: 'Cache'    },
  'route:clear':      { label: 'Clear routes',        description: 'Remove the route cache file',                    group: 'Cache'    },
  'optimize':         { label: 'Optimize',            description: 'Cache config, events, routes, and views',        group: 'Cache'    },
  'optimize:clear':   { label: 'Optimize: clear',     description: 'Clear all cached bootstrap files',               group: 'Cache'    },
  'migrate':          { label: 'Migrate',             description: 'Run pending database migrations',                group: 'Database' },
  'migrate:status':   { label: 'Migration status',    description: 'Show the status of each migration',              group: 'Database' },
  'migrate:rollback': { label: 'Rollback',            description: 'Rollback the last database migration batch',     group: 'Database' },
  'queue:restart':    { label: 'Restart queue',       description: 'Restart queue worker daemons after current job', group: 'Queue'    },
  'storage:link':     { label: 'Storage link',        description: 'Create the symbolic links for storage',          group: 'Other'    },
  'telescope:clear':  { label: 'Clear Telescope',     description: 'Delete all Telescope entries from the database', group: 'Other'    },
  'horizon:terminate':{ label: 'Terminate Horizon',   description: 'Terminate the master Horizon supervisor process', group: 'Other'  },
}

const artisanEmitters = new Map<number, EventEmitter>()
const artisanBuffers  = new Map<number, string[]>()

export const artisanRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── List available commands ────────────────────────────────────────────────

  app.get('/:id/artisan/commands', async () => {
    return {
      commands: Object.entries(ALLOWED).map(([cmd, meta]) => ({ cmd, ...meta }))
    }
  })

  // ── Run a command ─────────────────────────────────────────────────────────

  app.post('/:id/artisan/run', {
    schema: {
      body: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', minLength: 1, maxLength: 100 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { command } = request.body as { command: string }

    if (!ALLOWED[command]) {
      return reply.code(400).send({ error: `Command not in allowlist: ${command}` })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    if (artisanEmitters.has(siteId)) {
      return reply.code(409).send({ error: 'Another artisan command is already running for this site.' })
    }

    const emitter = new EventEmitter()
    const buffer: string[] = []
    artisanEmitters.set(siteId, emitter)
    artisanBuffers.set(siteId, buffer)

    const push = (line: string) => { buffer.push(line); emitter.emit('line', line) }

    const artisanPath = `${site.rootPath}/current/artisan`
    const phpBin = `php${site.phpVersion}`

    const child = spawn(phpBin, [artisanPath, command, '--no-interaction', '--ansi'], {
      cwd: `${site.rootPath}/current`,
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    child.stdout.on('data', (chunk) =>
      String(chunk).split('\n').filter(Boolean).forEach(push)
    )
    child.stderr.on('data', (chunk) =>
      String(chunk).split('\n').filter(Boolean).forEach(push)
    )
    child.on('close', (code) => {
      const status = code === 0 ? 'success' : 'failed'
      emitter.emit('done', status)
      // Keep buffer briefly so a slow SSE subscriber can still read it
      setTimeout(() => {
        artisanEmitters.delete(siteId)
        artisanBuffers.delete(siteId)
      }, 10_000)
    })

    return { started: true, command, siteId }
  })

  // ── SSE output stream ──────────────────────────────────────────────────────

  app.get('/:id/artisan/stream', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    reply.hijack()
    const socket = reply.raw
    socket.setHeader('Content-Type', 'text/event-stream')
    socket.setHeader('Cache-Control', 'no-cache')
    socket.setHeader('Connection', 'keep-alive')

    const send = (obj: object) => socket.write(`data: ${JSON.stringify(obj)}\n\n`)

    // Replay buffered lines for reconnect resilience
    const buffer = artisanBuffers.get(siteId) ?? []
    buffer.forEach((line) => send({ line }))

    const emitter = artisanEmitters.get(siteId)
    if (!emitter) {
      send({ done: true, status: 'idle' })
      socket.end()
      return
    }

    const onLine = (line: string) => send({ line })
    const onDone = (status: string) => { send({ done: true, status }); socket.end() }

    emitter.on('line', onLine)
    emitter.once('done', onDone)
    socket.on('close', () => { emitter.off('line', onLine); emitter.off('done', onDone) })
  })
}

export { ALLOWED as ARTISAN_COMMANDS }
