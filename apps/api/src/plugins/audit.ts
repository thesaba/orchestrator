import fp from 'fastify-plugin'

export interface AuditOpts {
  siteId?: number | null
  userId?: number | null
  meta?: Record<string, unknown>
}

declare module 'fastify' {
  interface FastifyInstance {
    audit: (action: string, opts?: AuditOpts) => void
  }
}

export const auditPlugin = fp(async (app) => {
  app.decorate('audit', (action: string, opts: AuditOpts = {}) => {
    // Fire-and-forget — never block the caller
    app.prisma.auditLog
      .create({
        data: {
          action,
          siteId: opts.siteId ?? null,
          userId: opts.userId ?? null,
          meta: opts.meta ? JSON.stringify(opts.meta) : null
        }
      })
      .catch(() => {}) // silently ignore write errors
  })
})
