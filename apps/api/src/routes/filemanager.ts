import { FastifyPluginAsync } from 'fastify'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import { execFileP } from '../lib/exec'
import { execOn, spawnOn, isLocal, ServerCtx } from '../lib/server-exec'
import { serverCtxForSite } from '../lib/servers'
import {
  readFileOn, readFileBase64On, writeFileOn, mkdirOn, statOn, remoteListDir, RemoteDirEntry
} from '../lib/server-fs'
import { shellEscape } from '../lib/ssh'

const MAX_EDIT_BYTES = 10 * 1024 * 1024 // 10 MB

// Prefix relative paths with "./" so a name beginning with "-" can never be
// misread as a command-line option by zip/tar/etc.
const optSafe = (p: string) => (p.startsWith('-') ? `./${p}` : p)

// ── Security: resolve path inside site root ────────────────────────────────────
function jail(rootPath: string, userPath: string): string {
  if (!userPath || userPath === '/' || userPath === '') return rootPath
  const clean = path.normalize('/' + String(userPath).replace(/^\/+/, ''))
  const full = path.join(rootPath, clean)
  const rel = path.relative(rootPath, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path traversal denied'), { statusCode: 403 })
  }
  return full
}

interface FileEntry {
  name: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  modified: string
  permissions: string
  permsDisplay: string
  owner: string
  group: string
  ext: string
  mime: string
}

// ── Local rich stat (unchanged behaviour) ──────────────────────────────────────
async function toEntryLocal(absPath: string, name: string): Promise<FileEntry | null> {
  try {
    const st = await fs.lstat(absPath)
    const m = st.mode
    const rwx = (n: number) => (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-')
    const permsDisplay = rwx((m >> 6) & 7) + rwx((m >> 3) & 7) + rwx(m & 7)
    const permissions = ((m >> 6) & 7).toString() + ((m >> 3) & 7).toString() + (m & 7).toString()

    let owner = String(st.uid)
    let group = String(st.gid)
    try {
      const { stdout } = await execFileP('stat', ['-c', '%U %G', absPath])
      const parts = stdout.trim().split(' ')
      if (parts[0]) owner = parts[0]
      if (parts[1]) group = parts[1]
    } catch { /* macOS */ }

    const ext = st.isFile() ? path.extname(name).toLowerCase().replace('.', '') : ''
    const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file'
    return { name, type, size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString(),
             permissions, permsDisplay, owner, group, ext, mime: extMime(ext) }
  } catch {
    return null
  }
}

// ── Remote entry (from a stat line) ─────────────────────────────────────────────
function permsDisplayFromOct(oct: string): string {
  const s = (oct || '').padStart(3, '0').slice(-3)
  const rwx = (d: string) => { const n = parseInt(d, 10) || 0; return (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-') }
  return rwx(s[0]) + rwx(s[1]) + rwx(s[2])
}
function kindToType(kind: string): 'file' | 'dir' | 'symlink' {
  if (/directory/.test(kind)) return 'dir'
  if (/symbolic link/.test(kind)) return 'symlink'
  return 'file'
}
function remoteToEntry(e: RemoteDirEntry): FileEntry {
  const type = kindToType(e.kind)
  const ext = type === 'file' ? path.extname(e.name).toLowerCase().replace('.', '') : ''
  const oct = (e.octPerms || '').padStart(3, '0').slice(-3)
  return { name: e.name, type, size: type === 'dir' ? 0 : e.size, modified: new Date(e.mtimeMs).toISOString(),
           permissions: oct, permsDisplay: permsDisplayFromOct(e.octPerms), owner: e.owner, group: e.group, ext, mime: extMime(ext) }
}
async function remoteStatEntry(ctx: ServerCtx, absPath: string, name: string): Promise<FileEntry | null> {
  const { stdout } = await execOn(ctx, 'bash', ['-lc', `stat -c '%F|%s|%Y|%a|%U|%G' ${shellEscape(absPath)}`]).catch(() => ({ stdout: '' }))
  if (!stdout.trim()) return null
  const [kind, size, mtime, oct, owner, group] = stdout.trim().split('|')
  return remoteToEntry({ name, kind: kind ?? '', size: parseInt(size, 10) || 0, mtimeMs: (parseInt(mtime, 10) || 0) * 1000, octPerms: oct ?? '', owner: owner ?? '', group: group ?? '' })
}

function extMime(ext: string): string {
  const map: Record<string, string> = {
    php:'text/x-php', js:'text/javascript', ts:'text/typescript', tsx:'text/typescript',
    jsx:'text/javascript', html:'text/html', css:'text/css', json:'application/json',
    md:'text/markdown', txt:'text/plain', xml:'text/xml', yaml:'text/yaml', yml:'text/yaml',
    sh:'text/x-sh', env:'text/plain', sql:'text/x-sql', py:'text/x-python',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
    svg:'image/svg+xml', webp:'image/webp', ico:'image/x-icon',
    pdf:'application/pdf', mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
    zip:'application/zip', 'tar':'application/x-tar', gz:'application/gzip',
    log:'text/plain', conf:'text/plain', ini:'text/plain', htaccess:'text/plain',
  }
  return map[ext] ?? 'application/octet-stream'
}

async function getSite(app: any, request: any) {
  const id = Number((request.params as { id: string }).id)
  return app.prisma.site.findUnique({ where: { id } })
}

// ── Plugin ────────────────────────────────────────────────────────────────────
export const fileManagerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  const ctxFor = (site: any) => serverCtxForSite(app.prisma, site)
  // Run a shell command on the site's server.
  const sh = (ctx: ServerCtx, cmd: string, opts: { cwd?: string; timeout?: number } = {}) =>
    execOn(ctx, 'bash', ['-lc', cmd], opts)

  // ── List directory ─────────────────────────────────────────────────────────
  app.get('/:id/files', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const q = request.query as { path?: string; hidden?: string; sort?: string; order?: string }
    const userPath = q.path ?? '/'
    const showHidden = q.hidden === '1'
    const sortBy = q.sort ?? 'name'
    const sortDir = q.order ?? 'asc'

    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    try {
      const ctx = await ctxFor(site)
      let entries: FileEntry[]
      if (isLocal(ctx)) {
        const names = await fs.readdir(absPath)
        entries = (await Promise.all(
          names.filter(n => showHidden || !n.startsWith('.')).map(n => toEntryLocal(path.join(absPath, n), n))
        )).filter((e): e is FileEntry => e !== null)
      } else {
        entries = (await remoteListDir(ctx, absPath))
          .filter(e => showHidden || !e.name.startsWith('.'))
          .map(remoteToEntry)
      }

      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (b.type === 'dir' && a.type !== 'dir') return 1
        let cmp = 0
        if (sortBy === 'size')     cmp = a.size - b.size
        else if (sortBy === 'modified') cmp = a.modified.localeCompare(b.modified)
        else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        return sortDir === 'desc' ? -cmp : cmp
      })

      const rel = path.relative(site.rootPath, absPath)
      const displayPath = rel === '' ? '/' : '/' + rel
      return { entries, path: displayPath, rootPath: site.rootPath }
    } catch (e: any) {
      return reply.code(500).send({ error: e.message })
    }
  })

  // ── Read file ──────────────────────────────────────────────────────────────
  app.get('/:id/files/read', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath } = request.query as { path?: string }
    if (!userPath) return reply.code(400).send({ error: 'path required' })

    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const ctx = await ctxFor(site)
    const st = await statOn(ctx, absPath)
    if (!st || !st.isFile) return reply.code(404).send({ error: 'File not found' })
    if (st.size > MAX_EDIT_BYTES) {
      return reply.code(413).send({ error: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB for inline editing.` })
    }

    const ext = path.extname(absPath).toLowerCase().replace('.', '')
    const mime = extMime(ext)
    const isBinary = !mime.startsWith('text/') && !['application/json','application/xml'].includes(mime)

    const content = isBinary ? await readFileBase64On(ctx, absPath) : await readFileOn(ctx, absPath)
    return { content, ext, mime, size: st.size, binary: isBinary, path: userPath }
  })

  // ── Write file ─────────────────────────────────────────────────────────────
  app.put('/:id/files/write', {
    schema: { body: { type: 'object', required: ['path', 'content'], additionalProperties: false,
      properties: { path: { type: 'string' }, content: { type: 'string', maxLength: MAX_EDIT_BYTES } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath, content } = request.body as { path: string; content: string }
    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    await writeFileOn(await ctxFor(site), absPath, content)
    app.audit('filemanager.write', { siteId: site.id, meta: { path: userPath, domain: site.domain } })
    return { ok: true }
  })

  // ── Create directory ───────────────────────────────────────────────────────
  app.post('/:id/files/mkdir', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath } = request.body as { path: string }
    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    await mkdirOn(await ctxFor(site), absPath)
    app.audit('filemanager.mkdir', { siteId: site.id, meta: { path: userPath, domain: site.domain } })
    return { ok: true }
  })

  // ── Create empty file ──────────────────────────────────────────────────────
  app.post('/:id/files/touch', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath } = request.body as { path: string }
    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    await sh(await ctxFor(site), `mkdir -p ${shellEscape(path.dirname(absPath))} && touch ${shellEscape(absPath)}`)
    app.audit('filemanager.touch', { siteId: site.id, meta: { path: userPath, domain: site.domain } })
    return { ok: true }
  })

  // ── Delete ─────────────────────────────────────────────────────────────────
  app.delete('/:id/files/delete', {
    schema: { body: { type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 500 } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths } = request.body as { paths: string[] }
    const results: { path: string; ok: boolean; error?: string }[] = []
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await sh(ctx, `rm -rf ${shellEscape(abs)}`)
        results.push({ path: p, ok: true })
      } catch (e: any) {
        results.push({ path: p, ok: false, error: e.message })
      }
    }
    app.audit('filemanager.delete', { siteId: site.id, meta: { count: paths.length, domain: site.domain } })
    return { results }
  })

  // ── Rename / Move ──────────────────────────────────────────────────────────
  app.post('/:id/files/rename', {
    schema: { body: { type: 'object', required: ['from', 'to'], additionalProperties: false,
      properties: { from: { type: 'string' }, to: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { from, to } = request.body as { from: string; to: string }
    let absFrom: string, absTo: string
    try { absFrom = jail(site.rootPath, from); absTo = jail(site.rootPath, to) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    await sh(await ctxFor(site), `mkdir -p ${shellEscape(path.dirname(absTo))} && mv -- ${shellEscape(absFrom)} ${shellEscape(absTo)}`)
    app.audit('filemanager.rename', { siteId: site.id, meta: { from, to, domain: site.domain } })
    return { ok: true }
  })

  // ── Copy ───────────────────────────────────────────────────────────────────
  app.post('/:id/files/copy', {
    schema: { body: { type: 'object', required: ['paths', 'dest'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await sh(ctx, `cp -r -- ${shellEscape(abs)} ${shellEscape(path.join(absDest, path.basename(abs)))}`)
      } catch { /* skip bad path */ }
    }
    app.audit('filemanager.copy', { siteId: site.id, meta: { count: paths.length, dest, domain: site.domain } })
    return { ok: true }
  })

  // ── Move ───────────────────────────────────────────────────────────────────
  app.post('/:id/files/move', {
    schema: { body: { type: 'object', required: ['paths', 'dest'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await sh(ctx, `mv -- ${shellEscape(abs)} ${shellEscape(path.join(absDest, path.basename(abs)))}`)
      } catch { /* skip */ }
    }
    app.audit('filemanager.move', { siteId: site.id, meta: { count: paths.length, dest, domain: site.domain } })
    return { ok: true }
  })

  // ── Zip ────────────────────────────────────────────────────────────────────
  app.post('/:id/files/zip', {
    schema: { body: { type: 'object', required: ['paths', 'dest'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const relPaths: string[] = []
    for (const p of paths) {
      try { relPaths.push(path.relative(site.rootPath, jail(site.rootPath, p))) } catch { }
    }
    const cmd = `zip -r ${shellEscape(absDest)} ${relPaths.map(r => shellEscape(optSafe(r))).join(' ')}`
    const { stdout, stderr } = await sh(await ctxFor(site), cmd, { cwd: site.rootPath, timeout: 300_000 })
      .catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))
    app.audit('filemanager.zip', { siteId: site.id, meta: { count: paths.length, dest, domain: site.domain } })
    return { ok: true, output: (stdout + stderr).trim() }
  })

  // ── Unzip ──────────────────────────────────────────────────────────────────
  app.post('/:id/files/unzip', {
    schema: { body: { type: 'object', required: ['path', 'dest'], additionalProperties: false,
      properties: { path: { type: 'string' }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath, dest } = request.body as { path: string; dest: string }
    let absPath: string, absDest: string
    try { absPath = jail(site.rootPath, userPath); absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const ctx = await ctxFor(site)
    await mkdirOn(ctx, absDest)
    const { stdout, stderr } = await sh(ctx, `unzip -o ${shellEscape(absPath)} -d ${shellEscape(absDest)}`, { timeout: 300_000 })
      .catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))
    app.audit('filemanager.unzip', { siteId: site.id, meta: { path: userPath, dest, domain: site.domain } })
    return { ok: true, output: (stdout + stderr).trim() }
  })

  // ── Tar (create tar.gz) ────────────────────────────────────────────────────
  app.post('/:id/files/tar', {
    schema: { body: { type: 'object', required: ['paths', 'dest'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const relPaths: string[] = []
    for (const p of paths) {
      try { relPaths.push(path.relative(site.rootPath, jail(site.rootPath, p))) } catch { }
    }
    await sh(await ctxFor(site), `tar -czf ${shellEscape(absDest)} -- ${relPaths.map(r => shellEscape(optSafe(r))).join(' ')}`, { cwd: site.rootPath, timeout: 300_000 })
    return { ok: true }
  })

  // ── Untar ──────────────────────────────────────────────────────────────────
  app.post('/:id/files/untar', {
    schema: { body: { type: 'object', required: ['path', 'dest'], additionalProperties: false,
      properties: { path: { type: 'string' }, dest: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath, dest } = request.body as { path: string; dest: string }
    let absPath: string, absDest: string
    try { absPath = jail(site.rootPath, userPath); absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const ctx = await ctxFor(site)
    await mkdirOn(ctx, absDest)
    const { stdout, stderr } = await sh(ctx, `tar -xf ${shellEscape(absPath)} -C ${shellEscape(absDest)}`, { timeout: 300_000 })
      .catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))
    return { ok: true, output: (stdout + stderr).trim() }
  })

  // ── chmod ──────────────────────────────────────────────────────────────────
  app.post('/:id/files/chmod', {
    schema: { body: { type: 'object', required: ['paths', 'mode'], additionalProperties: false,
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', pattern: '^[0-7]{3,4}$' },
        recursive: { type: 'boolean' }
      } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths, mode, recursive = false } = request.body as { paths: string[]; mode: string; recursive?: boolean }
    const flag = recursive ? '-R ' : ''
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await sh(ctx, `chmod ${flag}${mode} -- ${shellEscape(abs)}`)
      } catch { /* skip */ }
    }
    app.audit('filemanager.chmod', { siteId: site.id, meta: { mode, count: paths.length, domain: site.domain } })
    return { ok: true }
  })

  // ── chown ──────────────────────────────────────────────────────────────────
  app.post('/:id/files/chown', {
    schema: { body: { type: 'object', required: ['paths', 'owner'], additionalProperties: false,
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        owner: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9._-]+$' },
        group: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9._-]+$' },
        recursive: { type: 'boolean' }
      } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths, owner, group, recursive = false } = request.body as { paths: string[]; owner: string; group?: string; recursive?: boolean }
    const spec = group ? `${owner}:${group}` : owner
    const flag = recursive ? '-R ' : ''
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await sh(ctx, `chown ${flag}${spec} -- ${shellEscape(abs)}`)
      } catch { /* skip */ }
    }
    app.audit('filemanager.chown', { siteId: site.id, meta: { owner: spec, count: paths.length, domain: site.domain } })
    return { ok: true }
  })

  // ── Download file ──────────────────────────────────────────────────────────
  app.get('/:id/files/download', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath } = request.query as { path?: string }
    if (!userPath) return reply.code(400).send({ error: 'path required' })

    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const ctx = await ctxFor(site)
    const st = await statOn(ctx, absPath)
    if (!st?.isFile) return reply.code(404).send({ error: 'File not found' })

    const filename = path.basename(absPath)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    if (isLocal(ctx)) {
      reply.header('Content-Length', String(st.size))
      return reply.send(createReadStream(absPath))
    }
    const child = await spawnOn(ctx, 'cat', [absPath])
    return reply.send(child.stdout)
  })

  // ── Download as zip ────────────────────────────────────────────────────────
  app.post('/:id/files/download-zip', {
    schema: { body: { type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const { paths, name = 'download' } = request.body as { paths: string[]; name?: string }
    const relPaths: string[] = []
    for (const p of paths) {
      try { relPaths.push(path.relative(site.rootPath, jail(site.rootPath, p))) } catch { }
    }

    const tmpFile = `/tmp/fm-dl-${Date.now()}.zip`
    reply.header('Content-Disposition', `attachment; filename="${name}.zip"`)

    if (isLocal(ctx)) {
      await execFileP('zip', ['-r', tmpFile, ...relPaths.map(optSafe)], { cwd: site.rootPath, timeout: 120_000 })
      const stream = createReadStream(tmpFile)
      stream.on('close', () => { fs.unlink(tmpFile).catch(() => {}) })
      return reply.send(stream)
    }
    // Remote: build the zip on the server, stream it back, then clean up.
    await sh(ctx, `cd ${shellEscape(site.rootPath)} && zip -r ${shellEscape(tmpFile)} ${relPaths.map(r => shellEscape(optSafe(r))).join(' ')}`, { timeout: 120_000 })
    const child = await spawnOn(ctx, 'cat', [tmpFile])
    child.on('close', () => { sh(ctx, `rm -f ${shellEscape(tmpFile)}`).catch(() => {}) })
    return reply.send(child.stdout)
  })

  // ── Upload ─────────────────────────────────────────────────────────────────
  app.post('/:id/files/upload', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const ctx = await ctxFor(site)

    const q = request.query as { dest?: string; overwrite?: string }
    const dest = q.dest ?? '/'
    const overwrite = q.overwrite !== '0'

    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const files = request.files()
    const results: { filename: string; ok: boolean; size?: number; error?: string }[] = []

    for await (const data of files) {
      const filename = path.basename(data.filename)
      const destFile = path.join(absDest, filename)
      try {
        if (!overwrite) {
          const exists = (await statOn(ctx, destFile)) !== null
          if (exists) {
            results.push({ filename, ok: false, error: 'File already exists' })
            for await (const _ of data.file) { /* drain */ }
            continue
          }
        }
        await mkdirOn(ctx, absDest)
        if (isLocal(ctx)) {
          await pipeline(data.file, createWriteStream(destFile))
        } else {
          // Stream the upload straight into a file on the remote host.
          const child = await spawnOn(ctx, 'bash', ['-lc', `cat > ${shellEscape(destFile)}`])
          await pipeline(data.file, child.stdin)
          await new Promise<void>((res, rej) => { child.on('close', c => c === 0 ? res() : rej(new Error(`upload exited ${c}`))); child.on('error', rej) })
        }
        const st = await statOn(ctx, destFile)
        results.push({ filename, ok: true, size: st?.size ?? 0 })
        app.audit('filemanager.upload', { siteId: site.id, meta: { filename, dest, size: st?.size ?? 0, domain: site.domain } })
      } catch (e: any) {
        results.push({ filename, ok: false, error: e.message })
      }
    }

    return { results }
  })

  // ── Search ─────────────────────────────────────────────────────────────────
  app.get('/:id/files/search', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath = '/', q, type = 'name' } = request.query as { path?: string; q?: string; type?: string }
    if (!q?.trim()) return { results: [] }

    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const cmd = type === 'content'
      ? `grep -rl -- ${shellEscape(q)} ${shellEscape(absPath)}`
      : `find ${shellEscape(absPath)} -iname ${shellEscape('*' + q + '*')}`
    const { stdout } = await sh(await ctxFor(site), cmd, { timeout: 20_000 }).catch((e: any) => ({ stdout: e.stdout ?? '' }))
    const results = stdout.trim().split('\n').filter(Boolean).slice(0, 100).map((p: string) => ({
      path: '/' + path.relative(site.rootPath, p),
      name: path.basename(p),
      type: 'file'
    }))
    return { results }
  })

  // ── Diff two files ─────────────────────────────────────────────────────────
  app.get('/:id/files/diff', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { a, b } = request.query as { a?: string; b?: string }
    if (!a || !b) return reply.code(400).send({ error: 'a and b required' })

    let absA: string, absB: string
    try { absA = jail(site.rootPath, a); absB = jail(site.rootPath, b) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const { stdout } = await sh(await ctxFor(site), `diff -u -- ${shellEscape(absA)} ${shellEscape(absB)}`, { timeout: 10_000 })
      .catch((e: any) => ({ stdout: e.stdout ?? '' }))
    return { diff: stdout }
  })

  // ── Properties ─────────────────────────────────────────────────────────────
  app.get('/:id/files/properties', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath } = request.query as { path?: string }
    if (!userPath) return reply.code(400).send({ error: 'path required' })

    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    const ctx = await ctxFor(site)
    const entry = isLocal(ctx)
      ? await toEntryLocal(absPath, path.basename(absPath))
      : await remoteStatEntry(ctx, absPath, path.basename(absPath))
    if (!entry) return reply.code(404).send({ error: 'Not found' })

    let totalSize = entry.size
    if (entry.type === 'dir') {
      const { stdout } = await sh(ctx, `du -sb -- ${shellEscape(absPath)}`).catch((e: any) => ({ stdout: e.stdout ?? '0' }))
      totalSize = parseInt(stdout.split('\t')[0] ?? '0', 10)
    }
    return { ...entry, totalSize }
  })
}
