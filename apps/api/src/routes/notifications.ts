import { FastifyPluginAsync } from 'fastify'

// In-app notification feed. Global to the panel (see the Notification model).
export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // GET / — recent notifications + unread count.
  app.get('/', async () => {
    const [notifications, unread] = await Promise.all([
      app.prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      app.prisma.notification.count({ where: { read: false } })
    ])
    return { notifications, unread }
  })

  // POST /read-all — mark everything read.
  app.post('/read-all', async () => {
    await app.prisma.notification.updateMany({ where: { read: false }, data: { read: true } })
    return { ok: true }
  })

  // POST /:id/read — mark one read.
  app.post('/:id/read', async (request) => {
    const id = Number((request.params as { id: string }).id)
    await app.prisma.notification.update({ where: { id }, data: { read: true } }).catch(() => {})
    return { ok: true }
  })

  // DELETE /:id — remove one.
  app.delete('/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    await app.prisma.notification.delete({ where: { id } }).catch(() => {})
    return { ok: true }
  })

  // DELETE / — clear all.
  app.delete('/', async () => {
    await app.prisma.notification.deleteMany({})
    return { ok: true }
  })
}
