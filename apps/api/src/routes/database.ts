import { FastifyPluginAsync } from 'fastify'
import { promises as fs, createReadStream } from 'fs'
import { spawn } from 'child_process'
import zlib from 'zlib'
import path from 'path'
import { execOn, spawnOn, isLocal, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import { ensureScriptsSynced } from '../lib/server-sync'
import { readFileOn, writeFileOn, mkdirOn, unlinkOn, statOn, readdirOn } from '../lib/server-fs'
import { shellEscape } from '../lib/ssh'

/**
 * Restore a LOCAL .sql / .sql.gz dump into a database by streaming it into
 * `mysql`'s stdin (argv, no shell + zlib). Only used for local sites — remote
 * sites restore in-place on their own host over SSH.
 */
function restoreDumpLocal(
  filePath: string,
  isGzip: boolean,
  creds: { user: string; pass: string; db: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-h', '127.0.0.1', ...(creds.user ? ['-u', creds.user] : []), creds.db]
    const proc = spawn('mysql', args, {
      env: { ...process.env, ...(creds.pass ? { MYSQL_PWD: creds.pass } : {}) }
    })
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(Object.assign(new Error(stderr || `mysql exited with code ${code}`), { stderr }))
    })
    const src = createReadStream(filePath)
    src.on('error', reject)
    if (isGzip) {
      const gunzip = zlib.createGunzip()
      gunzip.on('error', reject)
      src.pipe(gunzip).pipe(proc.stdin)
    } else {
      src.pipe(proc.stdin)
    }
  })
}

function backupCronPath(domain: string): string {
  return `/etc/cron.d/${domain.replace(/\./g, '-')}-backup`
}

function backupCronContent(scriptsDir: string, domain: string, rootPath: string, hour: number, minute = 0, days = '*'): string {
  const script = `${scriptsDir}/backup.sh`
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

    const ctx = await serverCtxForSite(app.prisma, site)
    const backupsDir = path.join(site.rootPath, 'backups')
    try {
      const names = (await readdirOn(ctx, backupsDir)).filter((f) => f.endsWith('.sql.gz'))
      const backups = (await Promise.all(names.map(async (name) => {
        const st = await statOn(ctx, path.join(backupsDir, name))
        if (!st) return null
        return { name, sizeBytes: st.size, createdAt: new Date(st.mtimeMs).toISOString() }
      }))).filter(Boolean) as { name: string; sizeBytes: number; createdAt: string }[]
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

    const ctx = await serverCtxForSite(app.prisma, site)
    const creds = await readEnvCreds(ctx, site.rootPath)
    if (!creds) {
      return reply.code(400).send({
        error: 'Cannot read database credentials.',
        details: `No shared/.env found at ${site.rootPath}/shared/.env — configure it in the Config tab first.`
      })
    }
    if (!creds.db) return reply.code(400).send({ error: 'DB_DATABASE is not set in .env' })

    const backupsDir = path.join(site.rootPath, 'backups')
    await mkdirOn(ctx, backupsDir)

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${creds.db}_${timestamp}.sql.gz`
    const filePath = path.join(backupsDir, filename)

    // MYSQL_PWD is read by mysqldump automatically — avoids the password in argv.
    const userFlag = creds.user ? `-u "${creds.user}"` : ''
    try {
      await execOn(ctx, 'bash', ['-lc', `mysqldump ${userFlag} "${creds.db}" | gzip > "${filePath}"`],
        { env: creds.pass ? { MYSQL_PWD: creds.pass } : undefined } as any)
    } catch (err: unknown) {
      await unlinkOn(ctx, filePath)
      const msg = err as { stderr?: string; message?: string }
      return reply.code(500).send({ error: 'mysqldump failed', details: msg.stderr ?? msg.message ?? '' })
    }

    const st = await statOn(ctx, filePath)
    return {
      ok: true, filename,
      sizeBytes: st?.size ?? 0,
      sizeHuman: formatBytes(st?.size ?? 0),
      createdAt: new Date(st?.mtimeMs ?? Date.now()).toISOString()
    }
  })

  // ── Download backup ───────────────────────────────────────────────────────

  app.get('/:id/database/backups/:filename', async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string }
    if (!SAFE_FILENAME.test(filename)) return reply.code(400).send({ error: 'Invalid filename' })

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const filePath = path.join(site.rootPath, 'backups', filename)
    const st = await statOn(ctx, filePath)
    if (!st?.isFile) return reply.code(404).send({ error: 'Backup file not found' })

    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Content-Type', 'application/gzip')
    if (isLocal(ctx)) {
      reply.header('Content-Length', st.size)
      return reply.send(createReadStream(filePath))
    }
    // Remote: stream the file over SSH (`cat`).
    const child = await spawnOn(ctx, 'cat', [filePath])
    return reply.send(child.stdout)
  })

  // ── Restore backup (destructive) ────────────────────────────────────────────

  app.post('/:id/database/backups/:filename/restore', async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string }
    if (!SAFE_FILENAME.test(filename)) return reply.code(400).send({ error: 'Invalid filename' })

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const creds = await readEnvCreds(ctx, site.rootPath)
    if (!creds?.db) return reply.code(400).send({ error: 'Cannot read database credentials from shared/.env.' })

    const filePath = path.join(site.rootPath, 'backups', filename)
    const st = await statOn(ctx, filePath)
    if (!st?.isFile) return reply.code(404).send({ error: 'Backup file not found' })

    try {
      if (isLocal(ctx)) {
        await restoreDumpLocal(filePath, filename.endsWith('.gz'), creds)
      } else {
        // Remote: the dump already lives on the site's host — replay it there.
        const cat = filename.endsWith('.gz') ? 'zcat' : 'cat'
        const userFlag = creds.user ? `-u "${creds.user}"` : ''
        await execOn(ctx, 'bash', ['-lc', `${cat} "${filePath}" | mysql -h 127.0.0.1 ${userFlag} "${creds.db}"`],
          { env: creds.pass ? { MYSQL_PWD: creds.pass } : undefined } as any)
      }
      app.audit('database.restored', { siteId: site.id, req: request, meta: { domain: site.domain, filename } })
      return { ok: true, filename }
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string }
      return reply.code(500).send({ error: 'Restore failed', details: (e.stderr ?? e.message ?? '').slice(0, 2000) })
    }
  })

  // ── Backup schedule ───────────────────────────────────────────────────────

  app.get('/:id/database/backup-schedule', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const cronPath = backupCronPath(site.domain)
    try {
      const content = await readFileOn(ctx, cronPath)
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

    const ctx = await serverCtxForSite(app.prisma, site)
    const synced = await ensureScriptsSynced(app.prisma, (site as any).serverId ?? null)
    const { hour, minute = 0, days = '*' } = request.body as { hour: number; minute?: number; days?: string }
    const cronPath = backupCronPath(site.domain)

    await mkdirOn(ctx, '/var/log/orchestrator').catch(() => {})
    await writeFileOn(ctx, cronPath, backupCronContent(synced.scriptsDir, site.domain, site.rootPath, hour, minute, days))
    await execOn(ctx, 'bash', ['-lc', `chmod 644 "${cronPath}"`]).catch(() => {})

    app.audit('backup.schedule_enabled', { siteId: site.id, req: request, meta: { domain: site.domain, hour, minute, days } })
    return { ok: true, cronPath, hour, minute, days }
  })

  app.delete('/:id/database/backup-schedule', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    await unlinkOn(ctx, backupCronPath(site.domain))
    app.audit('backup.schedule_disabled', { siteId: site.id, meta: { domain: site.domain } })
    return { ok: true }
  })

  // ── Delete backup ─────────────────────────────────────────────────────────

  app.delete('/:id/database/backups/:filename', async (request, reply) => {
    const { id, filename } = request.params as { id: string; filename: string }
    if (!SAFE_FILENAME.test(filename)) return reply.code(400).send({ error: 'Invalid filename' })

    const site = await app.prisma.site.findUnique({ where: { id: Number(id) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const filePath = path.join(site.rootPath, 'backups', filename)
    const st = await statOn(ctx, filePath)
    if (!st?.isFile) return reply.code(404).send({ error: 'Backup file not found' })
    await unlinkOn(ctx, filePath)
    return { ok: true }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function readEnvCreds(
  ctx: ServerCtx, rootPath: string
): Promise<{ user: string; pass: string; db: string } | null> {
  try {
    const content = await readFileOn(ctx, path.join(rootPath, 'shared', '.env'))
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
