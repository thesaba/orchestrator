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

    // The phpMyAdmin bridge calls this endpoint DIRECTLY over loopback
    // (127.0.0.1:PORT), never through nginx. Check the real TCP peer address —
    // request.socket.remoteAddress is the immediate connection and cannot be
    // spoofed by any X-Forwarded-For header. (nginx is also configured to
    // return 404 for /api/internal/, and request.ip likewise excludes proxied
    // clients now that trustProxy='loopback' is set — three independent layers
    // on top of the shared-secret check below.)
    const isLoopback = (addr: string | undefined) =>
      addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    if (!isLoopback(request.socket.remoteAddress) || !isLoopback(request.ip)) {
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
