import { FastifyPluginAsync } from 'fastify'
import crypto from 'crypto'
import { runDeploy } from './deploy'
import { decryptSecret } from '../lib/crypto'

interface GitHubPushPayload {
  ref: string
  after: string
  repository: {
    clone_url: string
    ssh_url: string
    full_name: string
  }
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Parse JSON as raw Buffer so we can verify HMAC on exact bytes received.
  // Fastify's plugin scope keeps this parser isolated from other routes.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, payload: Buffer, done) => {
      ;(req as any).rawBody = payload
      try {
        done(null, JSON.parse(payload.toString()))
      } catch (err) {
        done(err as Error, undefined)
      }
    }
  )

  app.post('/github/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    const rawBody = (request as any).rawBody as Buffer
    const event = (request.headers['x-github-event'] as string) ?? ''
    const signature = (request.headers['x-hub-signature-256'] as string) ?? ''

    // Ping event sent when webhook is first created — acknowledge it
    if (event === 'ping') return { pong: true }

    if (event !== 'push') return { skipped: true, event }

    // Look up site by webhook token
    const site = await app.prisma.site.findFirst({ where: { webhookToken: token } })
    if (!site) return reply.code(404).send({ error: 'Unknown webhook token' })

    // Verify GitHub HMAC signature (token doubles as the webhook secret)
    const expected = 'sha256=' + crypto.createHmac('sha256', token).update(rawBody).digest('hex')
    const sigBuf = Buffer.from(signature.padEnd(expected.length, '\0'))
    const expBuf = Buffer.from(expected)
    const valid = signature.length === expected.length && crypto.timingSafeEqual(sigBuf, expBuf)
    if (!valid) return reply.code(401).send({ error: 'Invalid signature' })

    const payload = request.body as GitHubPushPayload
    const pushedBranch = payload.ref.replace('refs/heads/', '')

    if (pushedBranch !== site.branch) {
      return { skipped: true, reason: `Branch '${pushedBranch}' ≠ configured '${site.branch}'` }
    }
    if (!site.repoUrl) {
      return reply.code(400).send({ error: 'No repository URL configured for this site' })
    }
    if (site.status !== 'active') {
      return { skipped: true, reason: `Site status is '${site.status}'` }
    }

    // Prevent duplicate concurrent deploys
    const alreadyRunning = await app.prisma.deployment.findFirst({
      where: { siteId: site.id, status: 'running' }
    })
    if (alreadyRunning) {
      return { skipped: true, reason: 'Deploy already in progress' }
    }

    const deploymentId = await runDeploy(app, site.id, {
      rootPath: site.rootPath,
      repoUrl: site.repoUrl,
      branch: site.branch,
      phpVersion: site.phpVersion,
      gitToken: site.gitToken ? decryptSecret(site.gitToken) : null
    })

    return { triggered: true, deploymentId, commit: payload.after.slice(0, 7) }
  })
}
