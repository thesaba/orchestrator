import { FastifyPluginAsync } from 'fastify'

function currentUser(request: { user: unknown }): { userId: number; role: string } {
  const u = request.user as { userId: number; role?: string }
  return { userId: u.userId, role: u.role ?? 'admin' }
}

const eventSelect = {
  id: true, title: true, description: true, type: true, startAt: true, endAt: true,
  allDay: true, color: true, recurrence: true, reminderMins: true,
  siteId: true, taskId: true, createdById: true, createdAt: true, updatedAt: true,
  site: { select: { id: true, domain: true, name: true } },
  task: { select: { id: true, title: true, status: true } },
  createdBy: { select: { id: true, email: true } },
  attendees: { select: { userId: true, user: { select: { id: true, email: true } } } }
}

const RECURRENCE_STEP_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}

// Expands a recurring event into occurrences overlapping [rangeStart, rangeEnd].
// "monthly" advances by calendar month (not a fixed millisecond step) so it
// lands on the same day-of-month each time.
function expandOccurrences(event: { startAt: Date; endAt: Date | null; recurrence: string | null }, rangeStart: Date, rangeEnd: Date) {
  const duration = event.endAt ? event.endAt.getTime() - event.startAt.getTime() : 0
  const occurrences: { startAt: Date; endAt: Date | null }[] = []

  if (!event.recurrence) {
    if (event.startAt <= rangeEnd && (event.endAt ?? event.startAt) >= rangeStart) {
      occurrences.push({ startAt: event.startAt, endAt: event.endAt })
    }
    return occurrences
  }

  let cursor = new Date(event.startAt)
  let guard = 0
  while (cursor <= rangeEnd && guard < 500) {
    guard++
    const occEnd = duration ? new Date(cursor.getTime() + duration) : null
    if (cursor >= rangeStart || (occEnd ?? cursor) >= rangeStart) {
      occurrences.push({ startAt: new Date(cursor), endAt: occEnd })
    }
    if (event.recurrence === 'monthly') {
      const next = new Date(cursor)
      next.setMonth(next.getMonth() + 1)
      cursor = next
    } else {
      const step = RECURRENCE_STEP_MS[event.recurrence]
      if (!step) break
      cursor = new Date(cursor.getTime() + step)
    }
  }
  return occurrences
}

export const calendarRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET /api/calendar/events?start=&end=&siteId=
  // Returns persisted events (expanded for recurrence) merged with "virtual"
  // entries computed on the fly — currently: task due dates. Virtual entries
  // use a synthetic id (e.g. "task-42") and are never persisted.
  app.get('/events', async (request) => {
    const { userId, role } = currentUser(request)
    const q = request.query as { start?: string; end?: string; siteId?: string }

    const rangeStart = q.start ? new Date(q.start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const rangeEnd   = q.end   ? new Date(q.end)   : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)

    const where: Record<string, unknown> = {}
    if (q.siteId) where.siteId = Number(q.siteId)

    const events = await app.prisma.calendarEvent.findMany({ where, select: eventSelect })

    const persisted = events.flatMap((e: any) => {
      const occs = expandOccurrences({ startAt: e.startAt, endAt: e.endAt, recurrence: e.recurrence }, rangeStart, rangeEnd)
      return occs.map((occ, i) => ({
        id: i === 0 ? `event-${e.id}` : `event-${e.id}-${i}`,
        kind: 'event' as const,
        title: e.title,
        description: e.description,
        type: e.type,
        startAt: occ.startAt,
        endAt: occ.endAt,
        allDay: e.allDay,
        color: e.color,
        recurrence: e.recurrence,
        siteId: e.siteId,
        site: e.site,
        taskId: e.taskId,
        task: e.task,
        createdBy: e.createdBy,
        attendees: e.attendees,
        editable: role === 'admin'
      }))
    })

    // Virtual: task due dates. Non-admins only see their own (assigned/created).
    const taskWhere: Record<string, unknown> = {
      dueDate: { gte: rangeStart, lte: rangeEnd },
      ...(q.siteId ? { siteId: Number(q.siteId) } : {})
    }
    if (role !== 'admin') {
      Object.assign(taskWhere, { OR: [{ assigneeId: userId }, { createdById: userId }] })
    }
    const tasks = await app.prisma.task.findMany({
      where: taskWhere,
      select: { id: true, title: true, dueDate: true, status: true, priority: true, siteId: true, site: { select: { id: true, domain: true, name: true } } }
    })
    const virtual = tasks.map((t: any) => ({
      id: `task-${t.id}`,
      kind: 'task_due' as const,
      title: t.title,
      description: null,
      type: 'task_deadline',
      startAt: t.dueDate,
      endAt: null,
      allDay: true,
      color: t.priority === 'urgent' ? '#d72c0d' : t.priority === 'high' ? '#e4a11b' : '#5c6ac4',
      recurrence: null,
      siteId: t.siteId,
      site: t.site,
      taskId: t.id,
      task: { id: t.id, title: t.title, status: t.status },
      createdBy: null,
      attendees: [],
      editable: false
    }))

    return { events: [...persisted, ...virtual] }
  })

  app.get('/events/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const event = await app.prisma.calendarEvent.findUnique({ where: { id }, select: eventSelect })
    if (!event) return reply.code(404).send({ error: 'Event not found' })
    return event
  })

  // Mutations are admin-only — the calendar is an admin-driven scheduling tool;
  // everyone else has read access (see GET above) plus their own task due dates.
  app.addHook('preHandler', async (request, reply) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      const { role } = currentUser(request)
      if (role !== 'admin') return reply.code(403).send({ error: 'Only admins can manage calendar events.' })
    }
  })

  app.post('/events', {
    schema: {
      body: {
        type: 'object',
        required: ['title', 'startAt'],
        properties: {
          title:        { type: 'string', minLength: 1, maxLength: 200 },
          description:  { type: 'string', maxLength: 5000 },
          type:         { type: 'string', maxLength: 50 },
          startAt:      { type: 'string' },
          endAt:        { type: 'string' },
          allDay:       { type: 'boolean' },
          color:        { type: 'string', maxLength: 20 },
          recurrence:   { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
          reminderMins: { type: 'integer' },
          siteId:       { type: 'integer' },
          taskId:       { type: 'integer' },
          attendeeIds:  { type: 'array', items: { type: 'integer' } }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { userId } = currentUser(request)
    const b = request.body as any

    const event = await app.prisma.calendarEvent.create({
      data: {
        title: b.title,
        description: b.description ?? null,
        type: b.type ?? 'custom',
        startAt: new Date(b.startAt),
        endAt: b.endAt ? new Date(b.endAt) : null,
        allDay: b.allDay ?? false,
        color: b.color ?? null,
        recurrence: b.recurrence ?? null,
        reminderMins: b.reminderMins ?? null,
        siteId: b.siteId ?? null,
        taskId: b.taskId ?? null,
        createdById: userId,
        attendees: b.attendeeIds?.length
          ? { create: b.attendeeIds.map((uid: number) => ({ userId: uid })) }
          : undefined
      },
      select: eventSelect
    })

    app.audit('calendar_event.created', { req: request, siteId: event.siteId, meta: { eventId: event.id, title: event.title } })
    reply.code(201)
    return event
  })

  app.patch('/events/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title:        { type: 'string', minLength: 1, maxLength: 200 },
          description:  { type: 'string', maxLength: 5000, nullable: true },
          type:         { type: 'string', maxLength: 50 },
          startAt:      { type: 'string' },
          endAt:        { type: 'string', nullable: true },
          allDay:       { type: 'boolean' },
          color:        { type: 'string', maxLength: 20, nullable: true },
          recurrence:   { type: 'string', enum: ['daily', 'weekly', 'monthly'], nullable: true },
          reminderMins: { type: 'integer', nullable: true },
          siteId:       { type: 'integer', nullable: true },
          taskId:       { type: 'integer', nullable: true },
          attendeeIds:  { type: 'array', items: { type: 'integer' } }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const existing = await app.prisma.calendarEvent.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Event not found' })

    const b = request.body as any
    const data: Record<string, unknown> = {}
    if (b.title !== undefined)        data.title = b.title
    if (b.description !== undefined)  data.description = b.description
    if (b.type !== undefined)         data.type = b.type
    if (b.startAt !== undefined)      data.startAt = new Date(b.startAt)
    if (b.endAt !== undefined)        data.endAt = b.endAt ? new Date(b.endAt) : null
    if (b.allDay !== undefined)       data.allDay = b.allDay
    if (b.color !== undefined)        data.color = b.color
    if (b.recurrence !== undefined)   data.recurrence = b.recurrence
    if (b.reminderMins !== undefined) data.reminderMins = b.reminderMins
    if (b.siteId !== undefined)       data.siteId = b.siteId
    if (b.taskId !== undefined)       data.taskId = b.taskId

    if (b.attendeeIds !== undefined) {
      await app.prisma.calendarEventAttendee.deleteMany({ where: { eventId: id } })
      if (b.attendeeIds.length) {
        await app.prisma.calendarEventAttendee.createMany({
          data: b.attendeeIds.map((uid: number) => ({ eventId: id, userId: uid }))
        })
      }
    }

    const event = await app.prisma.calendarEvent.update({ where: { id }, data, select: eventSelect })
    app.audit('calendar_event.updated', { req: request, siteId: event.siteId, meta: { eventId: id } })
    return event
  })

  app.delete('/events/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const existing = await app.prisma.calendarEvent.findUnique({ where: { id } })
    if (!existing) return reply.code(404).send({ error: 'Event not found' })

    await app.prisma.calendarEvent.delete({ where: { id } })
    app.audit('calendar_event.deleted', { req: request, siteId: existing.siteId, meta: { eventId: id, title: existing.title } })
    return { ok: true }
  })
}
