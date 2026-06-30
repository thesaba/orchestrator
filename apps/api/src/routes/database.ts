import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import { createReadStream } from 'fs'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const exec = promisify(execCb)

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function backupCronPath(domain: string): string {
  return `/etc/cron.d/${domain.replace(/\./g, '-')}-backup`
}

function backupCronContent(domain: string, rootPath: string, hour: number, minute = 0, days = '*'): string {
  const script = path.join(scriptsDir(), 'backup.sh')
  return `# Orchestrator automated backup — ${domain}
# Managed by Orchestrator — do not edit manually
${minute} ${hour} * * ${days} www-data bash "${script}" "${rootPath}" >> /var/log/orchestrator/backup.log 2>&1\n`
}

// Allow only safe filenames for download/delete
const SAFE_FILENAME = /^[\w\-]+\.sql\.gz$/

export const databaseRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── List backups ──────────────────────────────────────────────────────────

  app.get('/:id/database/backups', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const backupsDir = path.join(site.rootPath, 'backups')
    try {
      const entries = await fs.readdir(backupsDir)
      const backups = await Promise.all(
        entries
          .filter((f) => f.endsWith('.sql.gz'))
          .map(async (name) => {
            const stat = await fs.stat(path.join(backupsDir, name))
            return { name, sizeBytes: stat.size, createdAt: stat.birthtime.toISOString() }
          })
      )
      backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return { backups }
    } catch {
      return { backups: [] }
    }
  })

  // ── Create backup ─────────────────────────────────────────────────────────

  app.post('/:id/database/backup', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const creds = await readEnvCreds(site.rootPath)
    if (!creds) {
      return reply.code(400).send({
        error: 'Cannot read database credentials.',
        details: `No shared/.env found at ${site.rootPath}/shared/.env — configure it in the Config tab first.`
      })
    }
    if (!creds.db) {
      return reply.code(400).send({ error: 'DB_DATABASE is not set in .env' })
    }

    const backupsDir = path.join(site.rootPath, 'backups')
    await fs.mkdir(backupsDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${creds.db}_${timestamp}.sql.gz`
    const filePath = path.join(backupsDir, filename)

    // MYSQL_PWD is read by mysqldump automatically — avoids password in process list
    const userFlag = creds.user ? `-u "${creds.user}"` : ''
    try {
      await exec(
        `mysqldump ${userFlag} "${creds.db}" | gzip > "${filePath}"`,
        {
          env: {
            ...process.env,
            ...(creds.pass ? { MYSQL_PWD: creds.pass } : {})
          },
          shell: '/bin/bash'
        }
      )
    } catch (err: unknown) {
      // Clean up empty file if mysqldump failed
      await fs.unlink(filePath).catch(() => {})
      const msg = err as { stderr?: string; message?: string }
      return reply.code(500).send({
        error: 'mysqldump failed',
        details: msg.stderr ?? msg.message ?? ''
      })
    }

    const stat = await fs.stat(filePath)
    return {
      ok: true,
      filename,
      sizeBytes: stat.size,
      sizeHuman: formatBytes(stat.size),
      createdAt: stat.birthtime.toISOString()
    }
  })

  // ── Download backup ───────────────────────────────────────────────────────

  app.get('/:id/database/backups/:filename', async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string }
    if (!SAFE_FILENAME.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const filePath = path.join(site.rootPath, 'backups', filename)
    try {
      await fs.access(filePath)
    } catch {
      return reply.code(404).send({ error: 'Backup file not found' })
    }

    const stat = await fs.stat(filePath)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Content-Type', 'application/gzip')
    reply.header('Content-Length', stat.size)
    return reply.send(createReadStream(filePath))
  })

  // ── Backup schedule ───────────────────────────────────────────────────────

  app.get('/:id/database/backup-schedule', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const cronPath = backupCronPath(site.domain)
    try {
      const content = await fs.readFile(cronPath, 'utf-8')
      // Match: minute hour * * days
      const match = content.match(/^(\d+) (\d+) \* \* ([^\s]+)/m)
      const minute = match ? Number(match[1]) : 0
      const hour   = match ? Number(match[2]) : 2
      const days   = match ? match[3] : '*'
      return { active: true, hour, minute, days, cronPath }
    } catch {
      return { active: false, hour: 2, minute: 0, days: '*', cronPath }
    }
  })

  app.put('/:id/database/backup-schedule', {
    schema: {
      body: {
        type: 'object',
        required: ['hour'],
        properties: {
          hour:   { type: 'integer', minimum: 0, maximum: 23 },
          minute: { type: 'integer', minimum: 0, maximum: 59 },
          days:   { type: 'string', pattern: '^[0-7,\\-\\*]+$' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { hour, minute = 0, days = '*' } = request.body as { hour: number; minute?: number; days?: string }
    const cronPath = backupCronPath(site.domain)

    await fs.mkdir('/var/log/orchestrator', { recursive: true }).catch(() => {})
    await fs.writeFile(cronPath, backupCronContent(site.domain, site.rootPath, hour, minute, days), 'utf-8')
    await exec(`chmod 644 "${cronPath}"`).catch(() => {})

    app.audit('backup.schedule_enabled', { siteId: site.id, req: request, meta: { domain: site.domain, hour, minute, days } })
    return { ok: true, cronPath, hour, minute, days }
  })

  app.delete('/:id/database/backup-schedule', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const cronPath = backupCronPath(site.domain)
    try { await fs.unlink(cronPath) } catch { /* already removed */ }

    app.audit('backup.schedule_disabled', { siteId: site.id, meta: { domain: site.domain } })
    return { ok: true }
  })

  // ── Delete backup ─────────────────────────────────────────────────────────

  app.delete('/:id/database/backups/:filename', async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string }
    if (!SAFE_FILENAME.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const filePath = path.join(site.rootPath, 'backups', filename)
    try {
      await fs.unlink(filePath)
    } catch {
      return reply.code(404).send({ error: 'Backup file not found' })
    }

    return { ok: true }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function readEnvCreds(
  rootPath: string
): Promise<{ user: string; pass: string; db: string } | null> {
  try {
    const content = await fs.readFile(path.join(rootPath, 'shared', '.env'), 'utf-8')
    const get = (key: string) => {
      const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'))
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    return { user: get('DB_USERNAME'), pass: get('DB_PASSWORD'), db: get('DB_DATABASE') }
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
