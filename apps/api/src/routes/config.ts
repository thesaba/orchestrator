import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import { execOn, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import { readFileOn, writeFileOn, copyFileOn, readdirOn } from '../lib/server-fs'

export const configRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // ── Nginx config ─────────────────────────────────────────────────────────

  app.get('/:id/config/nginx', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const configPath = `/etc/nginx/sites-available/${site.domain}`
    try {
      const content = await readFileOn(ctx, configPath)
      return { content, path: configPath }
    } catch {
      // Return template when file doesn't exist (site not provisioned yet or dev mode)
      return {
        content: nginxTemplate(site.domain, site.phpVersion, site.rootPath),
        path: configPath
      }
    }
  })

  app.put('/:id/config/nginx', {
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', maxLength: 65536 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const { content } = request.body as { content: string }
    const configPath = `/etc/nginx/sites-available/${site.domain}`
    const backupPath = `${configPath}.bak`

    // Backup existing file
    try { await copyFileOn(ctx, configPath, backupPath) } catch { /* first save */ }

    // Write new config
    await writeFileOn(ctx, configPath, content)

    // Ensure symlink
    try {
      await execOn(ctx, 'bash', ['-lc', `ln -sf ${configPath} /etc/nginx/sites-enabled/${site.domain}`])
    } catch { /* ignore if already linked */ }

    // Test — if it fails, restore and return error
    try {
      await execOn(ctx, 'bash', ['-lc', 'nginx -t 2>&1'])
    } catch (err: unknown) {
      try { await copyFileOn(ctx, backupPath, configPath) } catch { /* nothing */ }
      const msg = (err as { stderr?: string; stdout?: string; message?: string })
      return reply.code(400).send({
        error: 'Nginx config test failed — previous config restored.',
        details: msg.stderr ?? msg.stdout ?? msg.message ?? ''
      })
    }

    // Reload
    try {
      await execOn(ctx, 'bash', ['-lc', 'systemctl reload nginx'])
    } catch (err: unknown) {
      const msg = (err as { stderr?: string; message?: string })
      return reply.code(500).send({
        error: 'Nginx reload failed',
        details: msg.stderr ?? msg.message ?? ''
      })
    }

    return { ok: true, message: 'Nginx config saved and reloaded.' }
  })

  // ── .env ─────────────────────────────────────────────────────────────────

  app.get('/:id/config/env', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const envPath = `${site.rootPath}/shared/.env`
    try {
      const content = await readFileOn(ctx, envPath)
      return { content, path: envPath }
    } catch {
      return {
        content: envTemplate(site.domain, site.dbName ?? '', site.dbUser ?? ''),
        path: envPath
      }
    }
  })

  app.put('/:id/config/env', {
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: { content: { type: 'string', maxLength: 65536 } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const { content } = request.body as { content: string }
    const envPath = `${site.rootPath}/shared/.env`
    const uid = (request.user as { userId?: number }).userId ?? null

    // On the very first panel save, snapshot the pre-existing file so the
    // original is captured in history. All snapshotting is best-effort and
    // never blocks the actual save.
    try {
      const count = await app.prisma.envVersion.count({ where: { siteId: site.id } })
      if (count === 0) {
        const old = await readFileOn(ctx, envPath).catch(() => '')
        if (old.trim()) {
          await app.prisma.envVersion.create({ data: { siteId: site.id, content: encryptSecret(old), note: 'Before first panel edit', createdById: uid } })
        }
      }
    } catch { /* ignore */ }

    try { await copyFileOn(ctx, envPath, `${envPath}.bak`) } catch { /* first save */ }
    await writeFileOn(ctx, envPath, content)

    // Snapshot the newly-saved content, then prune to the latest 50 versions.
    try {
      await app.prisma.envVersion.create({ data: { siteId: site.id, content: encryptSecret(content), createdById: uid } })
      const stale = await app.prisma.envVersion.findMany({
        where: { siteId: site.id }, orderBy: { createdAt: 'desc' }, skip: 50, select: { id: true }
      })
      if (stale.length) await app.prisma.envVersion.deleteMany({ where: { id: { in: stale.map((s: { id: number }) => s.id) } } })
    } catch { /* snapshot best-effort */ }

    return { ok: true, message: '.env saved. Re-deploy to apply changes.' }
  })

  // ── .env version history (diff / restore) ──────────────────────────────────
  app.get('/:id/config/env/versions', async (request) => {
    const siteId = Number((request.params as { id: string }).id)
    const versions = await app.prisma.envVersion.findMany({
      where: { siteId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, note: true, createdAt: true, createdBy: { select: { email: true } } }
    })
    return { versions }
  })

  app.get('/:id/config/env/versions/:vid', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const vid = Number((request.params as { id: string; vid: string }).vid)
    const v = await app.prisma.envVersion.findUnique({ where: { id: vid } })
    if (!v || v.siteId !== siteId) return reply.code(404).send({ error: 'Version not found' })
    return { content: decryptSecret(v.content) ?? '', createdAt: v.createdAt }
  })

  app.post('/:id/config/env/versions/:vid/restore', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const vid = Number((request.params as { id: string; vid: string }).vid)
    const uid = (request.user as { userId?: number }).userId ?? null

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const v = await app.prisma.envVersion.findUnique({ where: { id: vid } })
    if (!v || v.siteId !== siteId) return reply.code(404).send({ error: 'Version not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const content = decryptSecret(v.content) ?? ''
    const envPath = `${site.rootPath}/shared/.env`

    // Snapshot the current file first, so a restore is itself reversible.
    try {
      const cur = await readFileOn(ctx, envPath)
      await app.prisma.envVersion.create({ data: { siteId, content: encryptSecret(cur), note: 'Before restore', createdById: uid } })
    } catch { /* ignore */ }
    try { await copyFileOn(ctx, envPath, `${envPath}.bak`) } catch { /* */ }
    await writeFileOn(ctx, envPath, content)

    app.audit('env.restored', { req: request, siteId, meta: { versionId: vid } })
    return { ok: true, content, message: '.env restored. Re-deploy to apply.' }
  })

  // ── PHP version ───────────────────────────────────────────────────────────

  app.get('/:id/php-versions', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const available = await detectPhpVersions(await serverCtxForSite(app.prisma, site))
    return { current: site.phpVersion, available }
  })

  app.post('/:id/php-version', {
    schema: {
      body: {
        type: 'object',
        required: ['version'],
        properties: {
          version: { type: 'string', pattern: '^\\d+\\.\\d+$' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { version } = request.body as { version: string }

    // Whitelist: only digits and dots e.g. "8.2", "8.3"
    if (!/^\d+\.\d+$/.test(version)) {
      return reply.code(400).send({ error: 'Invalid PHP version format.' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (site.phpVersion === version) {
      return reply.code(400).send({ error: `Site is already using PHP ${version}.` })
    }

    const ctx = await serverCtxForSite(app.prisma, site)
    const available = await detectPhpVersions(ctx)
    if (!available.includes(version)) {
      return reply.code(400).send({ error: `PHP ${version} is not installed on this server.` })
    }

    const configPath = `/etc/nginx/sites-available/${site.domain}`
    let configContent: string

    try {
      configContent = await readFileOn(ctx, configPath)
    } catch {
      // If config doesn't exist yet just update DB
      await app.prisma.site.update({ where: { id: siteId }, data: { phpVersion: version } })
      app.audit('php.switched', { siteId, meta: { domain: site.domain, from: site.phpVersion, to: version } })
      return { ok: true, reloaded: false, message: `PHP version updated to ${version} in database. Re-provision to apply to nginx.` }
    }

    // Replace all occurrences of the old PHP socket version
    const oldSocket = `php${site.phpVersion}-fpm.sock`
    const newSocket = `php${version}-fpm.sock`
    const updated = configContent.split(oldSocket).join(newSocket)

    if (updated === configContent) {
      // Socket not found — just update DB (SSL redirect config etc.)
      await app.prisma.site.update({ where: { id: siteId }, data: { phpVersion: version } })
      app.audit('php.switched', { siteId, meta: { domain: site.domain, from: site.phpVersion, to: version } })
      return { ok: true, reloaded: false, message: `PHP version updated to ${version}. No socket reference found in nginx config — may need manual nginx update.` }
    }

    const backupPath = `${configPath}.bak`
    try { await copyFileOn(ctx, configPath, backupPath) } catch { /* first time */ }
    await writeFileOn(ctx, configPath, updated)

    try {
      await execOn(ctx, 'bash', ['-lc', 'nginx -t 2>&1'])
    } catch (err: unknown) {
      try { await copyFileOn(ctx, backupPath, configPath) } catch { /* nothing */ }
      const msg = err as { stderr?: string; stdout?: string; message?: string }
      return reply.code(400).send({
        error: 'Nginx config test failed — previous config restored.',
        details: msg.stderr ?? msg.stdout ?? msg.message ?? ''
      })
    }

    await execOn(ctx, 'bash', ['-lc', 'systemctl reload nginx'])
    await app.prisma.site.update({ where: { id: siteId }, data: { phpVersion: version } })
    app.audit('php.switched', { siteId, meta: { domain: site.domain, from: site.phpVersion, to: version } })

    return { ok: true, reloaded: true, message: `Switched to PHP ${version} and reloaded nginx.` }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function detectPhpVersions(ctx: ServerCtx): Promise<string[]> {
  const versions = new Set<string>()

  // Method 1: /etc/php/<version> directories (Debian/Ubuntu)
  try {
    const entries = await readdirOn(ctx, '/etc/php')
    for (const e of entries) {
      if (/^\d+\.\d+$/.test(e)) versions.add(e)
    }
  } catch { /* not available */ }

  // Method 2: update-alternatives (covers non-standard installs)
  if (versions.size === 0) {
    try {
      const { stdout } = await execOn(ctx, 'bash', ['-lc', 'update-alternatives --list php 2>/dev/null || true'])
      for (const line of stdout.split('\n')) {
        const m = line.match(/php(\d+\.\d+)/)
        if (m) versions.add(m[1])
      }
    } catch { /* ignore */ }
  }

  // Method 3: which php<X.Y> binaries
  if (versions.size === 0) {
    for (const v of ['8.0', '8.1', '8.2', '8.3', '8.4']) {
      try {
        await execOn(ctx, 'bash', ['-lc', `which php${v}`])
        versions.add(v)
      } catch { /* not installed */ }
    }
  }

  return [...versions].sort()
}

// ── Templates ─────────────────────────────────────────────────────────────

function nginxTemplate(domain: string, phpVer: string, rootPath: string): string {
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    root ${rootPath}/current/public;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    index index.php;
    charset utf-8;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    error_page 404 /index.php;

    location ~ \\.php$ {
        fastcgi_pass unix:/var/run/php/php${phpVer}-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}
`
}

function envTemplate(domain: string, dbName: string, dbUser: string): string {
  // Generate a valid Laravel APP_KEY automatically
  const appKey = 'base64:' + crypto.randomBytes(32).toString('base64')
  return `APP_NAME="${domain}"
APP_ENV=production
APP_KEY=${appKey}
APP_DEBUG=false
APP_URL=https://${domain}

LOG_CHANNEL=stack
LOG_LEVEL=debug

DB_CONNECTION=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=${dbName}
DB_USERNAME=${dbUser}
DB_PASSWORD=

BROADCAST_DRIVER=log
CACHE_DRIVER=redis
FILESYSTEM_DISK=local
QUEUE_CONNECTION=redis
SESSION_DRIVER=redis
SESSION_LIFETIME=120

REDIS_HOST=127.0.0.1
REDIS_PASSWORD=null
REDIS_PORT=6379

MAIL_MAILER=log
MAIL_FROM_ADDRESS="hello@${domain}"
MAIL_FROM_NAME="\${APP_NAME}"
`
}
