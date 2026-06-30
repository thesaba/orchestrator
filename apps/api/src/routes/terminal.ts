import { FastifyPluginAsync } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import * as nodePty from 'node-pty'

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  // WebSocket: GET /terminal/:siteId?token=JWT
  // @fastify/websocket v8: handler = (connection, request)
  // connection.socket is the raw WebSocket
  app.get('/terminal/:siteId', { websocket: true }, async (connection: any, request: any) => {
    const ws = connection.socket

    // Authenticate via query param (browser WS API can't set custom headers)
    const token = (request.query as { token?: string }).token
    if (!token) {
      ws.send(JSON.stringify({ error: 'Unauthorized' }))
      ws.close()
      return
    }

    let payload: { userId?: number; role?: string }
    try {
      payload = app.jwt.verify(token)
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid token' }))
      ws.close()
      return
    }

    const siteId = Number((request.params as { siteId: string }).siteId)
    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) {
      ws.send(JSON.stringify({ error: 'Site not found' }))
      ws.close()
      return
    }

    // Manual JWT verify above doesn't run through the normal preHandler
    // chain, so requireSiteAccess() never sees this request — enforce the
    // same per-site authorization here. A full host shell is the highest-
    // privilege surface in the panel; it must never be reachable for a
    // site the caller wasn't explicitly (or blanket-) granted.
    const role = payload.role ?? 'admin'
    if (role !== 'admin' && payload.userId) {
      const dbUser = await app.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { allSitesAccess: true }
      })
      if (!dbUser?.allSitesAccess) {
        const access = await app.prisma.siteUser.findUnique({
          where: { userId_siteId: { userId: payload.userId, siteId } }
        })
        if (!access) {
          ws.send(JSON.stringify({ error: 'Forbidden: no access to this site' }))
          ws.close()
          return
        }
      }
      if (role === 'viewer') {
        ws.send(JSON.stringify({ error: 'Forbidden: viewer role cannot use the terminal' }))
        ws.close()
        return
      }
    }

    // This grants a real shell on the host (not sandboxed to the site), so it's
    // logged like any other privileged action — connect AND disconnect.
    app.audit('terminal.connect', { siteId, userId: payload.userId ?? null, meta: { domain: site.domain } })

    const cwd = `${site.rootPath}/current`

    const pty = nodePty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: { ...(process.env as Record<string, string>), TERM: 'xterm-256color' }
    })

    pty.onData((data: string) => {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: 'output', data }))
      }
    })

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'exit', exitCode }))
        ws.close()
      }
    })

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'input')  pty.write(msg.data)
        if (msg.type === 'resize') pty.resize(msg.cols, msg.rows)
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => {
      app.audit('terminal.disconnect', { siteId, userId: payload.userId ?? null, meta: { domain: site.domain } })
      try { pty.kill() } catch { /* already dead */ }
    })
  })
}
