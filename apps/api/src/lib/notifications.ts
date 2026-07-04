import { FastifyInstance } from 'fastify'

export type NotifLevel = 'info' | 'success' | 'warning' | 'critical'

// Create an in-app notification (the bell feed). Best-effort — a failure here
// must never break the thing that triggered it (a deploy, an alert check, …).
// The feed is capped at the latest 200 rows.
export async function createNotification(app: FastifyInstance, data: {
  type: string
  level?: NotifLevel
  title: string
  body?: string
  meta?: Record<string, unknown>
}): Promise<void> {
  try {
    await app.prisma.notification.create({
      data: {
        type: data.type,
        level: data.level ?? 'info',
        title: data.title,
        body: data.body ?? null,
        meta: data.meta ? JSON.stringify(data.meta) : null
      }
    })
    const stale = await app.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' }, skip: 200, select: { id: true }
    })
    if (stale.length) {
      await app.prisma.notification.deleteMany({ where: { id: { in: stale.map((s: { id: number }) => s.id) } } })
    }
  } catch { /* best-effort */ }
}
