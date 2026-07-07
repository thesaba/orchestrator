import { getSystemStats } from '../routes/monitor'
import { getRemoteSystemStats } from './server-stats'
import { toServerCtx } from './servers'

// How long to keep samples. At one sample/minute, 7 days ≈ 10k rows — trivial
// for SQLite, and enough for a week of history charts.
const RETENTION_MS = 7 * 24 * 60 * 60_000

async function sampleOnce(prisma: any) {
  try {
    // Local host sample (serverId=null) — unchanged from before.
    const stats = await getSystemStats()
    await prisma.metricSample.create({
      data: {
        serverId: null,
        cpuPercent: Math.round(stats.cpu.percent),
        ramPercent: Math.round(stats.ram.percent),
        diskPercent: Math.round(stats.disk.percent)
      }
    })

    // Remote servers — best-effort, one SSH round-trip each. Failures are
    // swallowed so an unreachable server never disturbs local sampling.
    const remotes = await prisma.server.findMany({ where: { kind: 'remote' } }).catch(() => [])
    for (const srv of remotes) {
      try {
        const rs = await getRemoteSystemStats(toServerCtx(srv))
        await prisma.metricSample.create({
          data: {
            serverId: srv.id,
            cpuPercent: Math.round(rs.cpu.percent),
            ramPercent: Math.round(rs.ram.percent),
            diskPercent: Math.round(rs.disk.percent)
          }
        })
        await prisma.server.update({ where: { id: srv.id }, data: { status: 'online', lastSeenAt: new Date() } }).catch(() => {})
      } catch {
        await prisma.server.update({ where: { id: srv.id }, data: { status: 'offline' } }).catch(() => {})
      }
    }

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
