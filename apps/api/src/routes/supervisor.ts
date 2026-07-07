import { FastifyPluginAsync } from 'fastify'
import { execOn, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import { readFileOn, writeFileOn, existsOn, unlinkOn, mkdirOn } from '../lib/server-fs'

const VALID_WORKER_ACTIONS = new Set(['start', 'stop', 'restart'])

// Run a shell command on the site's server (local in-process, remote over SSH).
const sh = (ctx: ServerCtx, cmd: string) => execOn(ctx, 'bash', ['-lc', cmd])

// shared/logs is created by provision.sh as www-data:www-data, mode 750. If the
// panel runs unprivileged, plain mkdir may fail — fall back to a sudo install.
// Runs on the site's own server.
async function ensureSharedLogsDir(ctx: ServerCtx, rootPath: string): Promise<void> {
  const dir = `${rootPath}/shared/logs`
  try { await mkdirOn(ctx, dir); return } catch (err) {
    console.error(`[supervisor] direct mkdir failed for ${dir}:`, err)
  }
  try {
    await sh(ctx, `sudo /usr/bin/install -d -o www-data -g www-data -m 0750 "${dir}"`)
  } catch (err) {
    console.error(`[supervisor] sudo install -d fallback ALSO failed for ${dir}:`, err)
  }
}

export const supervisorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── Supervisor config ─────────────────────────────────────────────────────

  app.get('/:id/supervisor', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const configPath = `/etc/supervisor/conf.d/${site.domain}-worker.conf`
    try {
      const content = await readFileOn(ctx, configPath)
      return { content, path: configPath }
    } catch {
      return { content: supervisorTemplate(site), path: configPath }
    }
  })

  app.put('/:id/supervisor', {
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', maxLength: 8192 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const { content } = request.body as { content: string }
    const configPath = `/etc/supervisor/conf.d/${site.domain}-worker.conf`

    // supervisord refuses to (re)read a config whose stdout_logfile directory
    // doesn't exist yet (CANT_REREAD) — create it defensively here.
    await ensureSharedLogsDir(ctx, site.rootPath)

    await writeFileOn(ctx, configPath, content)

    try {
      const { stdout, stderr } = await sh(ctx, 'supervisorctl reread && supervisorctl update 2>&1')
      return { ok: true, output: (stdout + stderr).trim() }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      const output = (e.stdout ?? e.stderr ?? e.message ?? '').trim()
      return reply.code(500).send({ error: 'supervisorctl update failed', details: output })
    }
  })

  // ── Worker process status ─────────────────────────────────────────────────

  app.get('/:id/supervisor/status', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const group = `${site.domain}-worker`
    try {
      // supervisorctl returns non-zero when processes are not RUNNING — capture both cases
      const result = await sh(ctx, `supervisorctl status "${group}:" 2>&1`).catch((e: unknown) => ({
        stdout: (e as { stdout?: string; stderr?: string }).stdout ?? '',
        stderr: (e as { stderr?: string }).stderr ?? ''
      }))
      return { processes: parseStatus((result as { stdout: string }).stdout ?? '') }
    } catch {
      return { processes: [] }
    }
  })

  // ── Worker control ────────────────────────────────────────────────────────

  app.post('/:id/supervisor/control', {
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'restart'] }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const { action } = request.body as { action: string }
    if (!VALID_WORKER_ACTIONS.has(action)) {
      return reply.code(400).send({ error: `Invalid action: ${action}` })
    }

    const group = `${site.domain}-worker`
    const configPath = `/etc/supervisor/conf.d/${site.domain}-worker.conf`
    let output = ''
    let ok = false

    // If starting, ensure the supervisor config exists first
    if (action === 'start') {
      if (!(await existsOn(ctx, configPath))) {
        await ensureSharedLogsDir(ctx, site.rootPath)
        await writeFileOn(ctx, configPath, supervisorTemplate(site))
        await sh(ctx, 'supervisorctl reread && supervisorctl update 2>&1').catch(() => {})
      }
    }

    try {
      const result = await sh(ctx, `supervisorctl ${action} "${group}:" 2>&1`)
      output = (result.stdout + result.stderr).trim()
      ok = true
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      output = (e.stdout ?? e.stderr ?? e.message ?? '').trim()
    }

    // If control command failed with "no such group", try writing config and retrying
    if (!ok && output.includes('no such group')) {
      if (!(await existsOn(ctx, configPath))) {
        await ensureSharedLogsDir(ctx, site.rootPath)
        await writeFileOn(ctx, configPath, supervisorTemplate(site))
        await sh(ctx, 'supervisorctl reread && supervisorctl update 2>&1').catch(() => {})
        try {
          const result = await sh(ctx, `supervisorctl ${action} "${group}:" 2>&1`)
          output = (result.stdout + result.stderr).trim()
          ok = true
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string }
          output = (e.stdout ?? e.stderr ?? e.message ?? '').trim()
          if (output.includes('no such group')) {
            return reply.code(500).send({ error: 'Supervisor group not found. Config was written but failed to load — check supervisor logs.', details: output })
          }
        }
      } else {
        return reply.code(500).send({ error: 'Supervisor group not found. Try saving the supervisor config to reload it.', details: output })
      }
    }

    // Re-fetch status so the frontend can update immediately
    const statusResult = await sh(ctx, `supervisorctl status "${group}:" 2>&1`).catch((e: unknown) => ({
      stdout: (e as { stdout?: string }).stdout ?? ''
    }))
    const processes = parseStatus((statusResult as { stdout: string }).stdout ?? '')

    return { ok, action, output, processes }
  })

  // ── Laravel Scheduler cron ────────────────────────────────────────────────

  app.get('/:id/cron', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const cronPath = cronFilePath(site.domain)
    const expected = cronLine(site.domain, site.phpVersion, site.rootPath)
    try {
      const content = await readFileOn(ctx, cronPath)
      return { active: true, content, path: cronPath, expected }
    } catch {
      return { active: false, content: '', path: cronPath, expected }
    }
  })

  // Enable scheduler
  app.put('/:id/cron', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const cronPath = cronFilePath(site.domain)
    const content = cronLine(site.domain, site.phpVersion, site.rootPath)
    await writeFileOn(ctx, cronPath, content + '\n')
    // cron.d files must be owned by root and not world-writable
    await sh(ctx, `chmod 644 "${cronPath}"`).catch(() => {})
    return { ok: true, path: cronPath }
  })

  // Disable scheduler
  app.delete('/:id/cron', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await serverCtxForSite(app.prisma, site)

    const cronPath = cronFilePath(site.domain)
    await unlinkOn(ctx, cronPath)
    return { ok: true }
  })
}

// ── helpers ───────────────────────────────────────────────────────────────────

function supervisorTemplate(site: {
  domain: string; phpVersion: string; rootPath: string
}): string {
  return `[program:${site.domain}-worker]
process_name=%(program_name)s_%(process_num)02d
command=php${site.phpVersion} ${site.rootPath}/current/artisan queue:work redis --sleep=3 --tries=3 --max-time=3600
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
user=www-data
numprocs=2
redirect_stderr=true
stdout_logfile=${site.rootPath}/shared/logs/worker.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
stopwaitsecs=3600
`
}

// Dot-separated domain → safe filename (cron.d ignores files with dots)
function cronFilePath(domain: string): string {
  return `/etc/cron.d/${domain.replace(/\./g, '-')}-scheduler`
}

function cronLine(domain: string, phpVer: string, rootPath: string): string {
  return `# Laravel Scheduler — ${domain}
* * * * * www-data php${phpVer} ${rootPath}/current/artisan schedule:run >> /dev/null 2>&1`
}

interface WorkerProcess {
  name: string
  state: string
  description: string
}

function parseStatus(stdout: string): WorkerProcess[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // e.g. "app.example.com-worker:app.example.com-worker_00   RUNNING   pid 123, uptime 0:02:11"
      const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/)
      if (!m) return null
      return { name: m[1], state: m[2].toUpperCase(), description: m[3].trim() }
    })
    .filter(Boolean) as WorkerProcess[]
}
