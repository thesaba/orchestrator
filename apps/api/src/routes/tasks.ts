import { FastifyPluginAsync } from 'fastify'

const STATUSES  = ['todo', 'in_progress', 'review', 'done']
const PRIORITIES = ['low', 'medium', 'high', 'urgent']

function currentUser(request: { user: unknown }): { userId: number; role: string } {
  const u = request.user as { userId: number; role?: string }
  return { userId: u.userId, role: u.role ?? 'admin' }
}

const taskSelect = {
  id: true, title: true, description: true, status: true, priority: true,
  position: true, dueDate: true, tags: true, siteId: true,
  assigneeId: true, createdById: true, createdAt: true, updatedAt: true,
  assignee: { select: { id: true, email: true } },
  createdBy: { select: { id: true, email: true } },
  site: { select: { id: true, domain: true, name: true } },
  checklist: { orderBy: { position: 'asc' as const } },
  _count: { select: { comments: true } }
}

// Non-admins may only see/touch tasks they're assigned to or created.
function visibilityFilter(userId: number) {
  return { OR: [{ assigneeId: userId }, { createdById: userId }] }
}

export const tasksRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET /api/tasks — list (filterable). Non-admins are scoped to their own tasks.
  app.get('/', async (request) => {
    const { userId, role } = currentUser(request)
    const q = request.query as { siteId?: string; assigneeId?: string; status?: string; mine?: string }

    const where: Record<string, unknown> = {}
    if (role !== 'admin') Object.assign(where, visibilityFilter(userId))
    if (q.mine === '1') Object.assign(where, { assigneeId: userId })
    if (q.siteId)     where.siteId = Number(q.siteId)
    if (q.assigneeId) where.assigneeId = Number(q.assigneeId)
    if (q.status)     where.status = q.status

    const tasks = await app.prisma.task.findMany({
      where,
      select: taskSelect,
      orderBy: [{ status: 'asc' }, { position: 'asc' }]
    })
    return { tasks }
  })

  // GET /api/tasks/:id — single task with comments
  app.get('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId, role } = currentUser(request)

    const task = await app.prisma.task.findUnique({
      where: { id },
      select: {
        ...taskSelect,
        comments: {
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, email: true } } }
        }
      }
    })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && task.assigneeId !== userId && task.createdById !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    return task
  })

  // POST /api/tasks — create
  app.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title:       { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 10000 },
          status:      { type: 'string', enum: STATUSES },
          priority:    { type: 'string', enum: PRIORITIES },
          dueDate:     { type: 'string' },
          tags:        { type: 'array', items: { type: 'string' } },
          siteId:      { type: 'integer' },
          assigneeId:  { type: 'integer' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { userId, role } = currentUser(request)
    const body = request.body as {
      title: string; description?: string; status?: string; priority?: string
      dueDate?: string; tags?: string[]; siteId?: number; assigneeId?: number
    }

    // Non-admins can only create tasks assigned to themselves (or unassigned).
    if (role !== 'admin' && body.assigneeId && body.assigneeId !== userId) {
      return reply.code(403).send({ error: 'Only admins can assign tasks to other users.' })
    }

    // Highest position in the target column, so new cards land at the bottom.
    const status = body.status ?? 'todo'
    const top = await app.prisma.task.findFirst({
      where: { status },
      orderBy: { position: 'desc' },
      select: { position: true }
    })

    const task = await app.prisma.task.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        status,
        priority: body.priority ?? 'medium',
        position: (top?.position ?? 0) + 1,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        tags: JSON.stringify(body.tags ?? []),
        siteId: body.siteId ?? null,
        assigneeId: body.assigneeId ?? null,
        createdById: userId
      },
      select: taskSelect
    })

    app.audit('task.created', { req: request, siteId: task.siteId, meta: { taskId: task.id, title: task.title } })
    reply.code(201)
    return task
  })

  // PATCH /api/tasks/:id — update (status/position/title/etc.)
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title:       { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 10000, nullable: true },
          status:      { type: 'string', enum: STATUSES },
          priority:    { type: 'string', enum: PRIORITIES },
          position:    { type: 'number' },
          dueDate:     { type: 'string', nullable: true },
          tags:        { type: 'array', items: { type: 'string' } },
          siteId:      { type: 'integer', nullable: true },
          assigneeId:  { type: 'integer', nullable: true }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId, role } = currentUser(request)
    const body = request.body as {
      title?: string; description?: string | null; status?: string; priority?: string
      position?: number; dueDate?: string | null; tags?: string[]
      siteId?: number | null; assigneeId?: number | null
    }

    const existing = await app.prisma.task.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Task not found' })

    const canTouch = role === 'admin' || existing.assigneeId === userId || existing.createdById === userId
    if (!canTouch) return reply.code(403).send({ error: 'Forbidden' })

    if (role !== 'admin' && body.assigneeId !== undefined && body.assigneeId !== userId && body.assigneeId !== null) {
      return reply.code(403).send({ error: 'Only admins can reassign tasks to other users.' })
    }

    const data: Record<string, unknown> = {}
    if (body.title !== undefined)       data.title = body.title
    if (body.description !== undefined) data.description = body.description
    if (body.status !== undefined)      data.status = body.status
    if (body.priority !== undefined)    data.priority = body.priority
    if (body.position !== undefined)    data.position = body.position
    if (body.dueDate !== undefined)     data.dueDate = body.dueDate ? new Date(body.dueDate) : null
    if (body.tags !== undefined)        data.tags = JSON.stringify(body.tags)
    if (body.siteId !== undefined)      data.siteId = body.siteId
    if (body.assigneeId !== undefined)  data.assigneeId = body.assigneeId

    const task = await app.prisma.task.update({ where: { id }, data, select: taskSelect })

    app.audit('task.updated', { req: request, siteId: task.siteId, meta: { taskId: id, ...data } })
    return task
  })

  // DELETE /api/tasks/:id
  app.delete('/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const { userId, role } = currentUser(request)

    const existing = await app.prisma.task.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && existing.createdById !== userId) {
      return reply.code(403).send({ error: 'Only the creator or an admin can delete this task.' })
    }

    await app.prisma.task.delete({ where: { id } })
    app.audit('task.deleted', { req: request, siteId: existing.siteId, meta: { taskId: id, title: existing.title } })
    return { ok: true }
  })

  // ── Checklist ────────────────────────────────────────────────────────────
  app.post('/:id/checklist', {
    schema: { body: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 300 } }, additionalProperties: false } }
  }, async (request, reply) => {
    const taskId = Number((request.params as { id: string }).id)
    const { userId, role } = currentUser(request)
    const { text } = request.body as { text: string }

    const task = await app.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && task.assigneeId !== userId && task.createdById !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const top = await app.prisma.taskChecklistItem.findFirst({ where: { taskId }, orderBy: { position: 'desc' } })
    const item = await app.prisma.taskChecklistItem.create({
      data: { taskId, text, position: (top?.position ?? -1) + 1 }
    })
    reply.code(201)
    return item
  })

  app.patch('/:id/checklist/:itemId', {
    schema: {
      body: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1, maxLength: 300 }, done: { type: 'boolean' }, position: { type: 'integer' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const taskId = Number((request.params as { id: string; itemId: string }).id)
    const itemId = Number((request.params as { id: string; itemId: string }).itemId)
    const { userId, role } = currentUser(request)
    const body = request.body as { text?: string; done?: boolean; position?: number }

    const task = await app.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && task.assigneeId !== userId && task.createdById !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const item = await app.prisma.taskChecklistItem.update({
      where: { id: itemId },
      data: body
    })
    return item
  })

  app.delete('/:id/checklist/:itemId', async (request, reply) => {
    const taskId = Number((request.params as { id: string; itemId: string }).id)
    const itemId = Number((request.params as { id: string; itemId: string }).itemId)
    const { userId, role } = currentUser(request)

    const task = await app.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && task.assigneeId !== userId && task.createdById !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    await app.prisma.taskChecklistItem.delete({ where: { id: itemId } })
    return { ok: true }
  })

  // ── Comments ─────────────────────────────────────────────────────────────
  app.post('/:id/comments', {
    schema: { body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 5000 } }, additionalProperties: false } }
  }, async (request, reply) => {
    const taskId = Number((request.params as { id: string }).id)
    const { userId, role } = currentUser(request)
    const { body } = request.body as { body: string }

    const task = await app.prisma.task.findUnique({ where: { id: taskId } })
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    if (role !== 'admin' && task.assigneeId !== userId && task.createdById !== userId) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    const comment = await app.prisma.taskComment.create({
      data: { taskId, userId, body },
      include: { user: { select: { id: true, email: true } } }
    })
    reply.code(201)
    return comment
  })

  app.delete('/:id/comments/:commentId', async (request, reply) => {
    const commentId = Number((request.params as { id: string; commentId: string }).commentId)
    const { userId, role } = currentUser(request)

    const comment = await app.prisma.taskComment.findUnique({ where: { id: commentId } })
    if (!comment) return reply.code(404).send({ error: 'Comment not found' })
    if (role !== 'admin' && comment.userId !== userId) {
      return reply.code(403).send({ error: 'You can only delete your own comments.' })
    }

    await app.prisma.taskComment.delete({ where: { id: commentId } })
    return { ok: true }
  })
}
