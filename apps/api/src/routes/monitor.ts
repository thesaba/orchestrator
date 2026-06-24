import { FastifyPluginAsync } from 'fastify'
import { spawn, exec as execCb } from 'child_process'
import { promisify } from 'util'
import tls from 'tls'
import os from 'os'

const exec = promisify(execCb)

// ── helpers ──────────────────────────────────────────────────────────────────

async function getDiskStats() {
  try {
    // -k forces 1024-byte blocks on both Linux and macOS
    const { stdout } = await exec("df -k / | awk 'NR==2{print $2,$3,$5}'")
    const [totalK, usedK, pctRaw] = stdout.trim().split(/\s+/)
    return {
      total: parseInt(totalK) * 1024,
      used: parseInt(usedK) * 1024,
      percent: parseInt(pctRaw) || 0
    }
  } catch {
    return { total: 0, used: 0, percent: 0 }
  }
}

async function checkService(name: string): Promise<'active' | 'inactive'> {
  try {
    await exec(`systemctl is-active --quiet ${name}`)
    return 'active'
  } catch {
    return 'inactive'
  }
}

async function getSystemStats() {
  const [load1, load5, load15] = os.loadavg()
  const cores = os.cpus().length
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const disk = await getDiskStats()

  return {
    cpu: {
      load1: Math.round(load1 * 100) / 100,
      load5: Math.round(load5 * 100) / 100,
      load15: Math.round(load15 * 100) / 100,
      cores,
      percent: Math.min(100, Math.round((load1 / cores) * 100))
    },
    ram: {
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percent: Math.round((usedMem / totalMem) * 100)
    },
    disk,
    uptime: Math.floor(os.uptime()),
    hostname: os.hostname()
  }
}

// ── service catalogue ────────────────────────────────────────────────────────

const SERVICE_CANDIDATES = [
  { key: 'nginx',      label: 'Nginx',      names: ['nginx'] },
  { key: 'mysql',      label: 'MySQL',       names: ['mysql', 'mariadb'] },
  { key: 'redis',      label: 'Redis',       names: ['redis-server', 'redis'] },
  { key: 'php-fpm',    label: 'PHP-FPM',    names: ['php8.3-fpm', 'php8.2-fpm', 'php8.1-fpm'] },
  { key: 'supervisor', label: 'Supervisor',  names: ['supervisor'] }
]

// Returns the first systemctl name that is installed/known for a key
async function resolveServiceName(names: string[]): Promise<string> {
  for (const name of names) {
    try {
      // systemctl cat exits 0 if the unit exists (even if stopped)
      await exec(`systemctl cat ${name} > /dev/null 2>&1`)
      return name
    } catch { /* not installed */ }
  }
  return names[0] // fallback — let control action report the real error
}

const VALID_ACTIONS = new Set(['start', 'stop', 'restart', 'reload'])

// ── routes ───────────────────────────────────────────────────────────────────

export const monitorRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // ── GET /system ─────────────────────────────────────────────────────────
  app.get('/system', async () => getSystemStats())

  // ── GET /services ────────────────────────────────────────────────────────
  app.get('/services', async () => {
    return Promise.all(
      SERVICE_CANDIDATES.map(async (svc) => {
        for (const name of svc.names) {
          const status = await checkService(name)
          if (status === 'active') {
            return { key: svc.key, name: svc.label, status: 'active' as const }
          }
        }
        return { key: svc.key, name: svc.label, status: 'inactive' as const }
      })
    )
  })

  // ── POST /services/:key/control ──────────────────────────────────────────
  app.post('/services/:key/control', {
    schema: {
      body: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'restart', 'reload'] }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const { key } = request.params as { key: string }
    const { action } = request.body as { action: string }

    const svc = SERVICE_CANDIDATES.find((s) => s.key === key)
    if (!svc) return reply.code(400).send({ error: `Unknown service: ${key}` })
    if (!VALID_ACTIONS.has(action)) return reply.code(400).send({ error: `Invalid action: ${action}` })

    const serviceName = await resolveServiceName(svc.names)

    let output = ''
    let ok = false
    try {
      const result = await exec(`systemctl ${action} ${serviceName} 2>&1`)
      output = (result.stdout + result.stderr).trim()
      ok = true
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      output = (e.stdout ?? e.stderr ?? e.message ?? 'Unknown error').trim()
    }

    const status = await checkService(serviceName)
    return { ok, key, serviceName, action, status, output }
  })

  // ── GET /services/:key/logs — SSE journalctl tail ────────────────────────
  app.get('/services/:key/logs', async (request, reply) => {
    const { key } = request.params as { key: string }

    const svc = SERVICE_CANDIDATES.find((s) => s.key === key)
    if (!svc) return reply.code(400).send({ error: `Unknown service: ${key}` })

    const serviceName = await resolveServiceName(svc.names)

    reply.hijack()
    const socket = reply.raw
    socket.setHeader('Content-Type', 'text/event-stream')
    socket.setHeader('Cache-Control', 'no-cache')
    socket.setHeader('Connection', 'keep-alive')
    socket.setHeader('X-Accel-Buffering', 'no')

    const send = (obj: object) => {
      if (!socket.destroyed) socket.write(`data: ${JSON.stringify(obj)}\n\n`)
    }

    const child = spawn('journalctl', [
      '-u', serviceName, '-f', '-n', '100', '--no-pager', '-o', 'short-iso'
    ])

    child.stdout.on('data', (chunk: Buffer) =>
      chunk.toString().split('\n').filter(Boolean).forEach((line) => send({ line }))
    )
    child.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      if (msg) send({ error: msg })
    })

    const ka = setInterval(() => { if (!socket.destroyed) socket.write(': ka\n\n') }, 20_000)

    await new Promise<void>((resolve) => {
      socket.on('close', () => {
        child.kill('SIGTERM')
        clearInterval(ka)
        resolve()
      })
      child.on('exit', () => {
        clearInterval(ka)
        send({ done: true })
        if (!socket.destroyed) socket.end()
        resolve()
      })
    })
  })

  // ── GET /stats/history — last 7 days deploy counts for charts ───────────
  app.get('/stats/history', async () => {
    const days: { date: string; success: number; failed: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      const nextD = new Date(d)
      nextD.setDate(nextD.getDate() + 1)

      const [success, failed] = await Promise.all([
        app.prisma.deployment.count({ where: { status: 'success', createdAt: { gte: d, lt: nextD } } }),
        app.prisma.deployment.count({ where: { status: 'failed', createdAt: { gte: d, lt: nextD } } })
      ])
      days.push({ date: d.toISOString().slice(0, 10), success, failed })
    }
    return { days }
  })

  // ── GET /ssl — SSL expiry for all active sites ───────────────────────────
  app.get('/ssl', async () => {
    const sites = await app.prisma.site.findMany({
      where: { status: 'active', sslEnabled: true },
      select: { id: true, domain: true }
    })

    const results = await Promise.all(
      sites.map(async (site) => {
        return new Promise<{ siteId: number; domain: string; daysLeft: number | null; expiresAt: string | null; error: string | null }>(
          (resolve) => {
            const timeout = setTimeout(() => {
              resolve({ siteId: site.id, domain: site.domain, daysLeft: null, expiresAt: null, error: 'Timeout' })
            }, 10_000)

            try {
              const socket = tls.connect(
                { host: site.domain, port: 443, servername: site.domain, rejectUnauthorized: false },
                () => {
                  clearTimeout(timeout)
                  const cert = socket.getPeerCertificate()
                  socket.destroy()

                  if (!cert?.valid_to) {
                    resolve({ siteId: site.id, domain: site.domain, daysLeft: null, expiresAt: null, error: 'No certificate' })
                    return
                  }

                  const expiresAt = new Date(cert.valid_to)
                  const daysLeft = Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000)
                  resolve({ siteId: site.id, domain: site.domain, daysLeft, expiresAt: expiresAt.toISOString(), error: null })
                }
              )
              socket.on('error', (err) => {
                clearTimeout(timeout)
                resolve({ siteId: site.id, domain: site.domain, daysLeft: null, expiresAt: null, error: err.message })
              })
            } catch (err: unknown) {
              clearTimeout(timeout)
              resolve({ siteId: site.id, domain: site.domain, daysLeft: null, expiresAt: null, error: (err as Error).message })
            }
          }
        )
      })
    )

    return { sites: results }
  })

  // ── GET /health-score/:siteId ─────────────────────────────────────────────
  app.get('/health-score/:siteId', async (request) => {
    const siteId = Number((request.params as { siteId: string }).siteId)
    const site = await app.prisma.site.findUnique({
      where: { id: siteId },
      select: { id: true, sslEnabled: true, maintenanceMode: true, uptimeMonitor: true }
    })
    if (!site) return { score: 0, breakdown: {} }

    // Uptime score (40pts): based on last 24h uptime checks
    const since24h = new Date(Date.now() - 86400_000)
    const checks = await app.prisma.uptimeCheck.findMany({
      where: { siteId, checkedAt: { gte: since24h } },
      select: { status: true }
    })
    const uptimePct = checks.length === 0 ? 1 : checks.filter(c => c.status === 'up').length / checks.length
    const uptimeScore = Math.round(uptimePct * 40)

    // Deploy score (30pts): last deployment status
    const lastDeploy = await app.prisma.deployment.findFirst({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true }
    })
    let deployScore = 15 // neutral if no deploys
    if (lastDeploy) {
      if (lastDeploy.status === 'success') deployScore = 30
      else if (lastDeploy.status === 'failed') deployScore = 0
      else deployScore = 15
    }

    // SSL score (20pts)
    const sslScore = site.sslEnabled ? 20 : 0

    // Maintenance score (10pts)
    const maintScore = site.maintenanceMode ? 0 : 10

    const total = uptimeScore + deployScore + sslScore + maintScore
    return {
      score: total,
      breakdown: { uptime: uptimeScore, deploy: deployScore, ssl: sslScore, maintenance: maintScore }
    }
  })

  // ── GET /logs/:siteId/stream — SSE tail of Laravel log ──────────────────
  app.get('/logs/:siteId/stream', async (request, reply) => {
    const { siteId } = request.params as { siteId: string }

    const site = await app.prisma.site.findUnique({ where: { id: Number(siteId) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const logPath = `${site.rootPath}/current/storage/logs/laravel.log`

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const send = (data: object) => {
      if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // tail -f: -n 100 sends last 100 lines then follows new entries
    const proc = spawn('tail', ['-F', '-n', '100', logPath])

    proc.stdout.on('data', (chunk: Buffer) => send({ line: chunk.toString() }))
    proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      // Only surface real errors, not "file not found yet" noise
      if (!msg.includes('No such file')) send({ error: msg })
    })

    await new Promise<void>((resolve) => {
      const ka = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ka\n\n')
      }, 20_000)

      request.raw.on('close', () => {
        proc.kill('SIGTERM')
        clearInterval(ka)
        resolve()
      })

      proc.on('exit', () => {
        clearInterval(ka)
        send({ done: true })
        reply.raw.end()
        resolve()
      })
    })
  })
}
