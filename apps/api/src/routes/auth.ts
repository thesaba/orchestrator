import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import speakeasy from 'speakeasy'
import QRCode from 'qrcode'

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ── Login ───────────────────────────────────────────────────────────────────
  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:     { type: 'string', minLength: 1, maxLength: 254 },
          password:  { type: 'string', minLength: 1, maxLength: 128 },
          totpCode:  { type: 'string', maxLength: 8 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { email, password, totpCode } = request.body as {
      email: string; password: string; totpCode?: string
    }

    const user = await app.prisma.user.findUnique({ where: { email } })
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })

    // If 2FA enabled and code not provided yet, signal the frontend to ask for it
    if (user.totpEnabled && user.totpSecret) {
      if (!totpCode) {
        return reply.code(200).send({ requiresTOTP: true })
      }

      const verified = speakeasy.totp.verify({
        secret: user.totpSecret,
        encoding: 'base32',
        token: totpCode,
        window: 1 // allow ±30s clock drift
      })

      if (!verified) return reply.code(401).send({ error: 'Invalid TOTP code' })
    }

    const token = app.jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      { expiresIn: '7d' }
    )
    return { token }
  })

  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const payload = request.user as { userId: number; email: string }
    const user = await app.prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, totpEnabled: true, role: true }
    })
    return user
  })

  // ── 2FA Setup ───────────────────────────────────────────────────────────────

  // GET /2fa/setup — generate a new TOTP secret + QR code (don't enable yet)
  app.get('/2fa/setup', { preHandler: [app.authenticate] }, async (request) => {
    const payload = request.user as { userId: number; email: string }

    const secret = speakeasy.generateSecret({
      name: `Orchestrator (${payload.email})`,
      length: 20
    })

    // Persist the pending secret (overwrite any previous pending one)
    await app.prisma.user.update({
      where: { id: payload.userId },
      data: { totpSecret: secret.base32 }
    })

    const otpauthUrl = secret.otpauth_url ?? `otpauth://totp/Orchestrator:${encodeURIComponent(payload.email)}?secret=${secret.base32}&issuer=Orchestrator`
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl)

    return { secret: secret.base32, qrDataUrl }
  })

  // POST /2fa/enable — verify code and flip totpEnabled=true
  app.post('/2fa/enable', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['totpCode'],
        properties: { totpCode: { type: 'string', minLength: 6, maxLength: 8 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const payload = request.user as { userId: number }
    const { totpCode } = request.body as { totpCode: string }

    const user = await app.prisma.user.findUnique({ where: { id: payload.userId } })
    if (!user?.totpSecret) return reply.code(400).send({ error: 'Run /2fa/setup first' })

    const verified = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: totpCode,
      window: 1
    })

    if (!verified) return reply.code(400).send({ error: 'Invalid code — try again' })

    await app.prisma.user.update({ where: { id: payload.userId }, data: { totpEnabled: true } })
    return { ok: true }
  })

  // DELETE /2fa — disable 2FA
  app.delete('/2fa', { preHandler: [app.authenticate] }, async (request) => {
    const payload = request.user as { userId: number }
    await app.prisma.user.update({
      where: { id: payload.userId },
      data: { totpEnabled: false, totpSecret: null }
    })
    return { ok: true }
  })
}
