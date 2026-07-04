import { FastifyPluginAsync } from 'fastify'

// Reserved preset name that stores each user's live/working layout. Kept as a
// row (rather than a separate table) so the auto layout and named presets share
// one storage shape and one set of endpoints.
const AUTO = '__auto__'

function userId(request: { user: unknown }): number {
  return (request.user as { userId: number }).userId
}

// Per-user monitoring dashboard layouts. Everything is scoped to the
// authenticated user — a preset belongs to whoever created it and is never
// visible to or mutable by anyone else.
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET / — the live auto layout (or null) + the user's named presets.
  app.get('/', async (request) => {
    const uid = userId(request)
    const rows = await app.prisma.dashboardPreset.findMany({
      where: { userId: uid },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, config: true, updatedAt: true }
    })
    const auto = rows.find((r: { name: string }) => r.name === AUTO) ?? null
    const presets = rows.filter((r: { name: string }) => r.name !== AUTO)
    return { auto: auto?.config ?? null, presets }
  })

  // PUT /auto — upsert the live working layout (debounced from the client).
  app.put('/auto', {
    schema: {
      body: {
        type: 'object',
        required: ['config'],
        properties: { config: { type: 'string', maxLength: 20000 } },
        additionalProperties: false
      }
    }
  }, async (request) => {
    const uid = userId(request)
    const { config } = request.body as { config: string }
    await app.prisma.dashboardPreset.upsert({
      where: { userId_name: { userId: uid, name: AUTO } },
      create: { userId: uid, name: AUTO, config },
      update: { config }
    })
    return { ok: true }
  })

  // POST /presets — create or replace a named preset for this user.
  app.post('/presets', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'config'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          config: { type: 'string', maxLength: 20000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const uid = userId(request)
    const { name, config } = request.body as { name: string; config: string }
    if (name.trim() === AUTO) return reply.code(400).send({ error: 'That name is reserved.' })
    const preset = await app.prisma.dashboardPreset.upsert({
      where: { userId_name: { userId: uid, name: name.trim() } },
      create: { userId: uid, name: name.trim(), config },
      update: { config },
      select: { id: true, name: true, config: true, updatedAt: true }
    })
    reply.code(201)
    return preset
  })

  // DELETE /presets/:id — remove a named preset (own only; never the auto row).
  app.delete('/presets/:id', async (request, reply) => {
    const uid = userId(request)
    const id = Number((request.params as { id: string }).id)
    const preset = await app.prisma.dashboardPreset.findUnique({ where: { id } })
    if (!preset || preset.userId !== uid) return reply.code(404).send({ error: 'Preset not found' })
    if (preset.name === AUTO) return reply.code(400).send({ error: 'The auto layout cannot be deleted.' })
    await app.prisma.dashboardPreset.delete({ where: { id } })
    return { ok: true }
  })
}
