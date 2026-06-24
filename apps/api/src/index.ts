import './types'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
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

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
})

// Frontend's request() helper always sets Content-Type: application/json,
// even for POSTs that send no body (e.g. deploy.trigger, ssl.issue, database.createBackup).
// Fastify's default JSON parser rejects an empty body in that case with
// FST_ERR_CTP_EMPTY_JSON_BODY. Treat an empty body as `{}` instead of erroring.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const str = body as string
  if (!str || str.trim().length === 0) {
    done(null, {})
    return
  }
  try {
    done(null, JSON.parse(str))
  } catch (err) {
    done(err as Error, undefined)
  }
})

async function start() {
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000' })
  // global: false — rate limiting is opt-in per route via config.rateLimit
  await app.register(rateLimit, { global: false })
  await app.register(prismaPlugin)
  await app.register(jwtPlugin)
  await app.register(auditPlugin)

  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(sitesRoutes, { prefix: '/api/sites' })
  await app.register(provisionRoutes, { prefix: '/api/sites' })
  await app.register(deployRoutes, { prefix: '/api/sites' })
  await app.register(webhookRoutes, { prefix: '/api/webhooks' })
  await app.register(monitorRoutes, { prefix: '/api/monitor' })
  await app.register(configRoutes, { prefix: '/api/sites' })
  await app.register(databaseRoutes, { prefix: '/api/sites' })
  await app.register(artisanRoutes, { prefix: '/api/sites' })
  await app.register(settingsRoutes, { prefix: '/api/settings' })
  await app.register(supervisorRoutes, { prefix: '/api/sites' })
  await app.register(auditRoutes, { prefix: '/api/audit' })
  await app.register(sslRoutes, { prefix: '/api/sites' })

  app.get('/api/health', async () => ({ status: 'ok', ts: new Date() }))

  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '127.0.0.1' })
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
