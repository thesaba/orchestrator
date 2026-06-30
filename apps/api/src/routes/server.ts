import { FastifyPluginAsync, FastifyReply } from 'fastify'
import { getDoCreds, doRequest, DOError, DOCreds } from '../lib/digitalocean'

// Droplet actions that take no extra parameters beyond `type`.
const SIMPLE_ACTIONS = new Set([
  'reboot', 'power_cycle', 'power_off', 'power_on', 'shutdown',
  'enable_ipv6', 'enable_backups', 'disable_backups', 'password_reset'
])

function handleDOError(err: unknown, reply: FastifyReply) {
  if (err instanceof DOError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502
    return reply.code(status).send({ error: err.message })
  }
  return reply.code(502).send({ error: err instanceof Error ? err.message : 'DigitalOcean API request failed' })
}

// Droplet control surfaces real power/destructive operations (reboot,
// resize, snapshot delete, firewall rules) against the production server —
// same trust bar as MySQL root credentials, so the whole route group is
// admin-only rather than gating individual endpoints.
export const serverRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  async function requireCreds(reply: FastifyReply): Promise<(DOCreds & { token: string }) | null> {
    const c = await getDoCreds(app.prisma)
    if (!c.token) {
      reply.code(400).send({ error: 'DigitalOcean API token not configured. Add it in Settings → DigitalOcean.' })
      return null
    }
    return c as DOCreds & { token: string }
  }

  // ── GET /status — configuration + droplet snapshot for the page header ──
  app.get('/status', async (_request, reply) => {
    const { token, dropletId } = await getDoCreds(app.prisma)
    if (!token) return { configured: false, droplet: null, needsDropletSelection: false }
    if (!dropletId) return { configured: true, droplet: null, needsDropletSelection: true }
    try {
      const data = await doRequest<{ droplet: unknown }>(token, `/droplets/${dropletId}`)
      return { configured: true, droplet: data.droplet, needsDropletSelection: false }
    } catch (err) {
      return handleDOError(err, reply)
    }
  })

  // ── GET /droplets — list all droplets on the account, for picking the right one ──
  app.get('/droplets', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    try {
      const data = await doRequest<{ droplets: unknown[] }>(c.token, '/droplets?per_page=200')
      return data.droplets
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── GET /sizes — available sizes for the resize picker ──
  app.get('/sizes', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    try {
      const data = await doRequest<{ sizes: { available: boolean }[] }>(c.token, '/sizes?per_page=200')
      return data.sizes.filter((s) => s.available)
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── POST /actions — power actions, ipv6, backups toggle, password reset ──
  app.post('/actions', {
    schema: {
      body: {
        type: 'object',
        required: ['type'],
        properties: { type: { type: 'string' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return reply.code(400).send({ error: 'No droplet selected. Pick one in Settings first.' })
    const { type } = request.body as { type: string }
    if (!SIMPLE_ACTIONS.has(type)) return reply.code(400).send({ error: `Unsupported action: ${type}` })
    try {
      const data = await doRequest<{ action: unknown }>(c.token, `/droplets/${c.dropletId}/actions`, {
        method: 'POST', body: { type }
      })
      app.audit(`server.${type}`, { req: request, meta: { dropletId: c.dropletId } })
      return data.action
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── GET /actions — recent action history for this droplet ──
  app.get('/actions', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return []
    try {
      const data = await doRequest<{ actions: unknown[] }>(c.token, `/droplets/${c.dropletId}/actions?per_page=30`)
      return data.actions
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── GET /actions/:id — poll a single action's status (resize/snapshot take time) ──
  app.get('/actions/:id', async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    const { id } = request.params as { id: string }
    try {
      const data = await doRequest<{ action: unknown }>(c.token, `/actions/${id}`)
      return data.action
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── POST /resize — vertical scale (CPU/RAM), optionally grows disk too ──
  // DO requires the droplet to be powered off for a full resize; a
  // disk-only resize (disk:false passed with a same-CPU/RAM size doesn't
  // apply here) is not exposed separately — we surface DO's own error
  // message if the droplet isn't off.
  app.post('/resize', {
    schema: {
      body: {
        type: 'object',
        required: ['size'],
        properties: {
          size: { type: 'string' },
          disk: { type: 'boolean' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return reply.code(400).send({ error: 'No droplet selected.' })
    const { size, disk } = request.body as { size: string; disk?: boolean }
    try {
      const data = await doRequest<{ action: unknown }>(c.token, `/droplets/${c.dropletId}/actions`, {
        method: 'POST', body: { type: 'resize', size, disk: !!disk }
      })
      app.audit('server.resize', { req: request, meta: { dropletId: c.dropletId, size, disk: !!disk } })
      return data.action
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── PATCH /rename ──
  app.patch('/rename', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return reply.code(400).send({ error: 'No droplet selected.' })
    const { name } = request.body as { name: string }
    try {
      const data = await doRequest<{ action: unknown }>(c.token, `/droplets/${c.dropletId}/actions`, {
        method: 'POST', body: { type: 'rename', name }
      })
      app.audit('server.rename', { req: request, meta: { dropletId: c.dropletId, name } })
      return data.action
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── Snapshots ──
  app.get('/snapshots', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return []
    try {
      const data = await doRequest<{ snapshots: unknown[] }>(c.token, `/droplets/${c.dropletId}/snapshots?per_page=100`)
      return data.snapshots
    } catch (err) { return handleDOError(err, reply) }
  })

  app.post('/snapshots', {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return reply.code(400).send({ error: 'No droplet selected.' })
    const { name } = request.body as { name: string }
    try {
      const data = await doRequest<{ action: unknown }>(c.token, `/droplets/${c.dropletId}/actions`, {
        method: 'POST', body: { type: 'snapshot', name }
      })
      app.audit('server.snapshot_create', { req: request, meta: { dropletId: c.dropletId, name } })
      return data.action
    } catch (err) { return handleDOError(err, reply) }
  })

  app.delete('/snapshots/:id', async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    const { id } = request.params as { id: string }
    try {
      await doRequest(c.token, `/snapshots/${id}`, { method: 'DELETE' })
      app.audit('server.snapshot_delete', { req: request, meta: { snapshotId: id } })
      return { ok: true }
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── Backups — read-only list; enable/disable goes through /actions ──
  app.get('/backups', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return []
    try {
      const data = await doRequest<{ backups: unknown[] }>(c.token, `/droplets/${c.dropletId}/backups?per_page=100`)
      return data.backups
    } catch (err) { return handleDOError(err, reply) }
  })

  // ── Firewalls — list + simple rule add/remove ──
  app.get('/firewalls', async (_request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    if (!c.dropletId) return []
    try {
      const data = await doRequest<{ firewalls: { droplet_ids?: number[] }[] }>(c.token, '/firewalls?per_page=100')
      return data.firewalls.filter((f) => (f.droplet_ids ?? []).includes(Number(c.dropletId)))
    } catch (err) { return handleDOError(err, reply) }
  })

  app.post('/firewalls/:id/rules', {
    schema: {
      body: {
        type: 'object',
        properties: {
          inbound_rules: { type: 'array' },
          outbound_rules: { type: 'array' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    const { id } = request.params as { id: string }
    const body = request.body as { inbound_rules?: unknown[]; outbound_rules?: unknown[] }
    try {
      await doRequest(c.token, `/firewalls/${id}/rules`, { method: 'POST', body })
      app.audit('server.firewall_rule_add', { req: request, meta: { firewallId: id } })
      return { ok: true }
    } catch (err) { return handleDOError(err, reply) }
  })

  app.delete('/firewalls/:id/rules', {
    schema: {
      body: {
        type: 'object',
        properties: {
          inbound_rules: { type: 'array' },
          outbound_rules: { type: 'array' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const c = await requireCreds(reply); if (!c) return
    const { id } = request.params as { id: string }
    const body = request.body as { inbound_rules?: unknown[]; outbound_rules?: unknown[] }
    try {
      await doRequest(c.token, `/firewalls/${id}/rules`, { method: 'DELETE', body })
      app.audit('server.firewall_rule_remove', { req: request, meta: { firewallId: id } })
      return { ok: true }
    } catch (err) { return handleDOError(err, reply) }
  })
}
