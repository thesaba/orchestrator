import { FastifyPluginAsync } from 'fastify'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import mysql from 'mysql2/promise'
import { PrismaClient } from '@prisma/client'

const exec = promisify(execCb)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getMysqlRootCreds(
  prisma: PrismaClient
): Promise<{ user: string; pass: string } | null> {
  const [userRow, passRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'mysql_root_user' } }),
    prisma.setting.findUnique({ where: { key: 'mysql_root_password' } })
  ])
  if (!userRow?.value) return null
  return { user: userRow.value, pass: passRow?.value ?? '' }
}

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

// Connect as root and run multiple admin statements safely (no shell, no backtick issues)
async function withRootConn(
  creds: { user: string; pass: string },
  fn: (conn: mysql.Connection) => Promise<void>
): Promise<void> {
  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: creds.user,
    password: creds.pass,
    multipleStatements: false,
    connectTimeout: 10_000
  })
  try {
    await fn(conn)
  } finally {
    await conn.end().catch(() => {})
  }
}

// Allowlist: only permit DML + read operations, block DDL and dangerous statements
const BLOCKED_STATEMENT_RE = /^(DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE|RENAME|SET|FLUSH|LOAD|LOCK|UNLOCK|CALL|EXEC|EXECUTE|REPLACE|USE|XA|KILL|PURGE|RESET|SOURCE)\b/i
const ALLOWED_STATEMENT_RE = /^(SELECT|INSERT|UPDATE|DELETE|EXPLAIN|SHOW|DESCRIBE|DESC|WITH)\b/i

function validateSql(sql: string): { valid: true } | { valid: false; reason: string } {
  const stripped = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()

  if (!stripped) return { valid: false, reason: 'Empty query.' }

  const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean)

  for (const stmt of statements) {
    if (BLOCKED_STATEMENT_RE.test(stmt)) {
      const type = stmt.split(/\s/)[0].toUpperCase()
      return { valid: false, reason: `${type} statements are not permitted. Only SELECT, INSERT, UPDATE, DELETE, EXPLAIN, SHOW, DESCRIBE are allowed.` }
    }
    if (!ALLOWED_STATEMENT_RE.test(stmt)) {
      return { valid: false, reason: `Unrecognized or disallowed statement type.` }
    }
  }

  return { valid: true }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export const dbManageRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // GET /api/sites/:id/databases — list all databases for this site
  app.get('/:id/databases', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const databases = await app.prisma.siteDatabase.findMany({
      where: { siteId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }]
    })
    return { databases }
  })

  // POST /api/sites/:id/databases — create a new database
  app.post('/:id/databases', {
    preHandler: [app.requireRole(['admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['dbName', 'dbUser'],
        properties: {
          dbName: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-zA-Z0-9_]+$' },
          dbUser: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-zA-Z0-9_]+$' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { dbName, dbUser } = request.body as { dbName: string; dbUser: string }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const rootCreds = await getMysqlRootCreds(app.prisma)
    if (!rootCreds) {
      return reply.code(400).send({
        error: 'MySQL root credentials not configured.',
        details: 'Set mysql_root_user and mysql_root_password in Settings first.'
      })
    }

    const existing = await app.prisma.siteDatabase.findUnique({ where: { dbName } })
    if (existing) return reply.code(409).send({ error: `Database "${dbName}" already exists.` })

    try {
      // Use mysql2 directly — avoids bash backtick-as-command-substitution issues
      await withRootConn(rootCreds, async (conn) => {
        await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``)
        await conn.execute(`CREATE USER IF NOT EXISTS '${dbUser}'@'localhost'`)
        await conn.execute(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'localhost'`)
        await conn.execute('FLUSH PRIVILEGES')
      })
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      return reply.code(500).send({
        error: 'Failed to create database',
        details: e.message ?? ''
      })
    }

    const db = await app.prisma.siteDatabase.create({
      data: { siteId, dbName, dbUser, isPrimary: false }
    })

    app.audit('database.created', { siteId, req: request, meta: { dbName, dbUser } })
    reply.code(201)
    return db
  })

  // DELETE /api/sites/:id/databases/:dbId — drop a database
  app.delete('/:id/databases/:dbId', {
    preHandler: [app.requireRole(['admin'])]
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string; dbId: string }).id)
    const dbId   = Number((request.params as { id: string; dbId: string }).dbId)

    const db = await app.prisma.siteDatabase.findUnique({ where: { id: dbId } })
    if (!db || db.siteId !== siteId) return reply.code(404).send({ error: 'Database not found' })
    if (db.isPrimary) return reply.code(400).send({ error: 'Cannot delete the primary database.' })

    const rootCreds = await getMysqlRootCreds(app.prisma)
    if (!rootCreds) {
      return reply.code(400).send({ error: 'MySQL root credentials not configured.' })
    }

    try {
      await withRootConn(rootCreds, async (conn) => {
        await conn.execute(`DROP DATABASE IF EXISTS \`${db.dbName}\``)
        await conn.execute(`DROP USER IF EXISTS '${db.dbUser}'@'localhost'`)
        await conn.execute('FLUSH PRIVILEGES')
      })
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      return reply.code(500).send({
        error: 'Failed to drop database',
        details: e.message ?? ''
      })
    }

    await app.prisma.siteDatabase.delete({ where: { id: dbId } })
    app.audit('database.deleted', { siteId, req: request, meta: { dbName: db.dbName } })
    return { ok: true }
  })

  // POST /api/sites/:id/databases/:dbId/query — run a SQL query
  app.post('/:id/databases/:dbId/query', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['sql'],
        properties: {
          sql: { type: 'string', minLength: 1, maxLength: 10000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string; dbId: string }).id)
    const dbId   = Number((request.params as { id: string; dbId: string }).dbId)
    const { sql } = request.body as { sql: string }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const db = await app.prisma.siteDatabase.findUnique({ where: { id: dbId } })
    if (!db || db.siteId !== siteId) return reply.code(404).send({ error: 'Database not found' })

    const validation = validateSql(sql)
    if (!validation.valid) {
      return reply.code(400).send({ error: validation.reason })
    }

    const creds = await readEnvCreds(site.rootPath)
    if (!creds) {
      return reply.code(400).send({
        error: 'Cannot read database credentials from shared/.env'
      })
    }

    let conn: mysql.Connection | null = null
    const startMs = Date.now()

    try {
      conn = await mysql.createConnection({
        host: '127.0.0.1',
        user: creds.user,
        password: creds.pass,
        database: db.dbName,
        multipleStatements: false,
        connectTimeout: 10_000
      })

      const [rows, fields] = await conn.execute({ sql, timeout: 30_000 } as mysql.QueryOptions)
      const elapsedMs = Date.now() - startMs

      const columns: string[] = (fields as mysql.FieldPacket[] | undefined)?.map((f) => f.name) ?? []
      const allRows = Array.isArray(rows) ? rows as Record<string, unknown>[] : []
      const truncated = allRows.length > 1000
      const resultRows = allRows.slice(0, 1000)

      app.audit('db.query', {
        siteId,
        req: request,
        meta: { dbName: db.dbName, sql: sql.slice(0, 200) }
      })

      return {
        columns,
        rows: resultRows.map((r) => columns.map((c) => r[c] ?? null)),
        rowCount: resultRows.length,
        truncated,
        elapsedMs
      }
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string }
      return reply.code(400).send({
        error: 'Query failed',
        details: e.message ?? 'Unknown error',
        code: e.code
      })
    } finally {
      if (conn) await conn.end().catch(() => {})
    }
  })

  // POST /api/sites/:id/databases/:dbId/import — import a .sql or .sql.gz file
  app.post('/:id/databases/:dbId/import', {
    preHandler: [app.requireRole(['admin', 'developer'])],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string; dbId: string }).id)
    const dbId   = Number((request.params as { id: string; dbId: string }).dbId)

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const db = await app.prisma.siteDatabase.findUnique({ where: { id: dbId } })
    if (!db || db.siteId !== siteId) return reply.code(404).send({ error: 'Database not found' })

    const rootCreds = await getMysqlRootCreds(app.prisma)
    if (!rootCreds) {
      return reply.code(400).send({ error: 'MySQL root credentials not configured.' })
    }

    let data: import('@fastify/multipart').MultipartFile | undefined
    try {
      data = await request.file()
    } catch {
      return reply.code(400).send({ error: 'No file uploaded.' })
    }
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' })

    const filename = data.filename ?? ''
    const isGzip = filename.endsWith('.sql.gz') || filename.endsWith('.gz')
    const isSql  = filename.endsWith('.sql')

    if (!isGzip && !isSql) {
      return reply.code(400).send({ error: 'Only .sql and .sql.gz files are supported.' })
    }

    const tmpFile = path.join(os.tmpdir(), `db-import-${Date.now()}-${Math.random().toString(36).slice(2)}${isGzip ? '.sql.gz' : '.sql'}`)

    try {
      const chunks: Buffer[] = []
      for await (const chunk of data.file) {
        chunks.push(chunk as Buffer)
      }
      await fs.writeFile(tmpFile, Buffer.concat(chunks))

      // Shell exec for piped import — dbName is a safe positional arg (no backtick issue)
      const mysqlBase = `mysql -h 127.0.0.1 -u "${rootCreds.user}" "${db.dbName}"`
      const cmd = isGzip
        ? `zcat "${tmpFile}" | ${mysqlBase}`
        : `${mysqlBase} < "${tmpFile}"`

      const { stderr } = await exec(cmd, {
        env: { ...process.env, MYSQL_PWD: rootCreds.pass },
        shell: '/bin/bash',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 300_000  // 5 min for large imports
      })

      app.audit('db.import', {
        siteId,
        req: request,
        meta: { dbName: db.dbName, filename }
      })

      return { ok: true, warnings: stderr || null }
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string }
      return reply.code(500).send({
        error: 'Import failed',
        details: e.stderr?.slice(0, 2000) ?? e.message ?? ''
      })
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }
  })
}
