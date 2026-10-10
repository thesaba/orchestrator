import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import path from 'path'
import mysql from 'mysql2/promise'
import { serverCtxForSite } from '../lib/servers'
import { isLocal } from '../lib/server-exec'

// Laravel-aware APM. Read-only: surfaces slow queries, slow requests and recent
// exceptions from the site's own Laravel Telescope data (telescope_entries).
// Connects with the SITE'S OWN db credentials (least privilege — that user can
// only see its own schema) and runs SELECT-only queries. Never writes anything.

async function readEnvCreds(rootPath: string): Promise<{ user: string; pass: string; db: string } | null> {
  try {
    const content = await fs.readFile(path.join(rootPath, 'shared', '.env'), 'utf-8')
    const get = (k: string) => {
      const m = content.match(new RegExp(`^${k}=(.*)$`, 'm'))
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    return { user: get('DB_USERNAME'), pass: get('DB_PASSWORD'), db: get('DB_DATABASE') }
  } catch {
    return null
  }
}

export const apmRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  app.get('/:id/apm', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    // Remote sites keep their DB on the remote host (not reachable from the
    // panel over TCP); APM over the site DB is local-only for now.
    const ctx = await serverCtxForSite(app.prisma, site)
    if (!isLocal(ctx)) {
      return { installed: false, supported: false, message: 'Laravel APM currently supports sites on the local server.' }
    }

    const creds = await readEnvCreds(site.rootPath)
    if (!creds?.db) {
      return { installed: false, supported: true, message: 'Could not read database credentials from shared/.env.' }
    }

    let conn: mysql.Connection | null = null
    try {
      conn = await mysql.createConnection({
        host: '127.0.0.1',
        user: creds.user,
        password: creds.pass,
        database: creds.db,
        multipleStatements: false,
        connectTimeout: 10_000
      })

      // Is Telescope installed on this site?
      const [tbl] = await conn.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = 'telescope_entries' LIMIT 1",
        [creds.db]
      )
      if (!Array.isArray(tbl) || (tbl as unknown[]).length === 0) {
        return {
          installed: false,
          supported: true,
          message: 'Laravel Telescope is not installed on this site. Install it (composer require laravel/telescope) to enable APM.'
        }
      }

      const since = 'created_at >= (NOW() - INTERVAL 1 DAY)'

      const [slowQueries] = await conn.execute(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(content,'$.sql')) AS query,
                CAST(JSON_EXTRACT(content,'$.time') AS DECIMAL(12,2)) AS ms,
                created_at AS at
         FROM telescope_entries
         WHERE type='query' AND ${since}
         ORDER BY ms DESC LIMIT 15`
      )
      const [slowRequests] = await conn.execute(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(content,'$.uri')) AS uri,
                JSON_UNQUOTE(JSON_EXTRACT(content,'$.method')) AS method,
                JSON_UNQUOTE(JSON_EXTRACT(content,'$.response_status')) AS status,
                CAST(JSON_EXTRACT(content,'$.duration') AS DECIMAL(12,2)) AS ms,
                created_at AS at
         FROM telescope_entries
         WHERE type='request' AND ${since}
         ORDER BY ms DESC LIMIT 15`
      )
      const [exceptions] = await conn.execute(
        `SELECT JSON_UNQUOTE(JSON_EXTRACT(content,'$.class')) AS class,
                JSON_UNQUOTE(JSON_EXTRACT(content,'$.message')) AS message,
                created_at AS at
         FROM telescope_entries
         WHERE type='exception' AND ${since}
         ORDER BY created_at DESC LIMIT 15`
      )
      const [countsRows] = await conn.execute(
        `SELECT
            SUM(type='query') AS queries,
            SUM(type='query' AND CAST(JSON_EXTRACT(content,'$.time') AS DECIMAL(12,2)) > 100) AS slowQueries,
            SUM(type='request') AS requests,
            SUM(type='exception') AS exceptions
         FROM telescope_entries WHERE ${since}`
      )
      const counts = (Array.isArray(countsRows) ? countsRows[0] : {}) as Record<string, unknown>

      return {
        installed: true,
        windowHours: 24,
        counts: {
          queries: Number(counts?.queries ?? 0),
          slowQueries: Number(counts?.slowQueries ?? 0),
          requests: Number(counts?.requests ?? 0),
          exceptions: Number(counts?.exceptions ?? 0)
        },
        slowQueries,
        slowRequests,
        exceptions
      }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    } finally {
      if (conn) await conn.end().catch(() => {})
    }
  })
}
