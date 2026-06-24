import http from 'http'

interface CheckResult {
  status: 'up' | 'down'
  responseMs: number
  statusCode: number | null
}

export async function checkSiteUptime(domain: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const req = http.get(
      { hostname: domain, path: '/', timeout: 10_000, headers: { 'User-Agent': 'OrchestratorUptimeBot/1.0' } },
      (res) => {
        const responseMs = Date.now() - start
        const statusCode = res.statusCode ?? 0
        resolve({ status: statusCode >= 500 ? 'down' : 'up', responseMs, statusCode })
        res.destroy()
      }
    )
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', responseMs: 10_000, statusCode: null }) })
    req.on('error',   () => { resolve({ status: 'down', responseMs: Date.now() - start, statusCode: null }) })
  })
}

export function startUptimeMonitor(prisma: any, intervalMs = 5 * 60_000) {
  const run = async () => {
    try {
      const sites = await prisma.site.findMany({
        where: { status: 'active', uptimeMonitor: true },
        select: { id: true, domain: true }
      })

      for (const site of sites) {
        try {
          const result = await checkSiteUptime(site.domain)
          await prisma.uptimeCheck.create({
            data: { siteId: site.id, status: result.status, responseMs: result.responseMs, statusCode: result.statusCode }
          })

          // Keep only last 500 checks per site to avoid DB bloat
          const old = await prisma.uptimeCheck.findMany({
            where: { siteId: site.id },
            orderBy: { checkedAt: 'desc' },
            skip: 500,
            select: { id: true }
          })
          if (old.length > 0) {
            await prisma.uptimeCheck.deleteMany({ where: { id: { in: old.map((c: any) => c.id) } } })
          }
        } catch { /* skip individual site errors */ }
      }
    } catch { /* skip run errors */ }
  }

  run() // immediate first run
  return setInterval(run, intervalMs)
}
