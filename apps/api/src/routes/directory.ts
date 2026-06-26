import { FastifyPluginAsync } from 'fastify'

// Minimal user directory available to ALL authenticated users (not admin-only,
// unlike /api/users). Used by Tasks (assignee picker), Notes (share picker),
// and Calendar (attendee picker) — none of those need full user management,
// just enough to label/select a person.
export const directoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => {
    const users = await app.prisma.user.findMany({
      select: { id: true, email: true, role: true },
      orderBy: { email: 'asc' }
    })
    return { users }
  })
}
