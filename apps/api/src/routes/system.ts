import { FastifyPluginAsync } from 'fastify'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import os from 'os'
import { run } from '../lib/exec'

// Keep apt fully non-interactive so a streamed upgrade can never hang on a
// config-file prompt.
const APT_ENV = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
const CONF = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']

interface ActionDef {
  file: string
  args: string[]
  label: string
  env?: NodeJS.ProcessEnv
  /** ufw allow/deny take a strictly-validated port/service argument. */
  needsArg?: boolean
}

// Every runnable action is a FIXED command. The client only sends an allowlist
// key (and, for ufw, a strictly-validated port/service). Commands run via
// spawn with an argv array — NO shell — so nothing the client sends can be
// interpreted as a command. Privileged actions go through `sudo -n`
// (passwordless sudo must be granted for exactly these commands — see README).
const ACTIONS: Record<string, ActionDef> = {
  'apt-update':       { file: 'sudo', args: ['-n', 'apt-get', 'update'], label: 'apt-get update' },
  'apt-upgrade':      { file: 'sudo', args: ['-n', 'apt-get', '-y', ...CONF, 'upgrade'], label: 'apt-get upgrade', env: APT_ENV },
  'apt-dist-upgrade': { file: 'sudo', args: ['-n', 'apt-get', '-y', ...CONF, 'dist-upgrade'], label: 'apt-get dist-upgrade', env: APT_ENV },
  'apt-autoremove':   { file: 'sudo', args: ['-n', 'apt-get', '-y', 'autoremove', '--purge'], label: 'apt-get autoremove', env: APT_ENV },
  'apt-clean':        { file: 'sudo', args: ['-n', 'apt-get', 'clean'], label: 'apt-get clean' },
  'journal-vacuum':   { file: 'sudo', args: ['-n', 'journalctl', '--vacuum-time=7d'], label: 'journalctl --vacuum-time=7d' },
  'ufw-status':       { file: 'sudo', args: ['-n', 'ufw', 'status', 'verbose'], label: 'ufw status verbose' },
  'ufw-enable':       { file: 'sudo', args: ['-n', 'ufw', '--force', 'enable'], label: 'ufw enable' },
  'ufw-allow':        { file: 'sudo', args: ['-n', 'ufw', 'allow'], label: 'ufw allow', needsArg: true },
  'ufw-deny':         { file: 'sudo', args: ['-n', 'ufw', 'deny'], label: 'ufw deny', needsArg: true },
  'reboot':           { file: 'sudo', args: ['-n', 'reboot'], label: 'reboot server' }
}

// A ufw rule target: a port (optionally /tcp|/udp) or a well-known service name.
function validUfwArg(arg: string): boolean {
  if (/^(ssh|http|https|ftp|smtp)$/.test(arg)) return true
  const m = arg.match(/^(\d{1,5})(\/(tcp|udp))?$/)
  if (!m) return false
  const port = Number(m[1])
  return port >= 1 && port <= 65535
}

// Server system control — apt, journal/cleanup, ufw, reboot. Real root-level
// operations against the host, so the whole group is admin-only (same bar as
// the DigitalOcean droplet controls).
export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireRole(['admin']))

  // ── GET /info — read-only system snapshot ────────────────────────────────
  app.get('/info', async () => {
    let kernel = ''
    try { kernel = (await run('uname', ['-r'], { timeout: 5_000 })).stdout.trim() } catch { /* ignore */ }

    let osName = ''
    try {
      const txt = await fs.readFile('/etc/os-release', 'utf8')
      osName = txt.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1] ?? ''
    } catch { /* not linux / no file */ }

    // Pending package updates (simulation — no sudo, no changes).
    let pendingUpdates = -1
    try {
      const { stdout } = await run('apt-get', ['-s', 'upgrade'], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
      pendingUpdates = stdout.split('\n').filter((l) => l.startsWith('Inst ')).length
    } catch { /* apt not present or errored — leave -1 (unknown) */ }

    let rebootRequired = false
    try { await fs.access('/var/run/reboot-required'); rebootRequired = true } catch { /* not required */ }

    let ufwStatus: 'active' | 'inactive' | null = null
    try {
      const { stdout } = await run('sudo', ['-n', 'ufw', 'status'], { timeout: 6_000 })
      ufwStatus = /Status:\s*active/i.test(stdout) ? 'active' : 'inactive'
    } catch { ufwStatus = null } // ufw absent or sudo not granted

    return {
      hostname: os.hostname(),
      kernel,
      os: osName,
      uptimeSeconds: Math.floor(os.uptime()),
      pendingUpdates,
      rebootRequired,
      ufwStatus
    }
  })

  // ── GET /run/:key/stream — run an allowlisted action, stream output (SSE) ──
  app.get('/run/:key/stream', async (request, reply) => {
    const { key } = request.params as { key: string }
    const action = ACTIONS[key]
    if (!action) return reply.code(400).send({ error: `Unknown action: ${key}` })

    const args = [...action.args]
    let argMeta: string | undefined
    if (action.needsArg) {
      const arg = String((request.query as { arg?: string }).arg ?? '')
      if (!validUfwArg(arg)) {
        return reply.code(400).send({ error: 'Invalid firewall target. Use a port (e.g. 8080 or 8080/tcp) or ssh/http/https.' })
      }
      args.push(arg)
      argMeta = arg
    }

    app.audit(`system.${key}`, { req: request, meta: { label: action.label, arg: argMeta } })

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    const send = (o: object) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(o)}\n\n`) }

    send({ line: `$ ${action.label}${argMeta ? ` ${argMeta}` : ''}\n` })

    const child = spawn(action.file, args, { env: action.env ?? process.env })
    const emit = (buf: Buffer) => buf.toString().split('\n').filter(Boolean).forEach((line) => send({ line }))
    child.stdout.on('data', emit)
    child.stderr.on('data', emit)

    const ka = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ka\n\n') }, 20_000)

    await new Promise<void>((resolve) => {
      child.on('error', (e) => { send({ line: `[error] ${e.message}` }) })
      child.on('exit', (code) => {
        clearInterval(ka)
        send({ done: true, status: code === 0 ? 'success' : 'failed' })
        if (!reply.raw.destroyed) reply.raw.end()
        resolve()
      })
      request.raw.on('close', () => { try { child.kill('SIGTERM') } catch { /* gone */ } clearInterval(ka); resolve() })
    })
  })
}
