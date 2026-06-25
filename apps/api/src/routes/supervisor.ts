import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'

const exec = promisify(execCb)

const VALID_WORKER_ACTIONS = new Set(['start', 'stop', 'restart'])

// shared/logs is created by provision.sh as www-data:www-data, mode 750 — the
// orchestrator-api process runs as the unprivileged 'deployer' user, so a plain
// fs.mkdir() here fails with EACCES (silently, if swallowed by .catch(() => {})).
// Try the unprivileged path first (works if the API ever does run as root),
// then fall back to a narrowly-scoped sudoers rule — see DEPLOY_GUIDE.md
// §5.3 (/etc/sudoers.d/deployer-fpm) for the line this requires.
async function ensureSharedLogsDir(rootPath: string): Promise<void> {
  const dir = `${rootPath}/shared/logs`
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch {
    await exec(`sudo /usr/bin/install -d -o www-data -g www-data -m 0750 "${dir}"`).catch(() => {})
  }
}

export const supervisorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // ── Supervisor config ─────────────────────────────────────────────────────

  app.get('/:id/supervisor', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const configPath = `/etc/supervisor/conf.d/${site.domain}-worker.conf`
    try {
      const content = await fs.readFile(configPath, 'utf-8')
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

    const { content } = request.body as { content: string }
    const configPath = `/etc/supervisor/conf.d/${site.domain}-worker.conf`

    // supervisord refuses to (re)read a config whose stdout_logfile directory
    // doesn't exist yet (CANT_REREAD). Sites provisioned before shared/logs
    // was added to provision.sh won't have it — create it defensively here.
    await ensureSharedLogsDir(site.rootPath)

    await fs.writeFile(configPath, content, 'utf-8')

    try {
      const { stdout, stderr } = await exec('supervisorctl reread && supervisorctl update 2>&1')
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

    const group = `${site.domain}-worker`
    try {
      // supervisorctl returns non-zero when processes are not RUNNING — capture both cases
      const result = await exec(`supervisorctl status "${group}:" 2>&1`).catch((e: unknown) => ({
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
      const configExists = await fs.access(configPath).catch(() => null)
      if (configExists === null) {
        await ensureSharedLogsDir(site.rootPath)
        await fs.writeFile(configPath, supervisorTemplate(site), 'utf-8')
        await exec('supervisorctl reread && supervisorctl update 2>&1').catch(() => {})
      }
    }

    try {
      const result = await exec(`supervisorctl ${action} "${group}:" 2>&1`)
      output = (result.stdout + result.stderr).trim()
      ok = true
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      output = (e.stdout ?? e.stderr ?? e.message ?? '').trim()
    }

    // If control command failed with "no such group", try writing config and retrying
    if (!ok && output.includes('no such group')) {
      const configExists = await fs.access(configPath).catch(() => null)
      if (configExists === null) {
        await ensureSharedLogsDir(site.rootPath)
        await fs.writeFile(configPath, supervisorTemplate(site), 'utf-8')
        await exec('supervisorctl reread && supervisorctl update 2>&1').catch(() => {})
        try {
          const result = await exec(`supervisorctl ${action} "${group}:" 2>&1`)
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
    const statusResult = await exec(`supervisorctl status "${group}:" 2>&1`).catch((e: unknown) => ({
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

    const cronPath = cronFilePath(site.domain)
    const expected = cronLine(site.domain, site.phpVersion, site.rootPath)
    try {
      const content = await fs.readFile(cronPath, 'utf-8')
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

    const cronPath = cronFilePath(site.domain)
    const content = cronLine(site.domain, site.phpVersion, site.rootPath)
    await fs.writeFile(cronPath, content + '\n', 'utf-8')
    // cron.d files must be owned by root and not world-writable
    await exec(`chmod 644 "${cronPath}"`).catch(() => {})
    return { ok: true, path: cronPath }
  })

  // Disable scheduler
  app.delete('/:id/cron', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const cronPath = cronFilePath(site.domain)
    try { await fs.unlink(cronPath) } catch { /* already removed */ }
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
