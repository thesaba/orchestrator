import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'

export const jwtPlugin = fp(async (app) => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET environment variable is required — refusing to start')

  await app.register(jwt, { secret })

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  })
})
