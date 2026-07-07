import { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import path from 'path'
import { execFileP } from '../lib/exec'

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

// Accept IPv4 addresses / CIDR only (keeps arbitrary strings out of the nginx
// config; nginx -t is a second line of defence).
function validIp(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/)
  if (!m) return false
  if ([1, 2, 3, 4].some((i) => Number(m[i]) > 255)) return false
  if (m[6] && Number(m[6]) > 32) return false
  return true
}

interface SecState {
  secBasicAuth: boolean
  secBasicUser: string | null
  secBasicHash: string | null
  secIpMode: string | null
  secIpList: string | null
}

function buildSnippet(domain: string, st: SecState): string {
  const lines: string[] = []
  if (st.secBasicAuth && st.secBasicUser && st.secBasicHash) {
    lines.push('auth_basic "Restricted";')
    lines.push(`auth_basic_user_file /etc/nginx/orchestrator-security/${domain}.htpasswd;`)
  }
  const ips: string[] = st.secIpList ? JSON.parse(st.secIpList) : []
  if (st.secIpMode === 'allow' && ips.length) {
    for (const ip of ips) lines.push(`allow ${ip};`)
    lines.push('deny all;')
  } else if (st.secIpMode === 'deny' && ips.length) {
    for (const ip of ips) lines.push(`deny ${ip};`)
  }
  return lines.join('\n')
}

function htpasswd(st: SecState): string {
  return st.secBasicAuth && st.secBasicUser && st.secBasicHash ? `${st.secBasicUser}:${st.secBasicHash}` : ''
}

// Per-site nginx security (basic auth + IP allow/deny). Registered under
// /api/sites, so per-site access applies; changes are admin-only.
export const siteSecurityRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // GET /:id/security — current config (never the password hash).
  app.get('/:id/security', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) },
      select: { secBasicAuth: true, secBasicUser: true, secIpMode: true, secIpList: true }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    return {
      basicAuth: site.secBasicAuth,
      basicUser: site.secBasicUser,
      hasPassword: !!site.secBasicUser,
      ipMode: site.secIpMode,
      ipList: site.secIpList ? JSON.parse(site.secIpList) : []
    }
  })

  // POST /:id/security — apply new config (admin only). Applies to nginx first
  // (guarded, reversible), then persists only on success.
  app.post('/:id/security', {
    preHandler: [app.requireRole(['admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          basicAuth: { type: 'boolean' },
          basicUser: { type: 'string', maxLength: 64 },
          basicPassword: { type: 'string', maxLength: 128 },
          ipMode: { type: 'string', enum: ['allow', 'deny', 'off'] },
          ipList: { type: 'array', items: { type: 'string', maxLength: 43 }, maxItems: 100 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    const b = request.body as { basicAuth?: boolean; basicUser?: string; basicPassword?: string; ipMode?: string; ipList?: string[] }

    const site = await app.prisma.site.findUnique({ where: { id } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    if (b.ipList) {
      const bad = b.ipList.find((ip) => !validIp(ip))
      if (bad) return reply.code(400).send({ error: `Invalid IP/CIDR: ${bad}` })
    }

    // Merge desired state onto the current one.
    const next: SecState = {
      secBasicAuth: b.basicAuth ?? site.secBasicAuth,
      secBasicUser: b.basicUser !== undefined ? (b.basicUser || null) : site.secBasicUser,
      secBasicHash: site.secBasicHash,
      secIpMode: b.ipMode !== undefined ? (b.ipMode === 'off' ? null : b.ipMode) : site.secIpMode,
      secIpList: b.ipList !== undefined ? JSON.stringify(b.ipList) : site.secIpList
    }
    if (b.basicPassword) next.secBasicHash = bcrypt.hashSync(b.basicPassword, 10)
    // Enabling basic auth without any credentials yet is a no-op guard.
    if (next.secBasicAuth && (!next.secBasicUser || !next.secBasicHash)) {
      return reply.code(400).send({ error: 'Set a username and password to enable basic auth.' })
    }

    // Apply to nginx (the script backs up + validates + rolls back on failure).
    try {
      await execFileP('bash', [path.join(scriptsDir(), 'site-security.sh'), site.domain], {
        timeout: 30_000,
        env: { ...process.env, SEC_SNIPPET: buildSnippet(site.domain, next), SEC_HTPASSWD: htpasswd(next) }
      })
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string }
      return reply.code(500).send({ error: 'nginx did not accept the security config (no changes applied to the live site).', detail: (e.stderr ?? e.message ?? '').slice(0, 500) })
    }

    // Persist only after nginx accepted it.
    await app.prisma.site.update({
      where: { id },
      data: {
        secBasicAuth: next.secBasicAuth,
        secBasicUser: next.secBasicUser,
        secBasicHash: next.secBasicHash,
        secIpMode: next.secIpMode,
        secIpList: next.secIpList
      }
    })
    app.audit('site.security', { req: request, siteId: id, meta: { basicAuth: next.secBasicAuth, ipMode: next.secIpMode } })

    return {
      basicAuth: next.secBasicAuth,
      basicUser: next.secBasicUser,
      hasPassword: !!next.secBasicUser,
      ipMode: next.secIpMode,
      ipList: next.secIpList ? JSON.parse(next.secIpList) : []
    }
  })
}
