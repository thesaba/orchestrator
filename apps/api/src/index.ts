import './types'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import multipart from '@fastify/multipart'
import { prismaPlugin } from './plugins/prisma'
import { jwtPlugin } from './plugins/auth'
import { auditPlugin } from './plugins/audit'
import { rbacPlugin } from './plugins/rbac'
import { usersRoutes } from './routes/users'
import { dbManageRoutes } from './routes/db-manage'
import { authRoutes } from './routes/auth'
import { sitesRoutes } from './routes/sites'
import { provisionRoutes } from './routes/provision'
import { deployRoutes, reconcileOrphanedDeployments, killAllRunningDeploys } from './routes/deploy'
import { webhookRoutes } from './routes/webhooks'
import { monitorRoutes } from './routes/monitor'
import { configRoutes } from './routes/config'
import { databaseRoutes } from './routes/database'
import { artisanRoutes } from './routes/artisan'
import { settingsRoutes } from './routes/settings'
import { supervisorRoutes } from './routes/supervisor'
import { auditRoutes } from './routes/audit'
import { sslRoutes } from './routes/ssl'
import { maintenanceRoutes } from './routes/maintenance'
import { schedulerRoutes } from './routes/scheduler'
import { uptimeRoutes } from './routes/uptime'
import { terminalRoutes } from './routes/terminal'
import { composerRoutes } from './routes/composer'
import { failedJobsRoutes } from './routes/failed-jobs'
import { phpFpmRoutes } from './routes/phpfpm'
import { s3BackupRoutes } from './routes/s3backup'
import { logsRoutes } from './routes/logs'
import { fileManagerRoutes } from './routes/filemanager'
import { pmaInternalRoutes } from './routes/pma-internal'
import { tasksRoutes } from './routes/tasks'
import { notesRoutes } from './routes/notes'
import { calendarRoutes } from './routes/calendar'
import { directoryRoutes } from './routes/directory'
import { serverRoutes } from './routes/server'
import { dashboardRoutes } from './routes/dashboard'
import { systemRoutes } from './routes/system'
import { startUptimeMonitor } from './lib/uptime-monitor'
import { startSslMonitor } from './lib/ssl-monitor'
import { startMetricsMonitor } from './lib/metrics-monitor'

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  },
  // The API listens on 127.0.0.1 only and is always reached through the local
  // nginx reverse proxy. Trusting the loopback hop makes request.ip resolve to
  // the real client IP (from X-Forwarded-For added by nginx) instead of
  // 127.0.0.1 — essential for correct rate-limiting, audit logging, and the
  // loopback checks in pma-internal. Only the loopback proxy is trusted, so a
  // client-supplied X-Forwarded-For header cannot spoof the address.
  trustProxy: 'loopback'
})

async function start() {
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' })
  // Global backstop rate limit (per client IP) against brute-force and abuse.
  // Individual sensitive routes set stricter overrides (e.g. login: 10/15min).
  // The limit is generous so a normal dashboard's polling is never throttled.
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: '1 minute'
  })
  await app.register(websocket)
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } }) // 512 MB — matches nginx client_max_body_size
  await app.register(prismaPlugin)
  await app.register(jwtPlugin)
  await app.register(auditPlugin)
  await app.register(rbacPlugin)

  await app.register(authRoutes,        { prefix: '/api/auth' })
  await app.register(sitesRoutes,       { prefix: '/api/sites' })
  await app.register(provisionRoutes,   { prefix: '/api/sites' })
  await app.register(deployRoutes,      { prefix: '/api/sites' })
  await app.register(webhookRoutes,     { prefix: '/api/webhooks' })
  await app.register(monitorRoutes,     { prefix: '/api/monitor' })
  await app.register(configRoutes,      { prefix: '/api/sites' })
  await app.register(databaseRoutes,    { prefix: '/api/sites' })
  await app.register(artisanRoutes,     { prefix: '/api/sites' })
  await app.register(settingsRoutes,    { prefix: '/api/settings' })
  await app.register(supervisorRoutes,  { prefix: '/api/sites' })
  await app.register(auditRoutes,       { prefix: '/api/audit' })
  await app.register(sslRoutes,         { prefix: '/api/sites' })
  await app.register(maintenanceRoutes, { prefix: '/api/sites' })
  await app.register(schedulerRoutes,   { prefix: '/api/sites' })
  await app.register(uptimeRoutes,      { prefix: '/api' })

  // Web terminal grants a real, unsandboxed shell on the host to any
  // authenticated panel user. Secured by JWT auth.
  // DEPLOY_GUIDE.md (token-in-query-string, full process env inheritance).
  await app.register(terminalRoutes,  { prefix: '/api' })
  app.log.warn('Web terminal route is ENABLED — this grants shell access to any authenticated user.')

  await app.register(composerRoutes,    { prefix: '/api/sites' })
  await app.register(failedJobsRoutes,  { prefix: '/api/sites' })
  await app.register(phpFpmRoutes,      { prefix: '/api/sites' })
  await app.register(s3BackupRoutes,    { prefix: '/api/sites' })
  await app.register(logsRoutes,        { prefix: '/api/sites' })
  await app.register(fileManagerRoutes, { prefix: '/api/sites' })
  await app.register(dbManageRoutes,    { prefix: '/api/sites' })
  await app.register(usersRoutes,       { prefix: '/api/users' })

  await app.register(tasksRoutes,       { prefix: '/api/tasks' })
  await app.register(notesRoutes,       { prefix: '/api/notes' })
  await app.register(calendarRoutes,    { prefix: '/api/calendar' })
  await app.register(directoryRoutes,   { prefix: '/api/directory' })
  await app.register(serverRoutes,      { prefix: '/api/server' })
  await app.register(dashboardRoutes,   { prefix: '/api/dashboard' })
  await app.register(systemRoutes,      { prefix: '/api/system' })

  // Loopback-only, shared-secret-protected — used by the phpMyAdmin signon
  // bridge to redeem a one-time token for real DB credentials. See
  // routes/pma-internal.ts for why this doesn't use app.authenticate.
  await app.register(pmaInternalRoutes, { prefix: '/api/internal' })

  app.get('/api/health', async () => ({ status: 'ok', ts: new Date() }))

  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '127.0.0.1' })

  // Any Deployment left 'running' is orphaned from a previous process
  // lifetime (in-memory deploy state doesn't survive a restart) — mark them
  // failed instead of leaving them stuck forever, and unblock anything
  // queued behind them.
  await reconcileOrphanedDeployments(app)

  // Start background monitors after the server is listening
  startUptimeMonitor(app.prisma)
  startSslMonitor(app)
  startMetricsMonitor(app.prisma)

  // Graceful shutdown: kill any in-flight deploys before exiting. Deploy
  // child processes are spawned `detached: true` so they survive this
  // process dying — without this, a `systemctl restart` (or any SIGTERM)
  // issued while a deploy is running leaves it as an untracked "ghost"
  // process that keeps building/migrating/swapping in the background even
  // after the next startup's reconcileOrphanedDeployments() has already
  // marked its row 'failed'. That desync (panel says failed, site actually
  // got redeployed) is exactly what we want to avoid — so kill it here
  // instead of letting it run loose.
  const shutdown = async (signal: string) => {
    app.log.warn(`Received ${signal} — shutting down. Killing any in-flight deploys first.`)
    killAllRunningDeploys(app)
    await app.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
