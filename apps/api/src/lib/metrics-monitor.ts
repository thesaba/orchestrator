import { getSystemStats } from '../routes/monitor'

// How long to keep samples. At one sample/minute, 7 days ≈ 10k rows — trivial
// for SQLite, and enough for a week of history charts.
const RETENTION_MS = 7 * 24 * 60 * 60_000

async function sampleOnce(prisma: any) {
  try {
    const stats = await getSystemStats()
    await prisma.metricSample.create({
      data: {
        cpuPercent: Math.round(stats.cpu.percent),
        ramPercent: Math.round(stats.ram.percent),
        diskPercent: Math.round(stats.disk.percent)
      }
    })

    // Prune anything older than the retention window (best-effort).
    await prisma.metricSample.deleteMany({
      where: { checkedAt: { lt: new Date(Date.now() - RETENTION_MS) } }
    }).catch(() => {})
  } catch {
    /* skip individual sample errors — never crash the loop */
  }
}

/**
 * Start sampling host CPU/RAM/disk into MetricSample on a fixed interval
 * (default every minute) so the Monitoring page can render historical charts.
 */
export function startMetricsMonitor(prisma: any, intervalMs = 60_000) {
  sampleOnce(prisma) // immediate first sample
  return setInterval(() => { sampleOnce(prisma) }, intervalMs)
}
