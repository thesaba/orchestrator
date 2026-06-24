import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email:    { type: 'string', minLength: 1, maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 128 }
    },
    additionalProperties: false
  }
} as const

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: loginSchema
  }, async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string }

    const user = await app.prisma.user.findUnique({ where: { email } })
    if (!user) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const token = app.jwt.sign(
      { userId: user.id, email: user.email },
      { expiresIn: '7d' }
    )
    return { token }
  })

  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const payload = request.user as { userId: number; email: string }
    return { userId: payload.userId, email: payload.email }
  })
}
