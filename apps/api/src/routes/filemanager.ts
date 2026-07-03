import { FastifyPluginAsync } from 'fastify'
import { promises as fs, createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import path from 'path'
import { execFileP } from '../lib/exec'

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

// ── File stat helper ───────────────────────────────────────────────────────────
interface FileEntry {
  name: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  modified: string
  permissions: string   // octal e.g. "755"
  permsDisplay: string  // e.g. "rwxr-xr-x"
  owner: string
  group: string
  ext: string
  mime: string
}

async function toEntry(absPath: string, name: string): Promise<FileEntry | null> {
  try {
    const st = await fs.lstat(absPath)
    const m = st.mode
    const rwx = (n: number) =>
      (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-')
    const permsDisplay = rwx((m >> 6) & 7) + rwx((m >> 3) & 7) + rwx(m & 7)
    const permissions = ((m >> 6) & 7).toString() + ((m >> 3) & 7).toString() + (m & 7).toString()

    let owner = String(st.uid)
    let group = String(st.gid)
    try {
      // execFile (argv, no shell) — the path can never be interpreted as a command.
      const { stdout } = await execFileP('stat', ['-c', '%U %G', absPath])
      const parts = stdout.trim().split(' ')
      if (parts[0]) owner = parts[0]
      if (parts[1]) group = parts[1]
    } catch { /* ignore — stat may not support -c on macOS */ }

    const ext = st.isFile() ? path.extname(name).toLowerCase().replace('.', '') : ''
    const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file'
    return { name, type, size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString(),
             permissions, permsDisplay, owner, group, ext, mime: extMime(ext) }
  } catch {
    return null
  }
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

// ── Route helper ───────────────────────────────────────────────────────────────
async function getSite(app: any, request: any) {
  const id = Number((request.params as { id: string }).id)
  return app.prisma.site.findUnique({ where: { id } })
}

// ── Plugin ────────────────────────────────────────────────────────────────────
export const fileManagerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

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
      const names = await fs.readdir(absPath)
      const entries = (
        await Promise.all(
          names
            .filter(n => showHidden || !n.startsWith('.'))
            .map(n => toEntry(path.join(absPath, n), n))
        )
      ).filter((e): e is FileEntry => e !== null)

      entries.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1
        if (b.type === 'dir' && a.type !== 'dir') return 1
        let cmp = 0
        if (sortBy === 'size')     cmp = a.size - b.size
        else if (sortBy === 'modified') cmp = a.modified.localeCompare(b.modified)
        else cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        return sortDir === 'desc' ? -cmp : cmp
      })

      // Compute display path
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

    const st = await fs.stat(absPath).catch(() => null)
    if (!st || !st.isFile()) return reply.code(404).send({ error: 'File not found' })
    if (st.size > MAX_EDIT_BYTES) {
      return reply.code(413).send({ error: `File too large (${(st.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB for inline editing.` })
    }

    const ext = path.extname(absPath).toLowerCase().replace('.', '')
    const mime = extMime(ext)
    const isBinary = !mime.startsWith('text/') && !['application/json','application/xml'].includes(mime)

    const content = await fs.readFile(absPath, isBinary ? 'base64' : 'utf-8')
    return { content, ext, mime, size: st.size, binary: isBinary, path: userPath }
  })

  // ── Write file ─────────────────────────────────────────────────────────────
  app.put('/:id/files/write', {
    schema: {
      body: { type: 'object', required: ['path', 'content'], additionalProperties: false,
        properties: { path: { type: 'string' }, content: { type: 'string', maxLength: MAX_EDIT_BYTES } }
      }
    }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { path: userPath, content } = request.body as { path: string; content: string }
    let absPath: string
    try { absPath = jail(site.rootPath, userPath) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, 'utf-8')
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

    await fs.mkdir(absPath, { recursive: true })
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

    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const fd = await fs.open(absPath, 'a')
    await fd.close()
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

    const { paths } = request.body as { paths: string[] }
    const results: { path: string; ok: boolean; error?: string }[] = []
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        await fs.rm(abs, { recursive: true, force: true })
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

    await fs.mkdir(path.dirname(absTo), { recursive: true })
    await fs.rename(absFrom, absTo).catch(async () => {
      // Cross-device fallback: copy then remove (argv-safe, no shell).
      await execFileP('mv', ['--', absFrom, absTo])
    })
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

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        const target = path.join(absDest, path.basename(abs))
        await fs.cp(abs, target, { recursive: true })
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

    const { paths, dest } = request.body as { paths: string[]; dest: string }
    let absDest: string
    try { absDest = jail(site.rootPath, dest) }
    catch (e: any) { return reply.code(403).send({ error: e.message }) }

    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        const target = path.join(absDest, path.basename(abs))
        await fs.rename(abs, target).catch(() => execFileP('mv', ['--', abs, target]))
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
    const { stdout, stderr } = await execFileP(
      'zip', ['-r', absDest, ...relPaths.map(optSafe)],
      { cwd: site.rootPath, timeout: 300_000 }
    ).catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))

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

    await fs.mkdir(absDest, { recursive: true })
    const { stdout, stderr } = await execFileP(
      'unzip', ['-o', absPath, '-d', absDest],
      { timeout: 300_000 }
    ).catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))

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
    await execFileP(
      'tar', ['-czf', absDest, '--', ...relPaths.map(optSafe)],
      { cwd: site.rootPath, timeout: 300_000 }
    )
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

    await fs.mkdir(absDest, { recursive: true })
    const { stdout, stderr } = await execFileP(
      'tar', ['-xf', absPath, '-C', absDest],
      { timeout: 300_000 }
    ).catch((e: any) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }))

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

    const { paths, mode, recursive = false } = request.body as { paths: string[]; mode: string; recursive?: boolean }
    const flags = recursive ? ['-R'] : []
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        // mode is schema-validated (^[0-7]{3,4}$); argv (no shell) makes abs inert.
        await execFileP('chmod', [...flags, mode, '--', abs])
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

    const { paths, owner, group, recursive = false } = request.body as { paths: string[]; owner: string; group?: string; recursive?: boolean }
    const spec = group ? `${owner}:${group}` : owner
    const flags = recursive ? ['-R'] : []
    for (const p of paths) {
      try {
        const abs = jail(site.rootPath, p)
        // owner/group are schema-validated ([a-zA-Z0-9._-]); argv (no shell).
        await execFileP('chown', [...flags, spec, '--', abs])
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

    const st = await fs.stat(absPath).catch(() => null)
    if (!st || !st.isFile()) return reply.code(404).send({ error: 'File not found' })

    const filename = path.basename(absPath)
    reply.header('Content-Disposition', `attachment; filename="${filename}"`)
    reply.header('Content-Length', String(st.size))
    return reply.send(createReadStream(absPath))
  })

  // ── Download as zip ────────────────────────────────────────────────────────
  app.post('/:id/files/download-zip', {
    schema: { body: { type: 'object', required: ['paths'], additionalProperties: false,
      properties: { paths: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } } } }
  }, async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const { paths, name = 'download' } = request.body as { paths: string[]; name?: string }
    const relPaths: string[] = []
    for (const p of paths) {
      try { relPaths.push(path.relative(site.rootPath, jail(site.rootPath, p))) } catch { }
    }

    const tmpFile = `/tmp/fm-dl-${Date.now()}.zip`
    await execFileP(
      'zip', ['-r', tmpFile, ...relPaths.map(optSafe)],
      { cwd: site.rootPath, timeout: 120_000 }
    )

    reply.header('Content-Disposition', `attachment; filename="${name}.zip"`)
    const stream = createReadStream(tmpFile)
    stream.on('close', () => { fs.unlink(tmpFile).catch(() => {}) })
    return reply.send(stream)
  })

  // ── Upload ─────────────────────────────────────────────────────────────────
  app.post('/:id/files/upload', async (request, reply) => {
    const site = await getSite(app, request)
    if (!site) return reply.code(404).send({ error: 'Site not found' })

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
          const exists = await fs.access(destFile).then(() => true).catch(() => false)
          if (exists) {
            results.push({ filename, ok: false, error: 'File already exists' })
            // consume stream
            for await (const _ of data.file) { /* noop */ }
            continue
          }
        }
        await fs.mkdir(absDest, { recursive: true })
        await pipeline(data.file, createWriteStream(destFile))
        const st = await fs.stat(destFile)
        results.push({ filename, ok: true, size: st.size })
        app.audit('filemanager.upload', { siteId: site.id, meta: { filename, dest, size: st.size, domain: site.domain } })
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

    // execFile (argv, no shell): the query and path are inert data. `--` stops
    // a query/path starting with "-" from being parsed as an option.
    const { stdout } = await (type === 'content'
      ? execFileP('grep', ['-rl', '--', q, absPath], { timeout: 20_000 })
      : execFileP('find', [absPath, '-iname', `*${q}*`], { timeout: 20_000 })
    ).catch((e: any) => ({ stdout: e.stdout ?? '' }))
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

    // diff exits 1 when files differ (normal) — read stdout off the error too.
    const { stdout } = await execFileP('diff', ['-u', '--', absA, absB], { timeout: 10_000 })
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

    const entry = await toEntry(absPath, path.basename(absPath))
    if (!entry) return reply.code(404).send({ error: 'Not found' })

    // For directories, get total size
    let totalSize = entry.size
    if (entry.type === 'dir') {
      const { stdout } = await execFileP('du', ['-sb', '--', absPath])
        .catch((e: any) => ({ stdout: e.stdout ?? '0' }))
      totalSize = parseInt(stdout.split('\t')[0] ?? '0', 10)
    }

    return { ...entry, totalSize }
  })
}
