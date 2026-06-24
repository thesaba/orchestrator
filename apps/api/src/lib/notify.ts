import { FastifyInstance } from 'fastify'
import nodemailer from 'nodemailer'

interface DeployOpts {
  domain: string
  branch: string
  commit: string | null
  status: 'success' | 'failed'
  siteId: number
}

export async function notifyDeploy(app: FastifyInstance, opts: DeployOpts): Promise<void> {
  await Promise.all([notifySlack(app, opts), notifyEmail(app, opts)])
}

// ── Slack ──────────────────────────────────────────────────────────────────────

async function notifySlack(app: FastifyInstance, opts: DeployOpts): Promise<void> {
  const setting = await app.prisma.setting
    .findUnique({ where: { key: 'deploy_slack_webhook' } })
    .catch(() => null)
  const webhookUrl = setting?.value?.trim() ?? ''
  if (!webhookUrl) return

  const icon  = opts.status === 'success' ? '✅' : '❌'
  const color = opts.status === 'success' ? '#36a64f' : '#e01e5a'
  const label = opts.status === 'success' ? 'Deploy succeeded' : 'Deploy FAILED'

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${icon} *${label}* — \`${opts.domain}\``,
      attachments: [
        {
          color,
          fields: [
            { title: 'Branch', value: opts.branch,        short: true },
            { title: 'Commit', value: opts.commit ?? '—', short: true }
          ],
          footer: 'Orchestrator',
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    })
  }).catch(() => {})
}

// ── Email ──────────────────────────────────────────────────────────────────────

async function notifyEmail(app: FastifyInstance, opts: DeployOpts): Promise<void> {
  // Recipient comes from DB settings; SMTP config comes from env vars
  const setting = await app.prisma.setting
    .findUnique({ where: { key: 'notify_email' } })
    .catch(() => null)
  const to = setting?.value?.trim()
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

  const icon  = opts.status === 'success' ? '✅' : '❌'
  const label = opts.status === 'success' ? 'Deploy succeeded' : 'Deploy FAILED'
  const from  = process.env.SMTP_FROM ?? `Orchestrator <noreply@${opts.domain}>`

  await transporter.sendMail({
    from,
    to,
    subject: `${icon} ${label} — ${opts.domain}`,
    text: [
      `${label} for ${opts.domain}`,
      `Branch: ${opts.branch}`,
      `Commit: ${opts.commit ?? '—'}`
    ].join('\n'),
    html: `
<p>${icon} <strong>${label}</strong> — <code>${opts.domain}</code></p>
<table style="border-collapse:collapse;font-family:monospace;font-size:14px">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Branch</td><td><code>${opts.branch}</code></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Commit</td><td><code>${opts.commit ?? '—'}</code></td></tr>
</table>
<p style="color:#999;font-size:12px;margin-top:24px">Sent by Orchestrator</p>`
  }).catch(() => {}) // best-effort — never throw
}
