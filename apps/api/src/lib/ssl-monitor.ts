import type { FastifyInstance } from 'fastify'
import { getCertInfo } from './ssl'
import { sendNotification } from './notify'

// Alert thresholds in days (ascending). We notify once as the certificate
// crosses into each more-urgent bucket, so a single expiry produces at most a
// handful of alerts (e.g. at 14, then 7, then 3, then 1 day) rather than one
// on every run.
const THRESHOLDS = [1, 3, 7, 14]

export function bucketFor(daysLeft: number): number | null {
  for (const t of THRESHOLDS) if (daysLeft <= t) return t
  return null // more than the largest threshold away — nothing to alert
}

const CACHE_KEY   = (siteId: number) => `ssl_cache:${siteId}`   // status for the dashboard badge
const ALERTED_KEY = (siteId: number) => `ssl_alerted:${siteId}` // last threshold we alerted at

export interface SslCacheEntry {
  active: boolean
  daysLeft: number | null
  expiresAt: string | null
  checkedAt: string
}

async function upsertSetting(prisma: any, key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, update: { value }, create: { key, value } }).catch(() => {})
}

async function checkOnce(app: FastifyInstance) {
  const prisma = app.prisma
  const sites = await prisma.site.findMany({
    where: { status: 'active', sslEnabled: true },
    select: { id: true, domain: true }
  })

  for (const site of sites) {
    try {
      const cert = await getCertInfo(site.domain)

      // 1. Refresh the cached status the sites list reads for its badge.
      const entry: SslCacheEntry = {
        active: cert.active,
        daysLeft: cert.daysLeft,
        expiresAt: cert.expiresAt,
        checkedAt: new Date().toISOString()
      }
      await upsertSetting(prisma, CACHE_KEY(site.id), JSON.stringify(entry))

      if (!cert.active || cert.daysLeft === null) continue

      // 2. Threshold-crossing alert logic (de-duplicated via ssl_alerted:<id>).
      const bucket = bucketFor(cert.daysLeft)
      const storedRow = await prisma.setting.findUnique({ where: { key: ALERTED_KEY(site.id) } }).catch(() => null)
      const stored = storedRow?.value ? Number(storedRow.value) : null

      if (bucket === null) {
        // Renewed / plenty of time left — reset so future expiry can alert again.
        if (stored !== null) {
          await prisma.setting.delete({ where: { key: ALERTED_KEY(site.id) } }).catch(() => {})
        }
        continue
      }

      const shouldAlert = stored === null || bucket < stored
      if (shouldAlert) {
        await sendNotification(app, {
          title: 'SSL certificate expiring soon',
          subject: site.domain,
          status: cert.daysLeft <= 3 ? 'failed' : 'warning',
          fields: [
            { label: 'Days left', value: String(cert.daysLeft) },
            { label: 'Expires', value: cert.expiresAt ?? '—' }
          ]
        })
        await upsertSetting(prisma, ALERTED_KEY(site.id), String(bucket))
        app.log.warn(`[ssl-monitor] ${site.domain} expires in ${cert.daysLeft}d — alert sent`)
      }
    } catch {
      /* skip individual site errors — one bad cert never blocks the rest */
    }
  }
}

/**
 * Start the periodic SSL expiry monitor. Runs shortly after boot and then on a
 * fixed interval (default every 12h). Certbot calls are cheap and sequential.
 */
export function startSslMonitor(app: FastifyInstance, intervalMs = 12 * 60 * 60_000) {
  const run = () => { checkOnce(app).catch(() => {}) }
  // Delay the first run so it doesn't compete with startup work.
  setTimeout(run, 60_000)
  return setInterval(run, intervalMs)
}
