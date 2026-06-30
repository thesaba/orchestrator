import { FastifyPluginAsync } from 'fastify'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const exec = promisify(execCb)

export const failedJobsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  function artisan(rootPath: string, phpVersion: string, cmd: string) {
    const artisanPath = path.join(rootPath, 'current', 'artisan')
    return `php${phpVersion} "${artisanPath}" ${cmd} 2>&1`
  }

  // GET /:id/failed-jobs
  app.get('/:id/failed-jobs', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    // Use artisan tinker to dump failed_jobs as JSON
    const phpScript = `echo json_encode(DB::table('failed_jobs')->orderByDesc('failed_at')->limit(50)->get()->toArray());`
    const cmd = `echo '<?php ${phpScript}' | php${site.phpVersion} "${path.join(site.rootPath, 'current', 'artisan')}" tinker --no-interaction 2>/dev/null`

    try {
      const { stdout } = await exec(cmd, {
        cwd: path.join(site.rootPath, 'current'),
        timeout: 15_000
      })
      // tinker outputs the value, might have extra output before it
      const match = stdout.match(/(\[.*\])/s)
      const jobs = match ? JSON.parse(match[1]) : []
      return { jobs }
    } catch {
      // Fallback: parse artisan queue:failed text output
      try {
        const { stdout: listOut } = await exec(artisan(site.rootPath, site.phpVersion, 'queue:failed'), {
          timeout: 15_000
        })
        const lines = listOut.split('\n').filter((l) => l.includes('|'))
        const jobs = lines.slice(2).map((line) => {
          const parts = line.split('|').map((s) => s.trim()).filter(Boolean)
          return parts.length >= 3
            ? { id: parts[0], connection: parts[1], queue: parts[2], class: parts[3], failed_at: parts[4] }
            : null
        }).filter(Boolean)
        return { jobs }
      } catch {
        return { jobs: [] }
      }
    }
  })

  // POST /:id/failed-jobs/:jobId/retry
  app.post('/:id/failed-jobs/:jobId/retry', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string; jobId: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const { jobId } = request.params as { jobId: string }

    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return reply.code(400).send({ error: 'Invalid job ID' })

    try {
      const { stdout } = await exec(
        artisan(site.rootPath, site.phpVersion, `queue:retry ${jobId}`),
        { timeout: 15_000 }
      )
      app.audit('queue.retry', { siteId: site.id, meta: { jobId } })
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // DELETE /:id/failed-jobs/:jobId
  app.delete('/:id/failed-jobs/:jobId', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string; jobId: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    const { jobId } = request.params as { jobId: string }

    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) return reply.code(400).send({ error: 'Invalid job ID' })

    try {
      await exec(artisan(site.rootPath, site.phpVersion, `queue:forget ${jobId}`), { timeout: 10_000 })
      return { ok: true }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // DELETE /:id/failed-jobs — flush all
  app.delete('/:id/failed-jobs', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    try {
      const { stdout } = await exec(
        artisan(site.rootPath, site.phpVersion, 'queue:flush'),
        { timeout: 10_000 }
      )
      app.audit('queue.flush', { siteId: site.id, meta: { domain: site.domain } })
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // POST /:id/failed-jobs/retry-all
  app.post('/:id/failed-jobs/retry-all', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    try {
      const { stdout } = await exec(
        artisan(site.rootPath, site.phpVersion, 'queue:retry all'),
        { timeout: 15_000 }
      )
      app.audit('queue.retry_all', { siteId: site.id })
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}
