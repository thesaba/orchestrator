import { FastifyInstance } from 'fastify'
import { sendNotification } from './notify'
import { createNotification } from './notifications'
import { getSetting, setSetting } from './telegram'

export interface Digest {
  since: string
  deploySuccess: number
  deployFailed: number
  uptimePct: number | null
  avgMs: number | null
  errOpen: number
  errNew: number
  sites: number
}

// Compose a 7-day health summary from data already in the DB — read-only, cheap,
// and never touches the hosted sites.
export async function buildDigest(app: FastifyInstance): Promise<Digest> {
  const since = new Date(Date.now() - 7 * 86_400_000)

  const [deploySuccess, deployFailed, checks, errOpen, errNew, sites] = await Promise.all([
    app.prisma.deployment.count({ where: { status: 'success', createdAt: { gte: since } } }),
    app.prisma.deployment.count({ where: { status: 'failed', createdAt: { gte: since } } }),
    app.prisma.uptimeCheck.findMany({ where: { checkedAt: { gte: since } }, select: { status: true, responseMs: true } }),
    app.prisma.logError.count({ where: { resolved: false, ignored: false } }),
    app.prisma.logError.count({ where: { ignored: false, firstSeenAt: { gte: since } } }),
    app.prisma.site.count()
  ])

  const total = checks.length
  const up = checks.filter((c: { status: string }) => c.status === 'up').length
  const uptimePct = total ? Math.round((up / total) * 1000) / 10 : null
  const rts = checks.map((c: { responseMs: number | null }) => c.responseMs).filter((n: number | null): n is number => typeof n === 'number')
  const avgMs = rts.length ? Math.round(rts.reduce((a: number, b: number) => a + b, 0) / rts.length) : null

  return { since: since.toISOString(), deploySuccess, deployFailed, uptimePct, avgMs, errOpen, errNew, sites }
}

function digestFields(d: Digest): { label: string; value: string }[] {
  return [
    { label: 'Deploys (7d)', value: `${d.deploySuccess} ✅  ${d.deployFailed} ❌` },
    { label: 'Uptime', value: d.uptimePct != null ? `${d.uptimePct}%` : '—' },
    { label: 'Avg response', value: d.avgMs != null ? `${d.avgMs} ms` : '—' },
    { label: 'Errors', value: `${d.errOpen} open · ${d.errNew} new` },
    { label: 'Sites', value: String(d.sites) }
  ]
}

// Build + fan the digest out to the configured channels (email, Telegram, …)
// and drop it in the in-app bell feed.
export async function sendWeeklyDigest(app: FastifyInstance): Promise<Digest> {
  const d = await buildDigest(app)
  const fields = digestFields(d)
  await sendNotification(app, { title: '📊 Weekly digest', subject: 'Orchestrator', status: 'info', fields })
  await createNotification(app, {
    type: 'system',
    level: 'info',
    title: 'Weekly digest',
    body: `${d.deploySuccess + d.deployFailed} deploys · ${d.uptimePct ?? '—'}% uptime · ${d.errOpen} open errors`
  })
  return d
}

// Hourly check that, when enabled, sends the digest once on the configured
// weekday. Gated (default off) so nothing changes unless the user opts in.
export function startDigestMonitor(app: FastifyInstance): void {
  const run = async () => {
    try {
      if ((await getSetting(app, 'weekly_digest_enabled')) !== '1') return
      const day = Number((await getSetting(app, 'weekly_digest_day')) || '1') // 0=Sun … default Mon
      const now = new Date()
      if (now.getDay() !== day) return
      const todayKey = now.toISOString().slice(0, 10)
      if ((await getSetting(app, 'weekly_digest_last')) === todayKey) return // already sent today
      await sendWeeklyDigest(app)
      await setSetting(app, 'weekly_digest_last', todayKey)
      app.log.info('Weekly digest sent.')
    } catch (err: unknown) {
      app.log.warn(`weekly digest: ${(err as Error).message}`)
    }
  }
  setInterval(run, 3_600_000) // hourly
  setTimeout(run, 30_000)
}
