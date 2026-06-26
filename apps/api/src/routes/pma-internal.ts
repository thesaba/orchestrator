import { FastifyPluginAsync } from 'fastify'
import { timingSafeEqual } from 'crypto'
import { consumePmaToken } from '../lib/pma-tokens'

// Not behind app.authenticate — this is called by the phpMyAdmin signon
// bridge (a PHP process on the same host), not by the browser or the panel
// frontend. It is protected by two independent things instead:
//   1. The caller must be on loopback (127.0.0.1/::1) — Node listens on
//      127.0.0.1 only, so this already excludes anything that didn't reach
//      us via a server-side call on the same box.
//   2. A shared secret header that must match PMA_BRIDGE_SECRET, configured
//      both here and in the phpMyAdmin signon.php script.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export const pmaInternalRoutes: FastifyPluginAsync = async (app) => {
  app.post('/pma-consume', async (request, reply) => {
    const secret = process.env.PMA_BRIDGE_SECRET
    if (!secret) {
      return reply.code(503).send({ error: 'PMA_BRIDGE_SECRET is not configured.' })
    }

    const ip = request.ip
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const provided = request.headers['x-pma-bridge-secret']
    if (typeof provided !== 'string' || !safeEqual(provided, secret)) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const { token } = request.body as { token?: string }
    if (!token || typeof token !== 'string') {
      return reply.code(400).send({ error: 'Missing token' })
    }

    const creds = consumePmaToken(token)
    if (!creds) {
      return reply.code(404).send({ error: 'Invalid or expired token' })
    }

    return creds
  })
}
