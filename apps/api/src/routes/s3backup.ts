import { FastifyPluginAsync } from 'fastify'
import { promises as fs } from 'fs'
import path from 'path'
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3'

function getS3Client(settings: Record<string, string>): S3Client {
  const endpoint = settings.s3_endpoint
  return new S3Client({
    region: settings.s3_region || 'auto',
    credentials: {
      accessKeyId: settings.s3_access_key,
      secretAccessKey: settings.s3_secret_key
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {})
  })
}

async function getS3Settings(prisma: any): Promise<Record<string, string>> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ['s3_access_key', 's3_secret_key', 's3_region', 's3_bucket', 's3_endpoint'] } }
  })
  return Object.fromEntries(settings.map((s: any) => [s.key, s.value]))
}

export const s3BackupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // POST /:siteId/database/backup/s3/:filename — upload a local backup to S3/R2
  app.post('/:siteId/database/backup/s3/:filename', async (request, reply) => {
    const { siteId, filename } = request.params as { siteId: string; filename: string }

    if (!/^[\w._-]+\.sql(\.gz)?$/.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' })
    }

    const site = await app.prisma.site.findUnique({ where: { id: Number(siteId) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const s3Settings = await getS3Settings(app.prisma)
    if (!s3Settings.s3_access_key || !s3Settings.s3_secret_key || !s3Settings.s3_bucket) {
      return reply.code(400).send({ error: 'S3/R2 credentials not configured. Set them in Settings → S3 Backup.' })
    }

    const localPath = path.join(site.rootPath, 'backups', filename)
    try {
      const body = await fs.readFile(localPath)
      const client = getS3Client(s3Settings)
      const key = `backups/${site.domain}/${filename}`

      await client.send(new PutObjectCommand({
        Bucket: s3Settings.s3_bucket,
        Key: key,
        Body: body,
        ContentType: 'application/octet-stream'
      }))

      app.audit('backup.uploaded_s3', { siteId: site.id, meta: { filename, key } })
      return { ok: true, key, bucket: s3Settings.s3_bucket }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // GET /:siteId/database/backup/s3 — list remote backups
  app.get('/:siteId/database/backup/s3', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { siteId: string }).siteId) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const s3Settings = await getS3Settings(app.prisma)
    if (!s3Settings.s3_access_key || !s3Settings.s3_bucket) {
      return { files: [], configured: false }
    }

    try {
      const client = getS3Client(s3Settings)
      const result = await client.send(new ListObjectsV2Command({
        Bucket: s3Settings.s3_bucket,
        Prefix: `backups/${site.domain}/`
      }))

      const files = (result.Contents ?? []).map((obj) => ({
        key: obj.Key!,
        filename: path.basename(obj.Key!),
        sizeBytes: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? null
      })).sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''))

      return { files, configured: true, bucket: s3Settings.s3_bucket }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })

  // DELETE /:siteId/database/backup/s3/:key — delete remote backup
  app.delete('/:siteId/database/backup/s3/*', async (request, reply) => {
    const { siteId } = request.params as { siteId: string }
    const key = (request.params as any)['*']

    const site = await app.prisma.site.findUnique({ where: { id: Number(siteId) } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const s3Settings = await getS3Settings(app.prisma)
    if (!s3Settings.s3_access_key || !s3Settings.s3_bucket) {
      return reply.code(400).send({ error: 'S3/R2 not configured' })
    }

    try {
      const client = getS3Client(s3Settings)
      await client.send(new DeleteObjectCommand({ Bucket: s3Settings.s3_bucket, Key: key }))
      return { ok: true }
    } catch (err: unknown) {
      return reply.code(500).send({ error: (err as Error).message })
    }
  })
}
