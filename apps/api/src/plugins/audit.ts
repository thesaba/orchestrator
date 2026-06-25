import fp from 'fastify-plugin'

export interface AuditOpts {
  siteId?: number | null
  userId?: number | null
  meta?: Record<string, unknown>
  req?: { user?: unknown }
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: (action: string, opts?: AuditOpts) => void
  }
}

export const auditPlugin = fp(async (app) => {
  app.decorate('audit', (action: string, opts: AuditOpts = {}) => {
    const userId =
      opts.userId !== undefined
        ? opts.userId
        : ((opts.req?.user as { userId?: number })?.userId ?? null)

    app.prisma.auditLog
      .create({
        data: {
          action,
          siteId: opts.siteId ?? null,
          userId,
          meta: opts.meta ? JSON.stringify(opts.meta) : null
        }
      })
      .catch(() => {})
  })
})
