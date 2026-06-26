import { FastifyPluginAsync } from 'fastify'

function currentUser(request: { user: unknown }): { userId: number; role: string } {
  const u = request.user as { userId: number; role?: string }
  return { userId: u.userId, role: u.role ?? 'admin' }
}

const noteSelect = {
  id: true, title: true, body: true, pinned: true, isPublic: true, tags: true,
  siteId: true, ownerId: true, createdAt: true, updatedAt: true,
  owner: { select: { id: true, email: true } },
  site: { select: { id: true, domain: true, name: true } },
  shares: { select: { userId: true, canEdit: true, user: { select: { id: true, email: true } } } }
}

async function loadVisible(app: any, id: number, userId: number) {
  const note = await app.prisma.note.findUnique({ where: { id }, select: noteSelect })
  if (!note) return { note: null, canEdit: false }
  const isOwner = note.ownerId === userId
  const share = note.shares.find((s: { userId: number; canEdit: boolean }) => s.userId === userId)
  const visible = isOwner || note.isPublic || !!share
  const canEdit = isOwner || !!share?.canEdit
  return { note: visible ? note : null, canEdit }
}

export const notesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET /api/notes — everything the caller can see: own, shared-with-them, or public
  app.get('/', async (request) => {
    const { userId } = currentUser(request)
    const q = request.query as { search?: string; tag?: string; pinned?: string; siteId?: string }

    const where: Record<string, unknown> = {
      OR: [
        { ownerId: userId },
        { isPublic: true },
        { shares: { some: { userId } } }
      ]
    }
    if (q.search) {
      where.AND = [{
        OR: [
          { title: { contains: q.search } },
          { body: { contains: q.search } }
        ]
      }]
    }
    if (q.pinned === '1') where.pinned = true
    if (q.siteId) where.siteId = Number(q.siteId)

    let notes = await app.prisma.note.findMany({
      where,
      select: noteSelect,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }]
    })

    if (q.tag) {
      notes = notes.filter((n: { tags: string }) => {
        try { return (JSON.parse(n.tags) as string[]).includes(q.tag!) } catch { return false }
      })
    }

    return {
      notes: notes.map((n: any) => ({ ...n, canEdit: n.ownerId === userId || !!n.shares.find((s: any) => s.userId === userId && s.canEdit) }))
    }
  })

  app.get('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId } = currentUser(request)
    const { note, canEdit } = await loadVisible(app, id, userId)
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    return { ...note, canEdit }
  })

  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:    { type: 'string', minLength: 1, maxLength: 200 },
          body:     { type: 'string', maxLength: 100000 },
          tags:     { type: 'array', items: { type: 'string' } },
          pinned:   { type: 'boolean' },
          isPublic: { type: 'boolean' },
          siteId:   { type: 'integer' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { userId } = currentUser(request)
    const b = request.body as { title: string; body?: string; tags?: string[]; pinned?: boolean; isPublic?: boolean; siteId?: number }

    const note = await app.prisma.note.create({
      data: {
        title: b.title,
        body: b.body ?? '',
        tags: JSON.stringify(b.tags ?? []),
        pinned: b.pinned ?? false,
        isPublic: b.isPublic ?? false,
        siteId: b.siteId ?? null,
        ownerId: userId
      },
      select: noteSelect
    })

    app.audit('note.created', { req: request, siteId: note.siteId, meta: { noteId: note.id, title: note.title } })
    reply.code(201)
    return { ...note, canEdit: true }
  })

  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title:    { type: 'string', minLength: 1, maxLength: 200 },
          body:     { type: 'string', maxLength: 100000 },
          tags:     { type: 'array', items: { type: 'string' } },
          pinned:   { type: 'boolean' },
          isPublic: { type: 'boolean' },
          siteId:   { type: 'integer', nullable: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId } = currentUser(request)
    const { note, canEdit } = await loadVisible(app, id, userId)
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    if (!canEdit) return reply.code(403).send({ error: 'You do not have edit access to this note.' })

    const b = request.body as { title?: string; body?: string; tags?: string[]; pinned?: boolean; isPublic?: boolean; siteId?: number | null }
    const data: Record<string, unknown> = {}
    if (b.title !== undefined)    data.title = b.title
    if (b.body !== undefined)     data.body = b.body
    if (b.tags !== undefined)     data.tags = JSON.stringify(b.tags)
    if (b.pinned !== undefined)   data.pinned = b.pinned
    if (b.siteId !== undefined)   data.siteId = b.siteId
    // Only the owner may change public visibility / re-share semantics.
    if (b.isPublic !== undefined && note.ownerId === userId) data.isPublic = b.isPublic

    const updated = await app.prisma.note.update({ where: { id }, data, select: noteSelect })
    app.audit('note.updated', { req: request, siteId: updated.siteId, meta: { noteId: id } })
    return { ...updated, canEdit: true }
  })

  app.delete('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId } = currentUser(request)
    const note = await app.prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    if (note.ownerId !== userId) return reply.code(403).send({ error: 'Only the owner can delete this note.' })

    await app.prisma.note.delete({ where: { id } })
    app.audit('note.deleted', { req: request, siteId: note.siteId, meta: { noteId: id, title: note.title } })
    return { ok: true }
  })

  // PUT /api/notes/:id/shares — owner replaces the full share list
  app.put('/:id/shares', {
    schema: {
      body: {
        type: 'object',
        required: ['shares'],
        properties: {
          shares: {
            type: 'array',
            items: {
              type: 'object',
              required: ['userId'],
              properties: { userId: { type: 'integer' }, canEdit: { type: 'boolean' } },
              additionalProperties: false
            }
          }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId } = currentUser(request)
    const note = await app.prisma.note.findUnique({ where: { id } })
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    if (note.ownerId !== userId) return reply.code(403).send({ error: 'Only the owner can manage sharing.' })

    const { shares } = request.body as { shares: { userId: number; canEdit?: boolean }[] }

    await app.prisma.$transaction([
      app.prisma.noteShare.deleteMany({ where: { noteId: id } }),
      ...shares
        .filter((s) => s.userId !== note.ownerId)
        .map((s) => app.prisma.noteShare.create({ data: { noteId: id, userId: s.userId, canEdit: !!s.canEdit } }))
    ])

    app.audit('note.shared', { req: request, siteId: note.siteId, meta: { noteId: id, shareCount: shares.length } })

    const updated = await app.prisma.note.findUnique({ where: { id }, select: noteSelect })
    return { ...updated, canEdit: true }
  })
}
