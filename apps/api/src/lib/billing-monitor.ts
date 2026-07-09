/**
 * Schedules the daily billing tick.
 *
 * Rather than a cron expression we poll every 30 minutes and run once per
 * calendar day (Asia/Tbilisi) after 03:00. The "have we already run today?"
 * marker lives in the database, not memory, so a panel restart at 03:05 cannot
 * cause a second run — and a panel that was down at 03:00 still catches up as
 * soon as it comes back.
 *
 * The tick itself is idempotent anyway; this is belt and braces.
 */

import { FastifyInstance } from 'fastify'
import { runBillingTick } from './billing/tick'
import { BILLING_TZ } from './billing/dunning'

const LAST_TICK_KEY = 'billing_last_tick'
const RUN_AFTER_HOUR = 3

/** Local calendar day + hour in the billing timezone. */
function localNow(now: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BILLING_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

export function startBillingMonitor(app: FastifyInstance, intervalMs = 30 * 60_000) {
  const tick = async () => {
    try {
      const now = new Date()
      const { day, hour } = localNow(now)
      if (hour < RUN_AFTER_HOUR) return

      const last = await (app.prisma as any).setting
        .findUnique({ where: { key: LAST_TICK_KEY } })
        .catch(() => null)
      if (last?.value === day) return // already ran today

      const report = await runBillingTick(app, { now })

      await (app.prisma as any).setting.upsert({
        where: { key: LAST_TICK_KEY },
        update: { value: day },
        create: { key: LAST_TICK_KEY, value: day }
      })

      if (report.issued.length || report.escalated.length || report.restored.length || report.errors.length) {
        app.log.info({ billing: report }, 'billing tick complete')
      }
    } catch (e) {
      app.log.error({ err: e }, 'billing tick failed')
    }
  }

  // Give the app a moment to finish booting, then poll.
  setTimeout(tick, 60_000)
  const handle = setInterval(tick, intervalMs)
  if (typeof handle.unref === 'function') handle.unref()
  return handle
}
