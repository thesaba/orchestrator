import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { getBotToken, getSetting, setSetting, tgGetMe, tgSetWebhook, tgDeleteWebhook } from '../lib/telegram'
import { handleTelegramUpdate } from '../lib/telegram-bot'

// Telegram bot: account linking + webhook. The interactive command/callback
// logic lives in lib/telegram-bot.ts and reuses the panel's own API per user.
export const telegramRoutes: FastifyPluginAsync = async (app) => {
  function userId(request: { user: unknown }): number {
    return (request.user as { userId: number }).userId
  }

  // ── Public webhook — NO auth (protected by the secret in the path + header) ──
  app.post('/webhook/:secret', async (request, reply) => {
    const secret = (request.params as { secret: string }).secret
    const expected = await getSetting(app, 'telegram_webhook_secret')
    const headerToken = request.headers['x-telegram-bot-api-secret-token']
    if (!expected || secret !== expected || (headerToken && headerToken !== expected)) {
      return reply.code(404).send() // don't reveal anything
    }
    // Ack immediately so Telegram doesn't retry; process in the background.
    reply.send({ ok: true })
    handleTelegramUpdate(app, request.body).catch(() => {})
  })

  // ── Everything below requires a logged-in panel user ─────────────────────────

  // GET /me — link + bot status for the current user.
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const uid = userId(request)
    const [link, token, webhookSecret] = await Promise.all([
      app.prisma.telegramLink.findUnique({ where: { userId: uid }, select: { telegramUserId: true, username: true, linkedAt: true } }),
      getBotToken(app),
      getSetting(app, 'telegram_webhook_secret')
    ])
    let botUsername = ''
    if (token) { const me = await tgGetMe(token); botUsername = me?.result?.username ?? '' }
    return {
      linked: !!link?.telegramUserId,
      username: link?.username ?? null,
      linkedAt: link?.linkedAt ?? null,
      botConfigured: !!token,
      botUsername,
      webhookConfigured: !!webhookSecret
    }
  })

  // POST /link-code — issue a one-time code + deep link for the current user.
  app.post('/link-code', { preHandler: [app.authenticate] }, async (request, reply) => {
    const uid = userId(request)
    const token = await getBotToken(app)
    if (!token) return reply.code(400).send({ error: 'Configure the Telegram bot token in Settings → Notifications first.' })

    const code = crypto.randomBytes(4).toString('hex') // 8 chars
    const expires = new Date(Date.now() + 10 * 60_000)
    await app.prisma.telegramLink.upsert({
      where: { userId: uid },
      create: { userId: uid, linkCode: code, linkCodeExpires: expires },
      update: { linkCode: code, linkCodeExpires: expires }
    })
    const me = await tgGetMe(token)
    const botUsername = me?.result?.username ?? ''
    return {
      code,
      botUsername,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
      expiresAt: expires
    }
  })

  // POST /unlink — detach the current user's Telegram account.
  app.post('/unlink', { preHandler: [app.authenticate] }, async (request) => {
    const uid = userId(request)
    await app.prisma.telegramLink.updateMany({
      where: { userId: uid },
      data: { telegramUserId: null, chatId: null, username: null, linkedAt: null, linkCode: null, linkCodeExpires: null }
    })
    return { ok: true }
  })

  // ── Admin: webhook management ─────────────────────────────────────────────

  app.post('/setup', { preHandler: [app.authenticate, app.requireRole(['admin'])] }, async (_request, reply) => {
    const token = await getBotToken(app)
    if (!token) return reply.code(400).send({ error: 'Set the Telegram bot token in Settings → Notifications first.' })
    const panelUrl = (await getSetting(app, 'panel_url')).replace(/\/+$/, '')
    if (!panelUrl) return reply.code(400).send({ error: 'Set the Panel URL in Settings → General first (needed for the webhook URL).' })

    let secret = await getSetting(app, 'telegram_webhook_secret')
    if (!secret) { secret = crypto.randomBytes(24).toString('hex'); await setSetting(app, 'telegram_webhook_secret', secret) }

    const url = `${panelUrl}/api/telegram/webhook/${secret}`
    const result = await tgSetWebhook(token, url, secret)
    app.audit('telegram.webhook_set', { req: _request, meta: { url } })
    return { ok: true, url, result }
  })

  app.post('/remove-webhook', { preHandler: [app.authenticate, app.requireRole(['admin'])] }, async (request) => {
    const token = await getBotToken(app)
    if (token) await tgDeleteWebhook(token)
    app.audit('telegram.webhook_removed', { req: request })
    return { ok: true }
  })
}
