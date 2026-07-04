import { FastifyInstance } from 'fastify'
import { readSecret } from './crypto'

// ── Telegram Bot API helpers ─────────────────────────────────────────────────

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][]
}

async function tgCall<T = any>(token: string, method: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(api(token, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return (await res.json()) as T
  } catch {
    return null
  }
}

export function tgSend(token: string, chatId: string | number, text: string, keyboard?: InlineKeyboard) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {})
  })
}

export function tgEdit(token: string, chatId: string | number, messageId: number, text: string, keyboard?: InlineKeyboard) {
  return tgCall(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: keyboard } : {})
  })
}

export function tgAnswerCallback(token: string, callbackId: string, text?: string) {
  return tgCall(token, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) })
}

export function tgSetWebhook(token: string, url: string, secretToken: string) {
  return tgCall(token, 'setWebhook', { url, secret_token: secretToken, allowed_updates: ['message', 'callback_query'] })
}

export function tgDeleteWebhook(token: string) {
  return tgCall(token, 'deleteWebhook', {})
}

export function tgGetMe(token: string) {
  return tgCall<{ ok: boolean; result?: { username?: string } }>(token, 'getMe', {})
}

// ── Settings access (the bot token/webhook secret live in the Setting table) ──

export async function getBotToken(app: FastifyInstance): Promise<string> {
  const row = await app.prisma.setting.findUnique({ where: { key: 'deploy_telegram_bot_token' } }).catch(() => null)
  return readSecret(row?.value)
}

export async function getSetting(app: FastifyInstance, key: string): Promise<string> {
  const row = await app.prisma.setting.findUnique({ where: { key } }).catch(() => null)
  return row?.value?.trim() ?? ''
}

export async function setSetting(app: FastifyInstance, key: string, value: string): Promise<void> {
  await app.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
}
