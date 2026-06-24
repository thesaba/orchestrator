import './types'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { prismaPlugin } from './plugins/prisma'
import { jwtPlugin } from './plugins/auth'
import { auditPlugin } from './plugins/audit'
import { authRoutes } from './routes/auth'
import { sitesRoutes } from './routes/sites'
import { provisionRoutes } from './routes/provision'
import { deployRoutes } from './routes/deploy'
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
import { startUptimeMonitor } from './lib/uptime-monitor'

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
})

async function start() {
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' })
  await app.register(rateLimit, { global: false })
  await app.register(websocket)
  await app.register(prismaPlugin)
  await app.register(jwtPlugin)
  await app.register(auditPlugin)

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
  // authenticated panel user. Off by default — opt in explicitly via
  // ENABLE_TERMINAL=true once you've reviewed the security notes in
  // DEPLOY_GUIDE.md (token-in-query-string, full process env inheritance).
  if (process.env.ENABLE_TERMINAL === 'true') {
    await app.register(terminalRoutes,  { prefix: '/api' })
    app.log.warn('Web terminal route is ENABLED (ENABLE_TERMINAL=true) — this grants shell access to any authenticated user.')
  }

  await app.register(composerRoutes,    { prefix: '/api/sites' })
  await app.register(failedJobsRoutes,  { prefix: '/api/sites' })
  await app.register(phpFpmRoutes,      { prefix: '/api/sites' })
  await app.register(s3BackupRoutes,    { prefix: '/api/sites' })

  app.get('/api/health', async () => ({ status: 'ok', ts: new Date() }))

  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '127.0.0.1' })

  // Start uptime monitor after server is listening
  startUptimeMonitor(app.prisma)
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
