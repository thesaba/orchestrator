import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import crypto from 'crypto'

const exec = promisify(execCb)

export const configRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)

  // ── Nginx config ─────────────────────────────────────────────────────────

  app.get('/:id/config/nginx', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const configPath = `/etc/nginx/sites-available/${site.domain}`
    try {
      const content = await fs.readFile(configPath, 'utf-8')
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

    const { content } = request.body as { content: string }
    const configPath = `/etc/nginx/sites-available/${site.domain}`
    const backupPath = `${configPath}.bak`

    // Backup existing file
    try { await fs.copyFile(configPath, backupPath) } catch { /* first save */ }

    // Write new config
    await fs.writeFile(configPath, content, 'utf-8')

    // Ensure symlink
    try {
      await exec(`ln -sf ${configPath} /etc/nginx/sites-enabled/${site.domain}`)
    } catch { /* ignore if already linked */ }

    // Test — if it fails, restore and return error
    try {
      await exec('nginx -t 2>&1')
    } catch (err: unknown) {
      try { await fs.copyFile(backupPath, configPath) } catch { /* nothing */ }
      const msg = (err as { stderr?: string; stdout?: string; message?: string })
      return reply.code(400).send({
        error: 'Nginx config test failed — previous config restored.',
        details: msg.stderr ?? msg.stdout ?? msg.message ?? ''
      })
    }

    // Reload
    try {
      await exec('systemctl reload nginx')
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

    const envPath = `${site.rootPath}/shared/.env`
    try {
      const content = await fs.readFile(envPath, 'utf-8')
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

    const { content } = request.body as { content: string }
    const envPath = `${site.rootPath}/shared/.env`

    try { await fs.copyFile(envPath, `${envPath}.bak`) } catch { /* first save */ }
    await fs.writeFile(envPath, content, 'utf-8')

    return { ok: true, message: '.env saved. Re-deploy to apply changes.' }
  })

  // ── PHP version ───────────────────────────────────────────────────────────

  app.get('/:id/php-versions', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const available = await detectPhpVersions()
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

    const available = await detectPhpVersions()
    if (!available.includes(version)) {
      return reply.code(400).send({ error: `PHP ${version} is not installed on this server.` })
    }

    const configPath = `/etc/nginx/sites-available/${site.domain}`
    let configContent: string

    try {
      configContent = await fs.readFile(configPath, 'utf-8')
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
    try { await fs.copyFile(configPath, backupPath) } catch { /* first time */ }
    await fs.writeFile(configPath, updated, 'utf-8')

    try {
      await exec('nginx -t 2>&1')
    } catch (err: unknown) {
      try { await fs.copyFile(backupPath, configPath) } catch { /* nothing */ }
      const msg = err as { stderr?: string; stdout?: string; message?: string }
      return reply.code(400).send({
        error: 'Nginx config test failed — previous config restored.',
        details: msg.stderr ?? msg.stdout ?? msg.message ?? ''
      })
    }

    await exec('systemctl reload nginx')
    await app.prisma.site.update({ where: { id: siteId }, data: { phpVersion: version } })
    app.audit('php.switched', { siteId, meta: { domain: site.domain, from: site.phpVersion, to: version } })

    return { ok: true, reloaded: true, message: `Switched to PHP ${version} and reloaded nginx.` }
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function detectPhpVersions(): Promise<string[]> {
  const versions = new Set<string>()

  // Method 1: /etc/php/<version> directories (Debian/Ubuntu)
  try {
    const entries = await fs.readdir('/etc/php')
    for (const e of entries) {
      if (/^\d+\.\d+$/.test(e)) versions.add(e)
    }
  } catch { /* not available */ }

  // Method 2: update-alternatives (covers non-standard installs)
  if (versions.size === 0) {
    try {
      const { stdout } = await exec('update-alternatives --list php 2>/dev/null || true')
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
        await exec(`which php${v}`)
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
