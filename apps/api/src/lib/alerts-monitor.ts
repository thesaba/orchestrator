import { FastifyInstance } from 'fastify'
import { getSystemStats } from '../routes/monitor'
import { createNotification } from './notifications'
import { sendNotification } from './notify'

const METRIC_LABEL: Record<string, string> = { cpu: 'CPU', ram: 'RAM', disk: 'Disk', swap: 'Swap' }

// Evaluates enabled AlertRules against live system stats on a schedule and
// raises a Notification (+ channel alert) when a threshold is crossed,
// respecting each rule's cooldown. Runs alongside the other background
// monitors; failures are logged, never thrown.
export function startAlertsMonitor(app: FastifyInstance): void {
  const run = async () => {
    try {
      const rules = await app.prisma.alertRule.findMany({ where: { enabled: true } })
      if (rules.length === 0) return

      const stats = await getSystemStats()
      const values: Record<string, number> = {
        cpu: stats.cpu.percent,
        ram: stats.ram.percent,
        disk: stats.disk.percent,
        swap: stats.swap.percent
      }
      const now = Date.now()

      for (const rule of rules) {
        const val = values[rule.metric]
        if (val == null) continue
        const hit = rule.operator === 'lt' ? val < rule.threshold : val > rule.threshold
        if (!hit) continue
        if (rule.lastTriggeredAt && now - rule.lastTriggeredAt.getTime() < rule.cooldownMins * 60_000) continue

        const label = METRIC_LABEL[rule.metric] ?? rule.metric
        const sign = rule.operator === 'lt' ? 'below' : 'above'
        const title = `${label} ${sign} ${rule.threshold}%`
        const body = `${label} is at ${val}% (threshold ${rule.operator === 'lt' ? '<' : '>'} ${rule.threshold}%) on ${stats.hostname}.`

        await createNotification(app, { type: 'alert', level: 'warning', title, body, meta: { metric: rule.metric, value: val, threshold: rule.threshold } })
        await sendNotification(app, {
          title: `⚠️ ${title}`,
          subject: stats.hostname,
          status: 'warning',
          fields: [{ label, value: `${val}%` }]
        }).catch(() => {})
        await app.prisma.alertRule.update({ where: { id: rule.id }, data: { lastTriggeredAt: new Date() } })
      }
    } catch (err: unknown) {
      app.log.warn(`alerts monitor: ${(err as Error).message}`)
    }
  }

  const interval = Number(process.env.ALERTS_INTERVAL_MS ?? 120_000)
  setInterval(run, interval)
  setTimeout(run, 15_000) // first pass shortly after boot
}
