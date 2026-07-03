import { FastifyInstance } from 'fastify'
import nodemailer from 'nodemailer'
import { readSecret } from './crypto'

// ── Generic notification model ──────────────────────────────────────────────
//
// All alerts (deploy results, SSL expiry, …) are expressed as a channel-neutral
// payload and fanned out to every configured channel. Adding a new alert type
// is just a matter of building a payload and calling sendNotification().

export type NotifyStatus = 'success' | 'failed' | 'warning' | 'info'

export interface NotificationPayload {
  /** Short headline, e.g. "Deploy succeeded" or "SSL expiring soon". */
  title: string
  /** The primary subject the alert is about, e.g. a domain. */
  subject: string
  status: NotifyStatus
  /** Optional key/value detail rows. */
  fields?: { label: string; value: string }[]
}

interface StatusStyle {
  icon: string
  /** Hex string for Slack/email. */
  hex: string
  /** Decimal color for Discord embeds. */
  int: number
}

function styleFor(status: NotifyStatus): StatusStyle {
  switch (status) {
    case 'success': return { icon: '✅', hex: '#36a64f', int: 0x36a64f }
    case 'failed':  return { icon: '❌', hex: '#e01e5a', int: 0xe01e5a }
    case 'warning': return { icon: '⚠️', hex: '#e8a33d', int: 0xe8a33d }
    default:        return { icon: 'ℹ️', hex: '#4a90d9', int: 0x4a90d9 }
  }
}

async function getSetting(app: FastifyInstance, key: string): Promise<string> {
  const row = await app.prisma.setting.findUnique({ where: { key } }).catch(() => null)
  return row?.value?.trim() ?? ''
}

/**
 * Fan an alert out to every configured channel. Each channel is best-effort and
 * isolated — one failing (or being unconfigured) never blocks the others.
 */
export async function sendNotification(app: FastifyInstance, payload: NotificationPayload): Promise<void> {
  await Promise.allSettled([
    notifySlack(app, payload),
    notifyDiscord(app, payload),
    notifyTelegram(app, payload),
    notifyGenericWebhook(app, payload),
    notifyEmail(app, payload)
  ])
}

// ── Deploy convenience wrapper (keeps the existing call sites working) ───────

interface DeployOpts {
  domain: string
  branch: string
  commit: string | null
  status: 'success' | 'failed'
  siteId: number
}

export async function notifyDeploy(app: FastifyInstance, opts: DeployOpts): Promise<void> {
  await sendNotification(app, {
    title: opts.status === 'success' ? 'Deploy succeeded' : 'Deploy FAILED',
    subject: opts.domain,
    status: opts.status,
    fields: [
      { label: 'Branch', value: opts.branch },
      { label: 'Commit', value: opts.commit ?? '—' }
    ]
  })
}

// ── Slack ────────────────────────────────────────────────────────────────────

async function notifySlack(app: FastifyInstance, p: NotificationPayload): Promise<void> {
  const webhookUrl = await getSetting(app, 'deploy_slack_webhook')
  if (!webhookUrl) return
  const s = styleFor(p.status)

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${s.icon} *${p.title}* — \`${p.subject}\``,
      attachments: [{
        color: s.hex,
        fields: (p.fields ?? []).map((f) => ({ title: f.label, value: f.value, short: true })),
        footer: 'Orchestrator',
        ts: Math.floor(Date.now() / 1000)
      }]
    })
  }).catch(() => {})
}

// ── Discord ──────────────────────────────────────────────────────────────────

async function notifyDiscord(app: FastifyInstance, p: NotificationPayload): Promise<void> {
  const webhookUrl = await getSetting(app, 'deploy_discord_webhook')
  if (!webhookUrl) return
  const s = styleFor(p.status)

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: `${s.icon} ${p.title}`,
        description: `\`${p.subject}\``,
        color: s.int,
        fields: (p.fields ?? []).map((f) => ({ name: f.label, value: f.value, inline: true })),
        footer: { text: 'Orchestrator' },
        timestamp: new Date().toISOString()
      }]
    })
  }).catch(() => {})
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function notifyTelegram(app: FastifyInstance, p: NotificationPayload): Promise<void> {
  const [tokenRaw, chatId] = await Promise.all([
    getSetting(app, 'deploy_telegram_bot_token'),
    getSetting(app, 'deploy_telegram_chat_id')
  ])
  const token = readSecret(tokenRaw) // stored encrypted at rest
  if (!token || !chatId) return
  const s = styleFor(p.status)

  const lines = [
    `${s.icon} <b>${escapeHtml(p.title)}</b>`,
    `<code>${escapeHtml(p.subject)}</code>`,
    ...(p.fields ?? []).map((f) => `${escapeHtml(f.label)}: <code>${escapeHtml(f.value)}</code>`)
  ]

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  }).catch(() => {})
}

// ── Generic webhook ──────────────────────────────────────────────────────────
// POSTs a stable JSON envelope so users can wire Orchestrator into any system
// (n8n, Zapier, a custom endpoint, …).

async function notifyGenericWebhook(app: FastifyInstance, p: NotificationPayload): Promise<void> {
  const url = await getSetting(app, 'deploy_generic_webhook')
  if (!url) return

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: 'orchestrator',
      title: p.title,
      subject: p.subject,
      status: p.status,
      fields: p.fields ?? [],
      timestamp: new Date().toISOString()
    })
  }).catch(() => {})
}

// ── Email ────────────────────────────────────────────────────────────────────

async function notifyEmail(app: FastifyInstance, p: NotificationPayload): Promise<void> {
  const to = await getSetting(app, 'notify_email')
  if (!to) return

  const smtpHost = process.env.SMTP_HOST?.trim()
  if (!smtpHost) return // SMTP not configured — skip silently

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
      : undefined
  })

  const s = styleFor(p.status)
  const from = process.env.SMTP_FROM ?? `Orchestrator <noreply@${p.subject}>`
  const rows = (p.fields ?? [])
    .map((f) => `  <tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(f.label)}</td><td><code>${escapeHtml(f.value)}</code></td></tr>`)
    .join('\n')

  await transporter.sendMail({
    from,
    to,
    subject: `${s.icon} ${p.title} — ${p.subject}`,
    text: [`${p.title} for ${p.subject}`, ...(p.fields ?? []).map((f) => `${f.label}: ${f.value}`)].join('\n'),
    html: `
<p>${s.icon} <strong>${escapeHtml(p.title)}</strong> — <code>${escapeHtml(p.subject)}</code></p>
<table style="border-collapse:collapse;font-family:monospace;font-size:14px">
${rows}
</table>
<p style="color:#999;font-size:12px;margin-top:24px">Sent by Orchestrator</p>`
  }).catch(() => {}) // best-effort — never throw
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}
