import { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { spawn, exec as execCb } from 'child_process'
import { EventEmitter } from 'events'
import { promises as fs } from 'fs'
import { promisify } from 'util'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import os from 'os'
import { notifyDeploy } from '../lib/notify'
import { createNotification } from '../lib/notifications'
import { decryptSecret, encryptSecret } from '../lib/crypto'
import { isValidGitUrl, execFileP } from '../lib/exec'
import { parseTestSummary } from '../lib/test-parse'
import { spawnOn, execOn, isLocal, ServerCtx } from '../lib/server-exec'
import { serverCtxById, serverCtxForSite } from '../lib/servers'
import { ensureScriptsSynced } from '../lib/server-sync'
import { shellEscape } from '../lib/ssh'

const exec = promisify(execCb)

const deployEmitters  = new Map<number, EventEmitter>()
const deployLogBuffers = new Map<number, string[]>()
// Child process handle for the currently-running deploy on a site, so a
// stuck/hung deploy (e.g. a network stall mid `git clone`/`composer install`,
// which never emits `close`) can be killed manually or by the watchdog below.
const deployProcs = new Map<number, ReturnType<typeof spawn>>()

// Max time a single deploy is allowed to run before it's killed and marked
// failed. Without this, a hung child process (no network timeout in deploy.sh)
// leaves the Deployment row stuck on 'running' forever and blocks every
// future deploy for that site (deployEmitters never clears). Override via
// DEPLOY_TIMEOUT_MS env if some sites legitimately need longer builds.
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS ?? 25 * 60_000)

// How often to flush the in-memory log buffer to the DB while a deploy is
// running. Without this, `Deployment.log` is only ever written once, in the
// close handler — so a stuck deploy (or an API restart mid-deploy) leaves the
// log column empty/null forever, even though lines were actually produced.
const LOG_FLUSH_INTERVAL_MS = 5_000

// Called from index.ts on SIGTERM/SIGINT (i.e. `systemctl restart`, or any
// graceful shutdown) before the process exits. `spawn(..., { detached: true })`
// means a deploy's child process (deploy.sh, and whatever it execs — git,
// composer, npm/vite, artisan migrate) survives the API process dying; if we
// don't kill it here, it keeps running in the background as a "ghost" deploy
// that can finish the symlink swap and migrations *after* the next API startup
// has already marked its Deployment row 'failed' via reconcileOrphanedDeployments
// — meaning the panel says the deploy failed while the site was actually,
// silently, fully redeployed underneath it. Killing the whole process group
// here keeps reality consistent with the 'failed' status the row will get.
export function killAllRunningDeploys(app: FastifyInstance) {
  for (const [siteId, proc] of deployProcs) {
    app.log.warn(`Killing in-flight deploy for site ${siteId} due to API shutdown.`)
    try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {/* already gone */} }
  }
}

// On API startup, any Deployment row still 'running' is guaranteed orphaned —
// deployEmitters/deployProcs/deployLogBuffers are in-memory only, so nothing
// from a previous process lifetime can still be tracking it. Mark these
// failed (rather than leaving them stuck forever) and, if the owning site had
// a deploy queued behind it, kick that off now instead of leaving it blocked.
//
// 'pending' rows are included too: an older, now-removed version of the
// redeploy endpoint used to insert a 'pending' Deployment row and never
// actually start a deploy. Nothing in the codebase has ever processed
// 'pending' deployments, so any row in that state is dead — pre-existing
// data left over from before this fix, not something the current code
// produces. Sweep them up the same way so they don't sit stuck forever.
export async function reconcileOrphanedDeployments(app: FastifyInstance) {
  const orphaned = await app.prisma.deployment.findMany({ where: { status: { in: ['running', 'pending'] } } })
  if (orphaned.length === 0) return

  for (const d of orphaned) {
    const note = d.status === 'pending'
      ? '\n[orchestrator] This deployment was created by a since-fixed bug in the Redeploy button and was never actually started. Marked as failed; please redeploy.\n'
      : '\n[orchestrator] Deploy was interrupted — the API process restarted while this deploy was still running. Marked as failed; please redeploy.\n'
    await app.prisma.deployment.update({
      where: { id: d.id },
      data: { status: 'failed', log: (d.log ?? '') + note }
    })
    app.audit('deploy.orphaned', { siteId: d.siteId, meta: { deploymentId: d.id, wasStatus: d.status } })

    const site = await app.prisma.site.findUnique({ where: { id: d.siteId } })
    if (site?.deployQueued && site.repoUrl) {
      await app.prisma.site.update({ where: { id: site.id }, data: { deployQueued: false } })
      runDeploy(app, site.id, {
        rootPath: site.rootPath,
        repoUrl: site.repoUrl,
        branch: site.branch,
        phpVersion: site.phpVersion,
        domain: site.domain,
        gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
        healthCheck: site.healthCheck,
        healthCheckUrl: site.healthCheckUrl,
        serverId: site.serverId,
        preDeploy: site.preDeploy,
        postDeploy: site.postDeploy,
        ...siteTestOpts(site)
      }).catch(() => {/* best effort */})
    }
  }

  app.log.warn(`Reconciled ${orphaned.length} orphaned 'running' deployment(s) left over from a previous process lifetime.`)
}

function scriptsDir(): string {
  const dir = process.env.SCRIPTS_DIR
  if (!dir) return path.resolve(__dirname, '../../../../scripts')
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
}

function buildAuthenticatedUrl(repoUrl: string, token?: string | null): string {
  if (!token) return repoUrl
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return repoUrl
    url.username = token
    return url.toString()
  } catch { return repoUrl }
}

// Write a hook script (called before runDeploy so deploy.sh can source it).
// Server-aware: local writes with fs (unchanged); remote writes over SSH by
// base64-piping the content so no shell-escaping of the body is needed.
async function writeHookOn(ctx: ServerCtx, rootPath: string, name: string, content: string | null) {
  const dir = path.join(rootPath, 'hooks')
  const file = path.join(dir, name)
  const body = content?.trim() ? `#!/usr/bin/env bash\nset -euo pipefail\n\n${content}\n` : null

  if (isLocal(ctx)) {
    if (body) {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(file, body, { mode: 0o755 })
    } else {
      await fs.unlink(file).catch(() => {/* not present — ok */})
    }
    return
  }
  // Remote.
  if (body) {
    const b64 = Buffer.from(body, 'utf8').toString('base64')
    const script = `mkdir -p ${shellEscape(dir)} && printf %s ${shellEscape(b64)} | base64 -d > ${shellEscape(file)} && chmod 755 ${shellEscape(file)}`
    await execOn(ctx, 'bash', ['-lc', script])
  } else {
    await execOn(ctx, 'bash', ['-lc', `rm -f ${shellEscape(file)}`]).catch(() => {})
  }
}

// Back-compat wrapper for the local-only call sites (kept for clarity).
async function writeHook(rootPath: string, name: string, content: string | null) {
  return writeHookOn(null, rootPath, name, content)
}

// HTTP health check — returns true if site responds with < 500
async function healthCheckSite(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; statusCode: number | null }> {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `http://${url}`)
      const lib = parsed.protocol === 'https:' ? require('https') : http
      const req = lib.get(parsed.href, { timeout: timeoutMs }, (res: any) => {
        const ok = res.statusCode < 500
        resolve({ ok, statusCode: res.statusCode })
        res.destroy()
      })
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, statusCode: null }) })
      req.on('error',   () => { resolve({ ok: false, statusCode: null }) })
    } catch {
      resolve({ ok: false, statusCode: null })
    }
  })
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

// Maps a site's persisted test configuration onto runDeploy opts. Kept as a
// helper so every call site (manual, queued, webhook, redeploy) stays in sync
// and existing sites — whose runTests defaults to false — deploy unchanged.
// Param is intentionally `any`: it's always a Prisma Site row, and typing it
// structurally would trip TS's weak-type check before `prisma generate` runs.
export function siteTestOpts(site: any): {
  runTests: boolean
  testCommand?: string
  testFailureMode?: string
  testTimeout?: number
  testUseSqlite?: boolean
} {
  return {
    runTests: site.runTests ?? false,
    testCommand: site.testCommand ?? undefined,
    testFailureMode: site.testFailureMode ?? undefined,
    testTimeout: site.testTimeout ?? undefined,
    testUseSqlite: site.testUseSqlite ?? undefined
  }
}

export async function runDeploy(
  app: FastifyInstance,
  siteId: number,
  opts: {
    rootPath: string
    repoUrl: string
    branch: string
    phpVersion: string
    domain?: string
    gitToken?: string | null
    healthCheck?: boolean
    healthCheckUrl?: string | null
    runTests?: boolean
    testCommand?: string
    testFailureMode?: string
    testTimeout?: number
    testUseSqlite?: boolean
    skipTests?: boolean // one-off emergency override (bypasses runTests)
    ref?: string        // deploy a specific tag/branch/commit instead of branch HEAD
    serverId?: number | null // which server to deploy on (null/undefined = local)
    preDeploy?: string | null
    postDeploy?: string | null
  }
): Promise<number> {
  if (deployEmitters.has(siteId)) {
    throw Object.assign(new Error('Deploy already in progress'), { code: 409 })
  }

  // Resolve the target server. null → local (original path). For a remote server
  // we make sure the bash scripts are present on it first, then stream the same
  // deploy.sh over SSH.
  const serverCtx = await serverCtxById(app.prisma, opts.serverId ?? null)
  const localServer = isLocal(serverCtx)
  const synced = await ensureScriptsSynced(app.prisma, opts.serverId ?? null)
  const deployScript = `${synced.scriptsDir}/deploy.sh`

  // Hooks live under <rootPath>/hooks on whichever host the deploy runs on.
  await writeHookOn(serverCtx, opts.rootPath, 'pre-deploy.sh', opts.preDeploy ?? null)
  await writeHookOn(serverCtx, opts.rootPath, 'post-deploy.sh', opts.postDeploy ?? null)

  const deployment = await app.prisma.deployment.create({
    data: { siteId, branch: opts.branch, status: 'running' }
  })

  const emitter = new EventEmitter()
  emitter.setMaxListeners(20)
  deployEmitters.set(siteId, emitter)
  deployLogBuffers.set(deployment.id, [])

  const authenticatedRepoUrl = buildAuthenticatedUrl(opts.repoUrl, opts.gitToken)
  const sanitize = (line: string) =>
    opts.gitToken ? line.split(opts.gitToken).join('***') : line

  // Tests run only when enabled for the site AND not overridden by a one-off
  // "deploy without tests". These are passed via env (like REPO_URL) so they
  // never appear in `ps`; when RUN_TESTS is absent/0 deploy.sh skips the whole
  // test block, keeping existing sites' behaviour identical.
  const testsEnabled = !!opts.runTests && !opts.skipTests
  const testEnv: Record<string, string> = testsEnabled
    ? {
        RUN_TESTS: '1',
        TEST_COMMAND: opts.testCommand || 'php artisan test',
        TEST_FAILURE_MODE: opts.testFailureMode === 'warn' ? 'warn' : 'block',
        TEST_TIMEOUT: String(opts.testTimeout && opts.testTimeout > 0 ? opts.testTimeout : 300),
        TEST_USE_SQLITE: opts.testUseSqlite === false ? '0' : '1'
      }
    : {}

  const envMap: Record<string, string> = {
    REPO_URL: authenticatedRepoUrl, ...testEnv, ...(opts.ref ? { REF: opts.ref } : {})
  }

  let proc
  if (localServer) {
    // Local: spawn bash directly. env goes in the process environment (not argv),
    // so the git token never appears in `ps`. detached → we can kill the whole
    // process group (git/composer/npm children). Identical to the original path.
    proc = await spawnOn(serverCtx, 'bash', [deployScript, opts.rootPath, opts.branch, opts.phpVersion], { env: envMap, detached: true })
  } else {
    // Remote: to keep secrets (REPO_URL with token) out of the remote `ps` and
    // the ssh argv, write the env to a 0600 file on the server, source+delete it,
    // then exec deploy.sh. Only the escaped env FILE briefly holds the token.
    const envContent = Object.entries(envMap).map(([k, v]) => `export ${k}=${shellEscape(v)}`).join('\n') + '\n'
    const b64 = Buffer.from(envContent, 'utf8').toString('base64')
    const envFile = `/tmp/orch-env-${deployment.id}`
    await execOn(serverCtx, 'bash', ['-lc', `printf %s ${shellEscape(b64)} | base64 -d > ${shellEscape(envFile)} && chmod 600 ${shellEscape(envFile)}`])
    const runScript =
      `set -a; . ${shellEscape(envFile)}; rm -f ${shellEscape(envFile)}; ` +
      `exec bash ${shellEscape(deployScript)} ${shellEscape(opts.rootPath)} ${shellEscape(opts.branch)} ${shellEscape(opts.phpVersion)}`
    proc = await spawnOn(serverCtx, 'bash', ['-lc', runScript], { tty: true })
  }
  deployProcs.set(siteId, proc)

  const startedAt = Date.now()
  let commitHash = ''
  let commitMessage: string | null = null
  let commitAuthor: string | null = null
  // Test outcome reported by deploy.sh via a __TESTS__ marker. 'skipped' when a
  // tests-enabled site was deployed with the emergency override.
  let testResult: string | null = opts.runTests && opts.skipTests ? 'skipped' : null
  const addLine = (raw: string) => {
    const line = sanitize(raw)
    deployLogBuffers.get(deployment.id)!.push(line)
    emitter.emit('log', line)
    const m = line.match(/__COMMIT__:([a-f0-9]+)/)
    if (m) commitHash = m[1]
    const cm = line.match(/__COMMIT_MSG__:(.*)/)
    if (cm) commitMessage = cm[1].trim() || null
    const ca = line.match(/__COMMIT_AUTHOR__:(.*)/)
    if (ca) commitAuthor = ca[1].trim() || null
    const t = line.match(/__TESTS__:(passed|failed)/)
    if (t) testResult = t[1]
  }

  proc.stdout?.on('data', (c: Buffer) => addLine(c.toString()))
  proc.stderr?.on('data', (c: Buffer) => addLine(c.toString()))

  // Periodically flush the log buffer to the DB so it survives a stuck
  // deploy or an API restart instead of only being written on close.
  const flushInterval = setInterval(() => {
    const buf = deployLogBuffers.get(deployment.id)
    if (!buf) return
    app.prisma.deployment.update({ where: { id: deployment.id }, data: { log: buf.join('') } }).catch(() => {})
  }, LOG_FLUSH_INTERVAL_MS)

  let timedOut = false
  let finished = false
  const watchdog = setTimeout(() => {
    if (finished) return
    timedOut = true
    addLine(`\n[orchestrator] ✗ Deploy exceeded ${Math.round(DEPLOY_TIMEOUT_MS / 60_000)}m timeout — likely a network stall (git clone / composer / npm install hung). Killing process...\n`)
    try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {/* already gone */} }
  }, DEPLOY_TIMEOUT_MS)

  proc.on('close', async (code) => {
    finished = true
    clearTimeout(watchdog)
    clearInterval(flushInterval)
    deployProcs.delete(siteId)
    let status: 'success' | 'failed' = code === 0 && !timedOut ? 'success' : 'failed'

    // ── Health check after successful deploy ─────────────────────────────────
    if (status === 'success' && opts.healthCheck) {
      const url = opts.healthCheckUrl || `http://${opts.domain}/`
      addLine(`\n[health] Checking ${url} (3 attempts, 5s apart)...\n`)

      let passed = false
      for (let i = 1; i <= 3; i++) {
        if (i > 1) await sleep(5_000)
        const result = await healthCheckSite(url)
        addLine(`[health] Attempt ${i}: HTTP ${result.statusCode ?? 'timeout'} — ${result.ok ? 'OK' : 'FAIL'}\n`)
        if (result.ok) { passed = true; break }
      }

      if (!passed) {
        addLine(`\n[health] ✗ Health check failed — initiating auto-rollback...\n`)
        status = 'failed'

        // Rollback to the previous release (current symlink now points to the
        // just-made one). Runs on whichever host the site lives on.
        try {
          if (localServer) {
            const currentPath = path.join(opts.rootPath, 'current')
            const releasePath = await fs.readlink(currentPath)
            const releaseName = path.basename(releasePath)
            const releasesDir = path.join(opts.rootPath, 'releases')
            const entries = (await fs.readdir(releasesDir)).sort().reverse()
            const prevRelease = entries.find((e) => e !== releaseName)
            if (prevRelease) {
              const prevPath = path.join(releasesDir, prevRelease)
              await exec(`ln -sfn "${prevPath}" "${currentPath}"`)
              addLine(`[health] ✓ Rolled back to release ${prevRelease}\n`)
              app.audit('deploy.health_rollback', { siteId, meta: { domain: opts.domain, release: prevRelease } })
            } else {
              addLine(`[health] ⚠ No previous release to roll back to\n`)
            }
          } else {
            // Remote: do the same swap in one SSH command.
            const rb =
              `cd ${shellEscape(opts.rootPath)} && cur=$(readlink current 2>/dev/null) && rel=$(basename "$cur") && ` +
              `prev=$(ls -1 releases 2>/dev/null | sort -r | grep -vx "$rel" | head -1); ` +
              `if [ -n "$prev" ]; then ln -sfn "releases/$prev" current && echo "ROLLED:$prev"; else echo "NOPREV"; fi`
            const { stdout } = await execOn(serverCtx, 'bash', ['-lc', rb])
            const mm = stdout.match(/ROLLED:(.+)/)
            if (mm) {
              addLine(`[health] ✓ Rolled back to release ${mm[1].trim()}\n`)
              app.audit('deploy.health_rollback', { siteId, meta: { domain: opts.domain, release: mm[1].trim() } })
            } else {
              addLine(`[health] ⚠ No previous release to roll back to\n`)
            }
          }
        } catch (rbErr: unknown) {
          addLine(`[health] ✗ Auto-rollback failed: ${(rbErr as Error).message}\n`)
        }
      } else {
        addLine(`[health] ✓ Health check passed\n`)
      }
    }

    const log = deployLogBuffers.get(deployment.id)!.join('')

    // Extract test counts/duration from the runner summary when tests ran
    // (best-effort; nulls if unparseable). testResult itself comes from the
    // __TESTS__ marker / exit code and is always reliable.
    const m = (testResult === 'passed' || testResult === 'failed')
      ? parseTestSummary(log)
      : { passed: null, failed: null, total: null, durationMs: null }

    await app.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status, log, commit: commitHash || null, testResult,
        testsPassed: m.passed, testsFailed: m.failed, testsTotal: m.total, testDurationMs: m.durationMs
      }
    })

    app.audit(`deploy.${status}`, {
      siteId,
      meta: { domain: opts.domain, branch: opts.branch, commit: commitHash || null, testResult }
    })

    if (opts.domain) {
      notifyDeploy(app, {
        domain: opts.domain, branch: opts.branch, commit: commitHash || null, status, siteId,
        testResult,
        durationMs: Date.now() - startedAt,
        commitMessage, commitAuthor,
        testsPassed: m.passed, testsFailed: m.failed, testsTotal: m.total
      })
    }

    // In-app notification (bell feed) for every deploy result.
    createNotification(app, {
      type: 'deploy',
      level: status === 'success' ? 'success' : 'critical',
      title: `Deploy ${status === 'success' ? 'succeeded' : 'failed'}${opts.domain ? ` — ${opts.domain}` : ''}`,
      body: commitHash ? `${opts.branch} @ ${commitHash}${commitMessage ? ` — ${commitMessage}` : ''}` : opts.branch,
      meta: { siteId, domain: opts.domain }
    })

    emitter.emit('done', status)
    deployEmitters.delete(siteId)
    setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60_000)

    // ── Deploy queue: kick off the queued deploy if any ──────────────────────
    const fresh = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (fresh?.deployQueued) {
      await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: false } })
      setTimeout(async () => {
        try {
          const site = await app.prisma.site.findUnique({ where: { id: siteId } })
          if (!site?.repoUrl) return
          await runDeploy(app, siteId, {
            rootPath: site.rootPath,
            repoUrl: site.repoUrl,
            branch: site.branch,
            phpVersion: site.phpVersion,
            domain: site.domain,
            gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
            healthCheck: site.healthCheck,
            healthCheckUrl: site.healthCheckUrl,
            serverId: site.serverId,
            preDeploy: site.preDeploy,
            postDeploy: site.postDeploy,
            ...siteTestOpts(site)
          })
        } catch { /* queued deploy failed to start — ignore */ }
      }, 2_000)
    }
  })

  return deployment.id
}

export const deployRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate)
  app.addHook('preHandler', app.requireSiteAccess())

  // GET /:id/test-stats — aggregated test analytics for a site's recent deploys.
  app.get('/:id/test-stats', async (request) => {
    const siteId = Number((request.params as { id: string }).id)

    // Consider only deploys that actually ran tests (result passed/failed).
    const runs = await app.prisma.deployment.findMany({
      where: { siteId, testResult: { in: ['passed', 'failed'] } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, commit: true, testResult: true, createdAt: true,
        testsPassed: true, testsFailed: true, testsTotal: true, testDurationMs: true
      }
    })

    const passedCount = runs.filter((r) => r.testResult === 'passed').length
    const durations = runs.map((r) => r.testDurationMs).filter((d): d is number => typeof d === 'number')
    const avgDurationMs = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null

    return {
      totalRuns: runs.length,
      passRate: runs.length ? Math.round((passedCount / runs.length) * 100) : null,
      avgDurationMs,
      lastRun: runs[0] ?? null,
      // Oldest → newest for charting.
      trend: [...runs].reverse().map((r) => ({
        date: r.createdAt,
        result: r.testResult,
        passed: r.testsPassed,
        failed: r.testsFailed,
        total: r.testsTotal
      }))
    }
  })

  // GET /:id/deploy/pending — commits on the remote branch not yet deployed.
  // On-demand blob-less bare clone to compute the log without a checkout;
  // cleaned up immediately. Read-only — never touches the live site.
  app.get('/:id/deploy/pending', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.repoUrl) return reply.code(400).send({ error: 'No repository URL configured' })

    const url = buildAuthenticatedUrl(site.repoUrl, site.gitToken ? decryptSecret(site.gitToken) : null)
    const last = await app.prisma.deployment.findFirst({
      where: { siteId, status: 'success', commit: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { commit: true }
    })

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-pending-'))
    const FMT = '--pretty=format:%H%x1f%s%x1f%an%x1f%aI'
    const parse = (out: string) => out.split('\n').filter(Boolean).map((line) => {
      const [hash, subject, author, date] = line.split('\x1f')
      return { hash: (hash ?? '').slice(0, 7), subject: subject ?? '', author: author ?? '', date: date ?? '' }
    })
    try {
      await execFileP('git', ['clone', '--bare', '--filter=blob:none', '--single-branch', '--branch', site.branch, url, tmp], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })
      const remoteCommit = (await execFileP('git', ['-C', tmp, 'rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim().slice(0, 7)

      let commits: ReturnType<typeof parse> = []
      let range = false
      if (last?.commit) {
        try {
          const { stdout } = await execFileP('git', ['-C', tmp, 'log', `${last.commit}..HEAD`, FMT, '-n', '50'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
          commits = parse(stdout); range = true
        } catch { /* last commit not an ancestor (force-push/unrelated) — fall back */ }
      }
      if (!range) {
        const { stdout } = await execFileP('git', ['-C', tmp, 'log', FMT, '-n', '20'], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })
        commits = parse(stdout)
      }
      return { branch: site.branch, currentCommit: last?.commit ?? null, remoteCommit, upToDate: last?.commit === remoteCommit, range, commits }
    } catch (err: unknown) {
      return reply.code(502).send({ error: `Could not read the remote: ${(err as Error).message}` })
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  })

  // POST /:id/deploy?skipTests=1 — trigger deploy (or queue if one is running).
  // skipTests is a one-off emergency override that bypasses the site's test gate
  // for this deploy only (e.g. urgent hotfix); the site setting is untouched.
  app.post('/:id/deploy', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const q = request.query as { skipTests?: string; ref?: string }
    const skipTests = q.skipTests === '1'
    // Optional ref (tag/branch/commit). Validated to a safe git ref shape so it
    // can never inject shell/option args (it's also passed via env, not argv).
    const ref = q.ref && /^[A-Za-z0-9._/\-]{1,100}$/.test(q.ref) ? q.ref : undefined

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.repoUrl) return reply.code(400).send({ error: 'No repository URL configured' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    // Hook scripts are written inside runDeploy on the correct (local/remote) host.

    // If deploy already running → queue it instead of rejecting
    if (deployEmitters.has(siteId)) {
      await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: true } })
      return { queued: true, message: 'Deploy queued — will start automatically after the current one finishes.' }
    }

    try {
      const deploymentId = await runDeploy(app, siteId, {
        rootPath: site.rootPath,
        repoUrl: site.repoUrl,
        branch: site.branch,
        phpVersion: site.phpVersion,
        domain: site.domain,
        gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
        healthCheck: site.healthCheck,
        healthCheckUrl: site.healthCheckUrl,
        serverId: site.serverId,
        preDeploy: site.preDeploy,
        postDeploy: site.postDeploy,
        ...siteTestOpts(site),
        skipTests,
        ref
      })
      return { started: true, deploymentId }
    } catch (err: unknown) {
      const e = err as { code?: number; message: string }
      return reply.code(e.code ?? 500).send({ error: e.message })
    }
  })

  // POST /:id/deploy/cancel — admin-only escape hatch for a stuck deploy.
  // Kills the running process (if this API process is the one that started
  // it) and/or force-marks a 'running' Deployment row as failed (covers the
  // case where the row is orphaned from a previous process lifetime and has
  // no live process to kill). Also clears deployQueued so a queued deploy
  // isn't left waiting behind a row that will never finish.
  app.post('/:id/deploy/cancel', { preHandler: [app.requireRole(['admin'])] }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    const proc = deployProcs.get(siteId)
    if (proc) {
      try { process.kill(-proc.pid!, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch {/* already gone */} }
      // proc.on('close') will fire shortly and do the normal finalize/cleanup —
      // nothing more to do here.
      return { ok: true, message: 'Kill signal sent — the deploy will be marked failed shortly.' }
    }

    // No live process tracked (orphaned row, e.g. from before an API restart) —
    // force-finalize directly.
    const running = await app.prisma.deployment.findFirst({ where: { siteId, status: 'running' }, orderBy: { createdAt: 'desc' } })
    if (!running) return reply.code(404).send({ error: 'No running deploy found for this site' })

    await app.prisma.deployment.update({
      where: { id: running.id },
      data: { status: 'failed', log: (running.log ?? '') + '\n[orchestrator] Deploy cancelled by admin.\n' }
    })
    await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: false } })
    deployEmitters.get(siteId)?.emit('done', 'failed')
    deployEmitters.delete(siteId)
    app.audit('deploy.cancelled', { siteId, meta: { deploymentId: running.id } })
    return { ok: true, message: 'Marked the stuck deploy as failed.' }
  })

  // GET /:id/deploy/stream — SSE of current deploy
  app.get('/:id/deploy/stream', async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)

    const running = await app.prisma.deployment.findFirst({
      where: { siteId, status: 'running' },
      orderBy: { createdAt: 'desc' }
    })

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

    if (running) {
      for (const line of deployLogBuffers.get(running.id) ?? []) send({ line })
    }

    await new Promise<void>((resolve) => {
      const emitter = deployEmitters.get(siteId)

      if (!emitter) {
        send({ done: true, status: running?.status ?? 'unknown' })
        reply.raw.end()
        resolve()
        return
      }

      const onLog  = (line: string) => send({ line })
      const onDone = (status: string) => { send({ done: true, status }); reply.raw.end(); cleanup(); resolve() }
      const ka = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ka\n\n') }, 20_000)
      const cleanup = () => { emitter.off('log', onLog); emitter.off('done', onDone); clearInterval(ka) }

      emitter.on('log', onLog)
      emitter.on('done', onDone)
      request.raw.on('close', () => { cleanup(); resolve() })
    })
  })

  // PATCH /:id — update repo, branch, git token, hooks, health check, and
  // site metadata (tags/pinned/notes — merged in here because Fastify
  // doesn't allow two plugins registering the same method+path under the
  // same prefix; this used to also live in sites.ts as a separate handler).
  //
  // NOTE: this route stays open to all authenticated roles (pin toggling on
  // SitesPage relies on it for everyone) — domain/disabled changes are
  // gated to admin only inside the handler below since renaming a domain
  // touches the on-disk Nginx config + site directory, and disabling a site
  // stops it serving traffic entirely.
  app.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        properties: {
          repoUrl:       { type: 'string', maxLength: 500 },
          branch:        { type: 'string', minLength: 1, maxLength: 100 },
          name:          { type: 'string', minLength: 1, maxLength: 100 },
          domain:        { type: 'string', minLength: 3, maxLength: 253,
                           pattern: '^[a-zA-Z0-9][a-zA-Z0-9\\-\\.]*[a-zA-Z0-9]$' },
          disabled:      { type: 'boolean' },
          renameOnDisk:  { type: 'boolean' }, // default true; set false if the site was never provisioned on this server
          gitToken:      { type: 'string', maxLength: 500 },
          preDeploy:     { type: 'string', maxLength: 4096 },
          postDeploy:    { type: 'string', maxLength: 4096 },
          healthCheck:   { type: 'boolean' },
          healthCheckUrl:{ type: 'string', maxLength: 500 },
          runTests:        { type: 'boolean' },
          testCommand:     { type: 'string', maxLength: 500 },
          testFailureMode: { type: 'string', enum: ['block', 'warn'] },
          testTimeout:     { type: 'integer', minimum: 10, maximum: 3600 },
          testUseSqlite:   { type: 'boolean' },
          tags:          { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
          pinned:        { type: 'boolean' },
          notes:         { type: 'string', maxLength: 2000 }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const {
      repoUrl, branch, name, domain, disabled, renameOnDisk,
      gitToken, preDeploy, postDeploy, healthCheck, healthCheckUrl, tags, pinned, notes,
      runTests, testCommand, testFailureMode, testTimeout, testUseSqlite
    } = request.body as {
      repoUrl?: string; branch?: string; name?: string; domain?: string; disabled?: boolean
      renameOnDisk?: boolean; gitToken?: string
      preDeploy?: string; postDeploy?: string; healthCheck?: boolean; healthCheckUrl?: string
      tags?: string[]; pinned?: boolean; notes?: string
      runTests?: boolean; testCommand?: string; testFailureMode?: string; testTimeout?: number; testUseSqlite?: boolean
    }

    const existing = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!existing) return reply.code(404).send({ error: 'Site not found' })

    // Validate the Git URL before it can be stored and later handed to `git`.
    // Empty string is allowed (clears the repo); any non-empty value must be a
    // well-formed https/http or scp-like git URL.
    if (repoUrl !== undefined && repoUrl !== '' && !isValidGitUrl(repoUrl)) {
      return reply.code(400).send({ error: 'Invalid repository URL. Use an https:// or git@host:owner/repo URL.' })
    }

    if ((domain !== undefined && domain !== existing.domain) || disabled !== undefined) {
      const role = (request.user as { role?: string }).role ?? 'admin'
      if (role !== 'admin') return reply.code(403).send({ error: 'Only admins can change a site\'s domain or enabled status' })
    }

    let newRootPath: string | undefined
    let renameLog = ''

    // ── Domain rename ──────────────────────────────────────────────────────
    if (domain !== undefined && domain !== existing.domain) {
      const conflict = await app.prisma.site.findUnique({ where: { domain } })
      if (conflict) return reply.code(409).send({ error: 'That domain is already in use by another site' })

      if (renameOnDisk !== false) {
        try {
          const ctx = await serverCtxForSite(app.prisma, existing)
          const synced = await ensureScriptsSynced(app.prisma, existing.serverId)
          const script = `${synced.scriptsDir}/rename-domain.sh`
          const { stdout, stderr } = await execOn(
            ctx, 'bash', [script, existing.domain, domain],
            { timeout: 30_000 }
          )
          renameLog = (stdout + stderr).trim()
          newRootPath = `/var/www/sites/${domain}`
          app.audit('site.renamed', { siteId, meta: { from: existing.domain, to: domain } })
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string }
          const log = (e.stdout ?? e.stderr ?? e.message ?? 'Unknown error').trim()
          app.audit('site.rename_failed', { siteId, meta: { from: existing.domain, to: domain, error: log } })
          return reply.code(500).send({ error: 'Failed to rename domain on the server', log })
        }
      }
    }

    // ── Enable / disable serving ───────────────────────────────────────────
    if (disabled !== undefined && disabled !== existing.disabled) {
      try {
        const ctx = await serverCtxForSite(app.prisma, existing)
        const synced = await ensureScriptsSynced(app.prisma, existing.serverId)
        const script = `${synced.scriptsDir}/toggle-site.sh`
        const toggleDomain = domain ?? existing.domain
        await execOn(ctx, 'bash', [script, toggleDomain, disabled ? 'off' : 'on'], { timeout: 15_000 })
        app.audit(disabled ? 'site.disabled' : 'site.enabled', { siteId, meta: { domain: toggleDomain } })
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string }
        const log = (e.stdout ?? e.stderr ?? e.message ?? 'Unknown error').trim()
        return reply.code(500).send({ error: `Failed to ${disabled ? 'disable' : 'enable'} site on the server`, log })
      }
    }

    const site = await app.prisma.site.update({
      where: { id: siteId },
      data: {
        ...(repoUrl       !== undefined && { repoUrl }),
        ...(branch        !== undefined && { branch }),
        ...(name          !== undefined && { name }),
        ...(domain        !== undefined && { domain }),
        ...(newRootPath   !== undefined && { rootPath: newRootPath }),
        ...(disabled      !== undefined && { disabled }),
        ...(gitToken      !== undefined && { gitToken: gitToken ? encryptSecret(gitToken) : null }),
        ...(preDeploy     !== undefined && { preDeploy }),
        ...(postDeploy    !== undefined && { postDeploy }),
        ...(healthCheck   !== undefined && { healthCheck }),
        ...(healthCheckUrl !== undefined && { healthCheckUrl }),
        ...(runTests        !== undefined && { runTests }),
        ...(testCommand     !== undefined && { testCommand }),
        ...(testFailureMode !== undefined && { testFailureMode }),
        ...(testTimeout     !== undefined && { testTimeout }),
        ...(testUseSqlite   !== undefined && { testUseSqlite }),
        ...(tags          !== undefined && { tags: JSON.stringify(tags) }),
        ...(pinned        !== undefined && { pinned }),
        ...(notes         !== undefined && { notes })
      }
    })

    // Write hook scripts immediately so they're on disk (local or remote host)
    // for the next deploy.
    if (preDeploy !== undefined || postDeploy !== undefined) {
      const ctx = await serverCtxForSite(app.prisma, site)
      await writeHookOn(ctx, site.rootPath, 'pre-deploy.sh',  site.preDeploy)
      await writeHookOn(ctx, site.rootPath, 'post-deploy.sh', site.postDeploy)
    }

    const { gitToken: _omit, ...safeSite } = site
    return { ...safeSite, hasGitToken: !!site.gitToken, renameLog: renameLog || undefined }
  })

  // POST /:id/webhook-token
  app.post('/:id/webhook-token', async (request) => {
    const siteId = Number((request.params as { id: string }).id)
    const token = crypto.randomBytes(24).toString('hex')
    const site = await app.prisma.site.update({ where: { id: siteId }, data: { webhookToken: token } })
    return { webhookToken: site.webhookToken }
  })

  // GET /:id/releases
  app.get('/:id/releases', async (request, reply) => {
    const site = await app.prisma.site.findUnique({
      where: { id: Number((request.params as { id: string }).id) }
    })
    if (!site) return reply.code(404).send({ error: 'Site not found' })

    const ctx = await serverCtxForSite(app.prisma, site)
    const releasesDir = path.join(site.rootPath, 'releases')
    const currentLink = path.join(site.rootPath, 'current')

    if (isLocal(ctx)) {
      try {
        const entries = await fs.readdir(releasesDir)
        let currentRelease = ''
        try { currentRelease = path.basename(await fs.readlink(currentLink)) } catch { /* no symlink */ }

        const releases = (
          await Promise.all(
            entries.map(async (name) => {
              const stat = await fs.stat(path.join(releasesDir, name)).catch(() => null)
              if (!stat?.isDirectory()) return null
              return { name, isCurrent: name === currentRelease, createdAt: stat.birthtime.toISOString() }
            })
          )
        ).filter(Boolean).sort((a, b) => b!.name.localeCompare(a!.name))

        return { releases, current: currentRelease }
      } catch {
        return { releases: [], current: '' }
      }
    }

    // Remote: list release dirs + mtime in one SSH round-trip.
    try {
      const cur = (await execOn(ctx, 'bash', ['-lc', `basename "$(readlink ${shellEscape(currentLink)} 2>/dev/null)" 2>/dev/null`]).catch(() => ({ stdout: '' }))).stdout.trim()
      const { stdout } = await execOn(ctx, 'bash', ['-lc', `cd ${shellEscape(releasesDir)} 2>/dev/null && for d in */; do [ -d "$d" ] && echo "\${d%/}|$(stat -c %Y "\${d%/}" 2>/dev/null)"; done`]).catch(() => ({ stdout: '' }))
      const releases = stdout.split('\n').filter(Boolean).map((l: string) => {
        const [name, epoch] = l.split('|')
        return { name, isCurrent: name === cur, createdAt: new Date((Number(epoch) || 0) * 1000).toISOString() }
      }).sort((a: any, b: any) => b.name.localeCompare(a.name))
      return { releases, current: cur }
    } catch {
      return { releases: [], current: '' }
    }
  })

  // GET /:id/deployments/heatmap — deploy counts per day for last 52 weeks
  app.get('/:id/deployments/heatmap', async (request) => {
    const siteId = Number((request.params as { id: string }).id)
    const since = new Date(Date.now() - 52 * 7 * 86400_000)
    const deployments = await app.prisma.deployment.findMany({
      where: { siteId, createdAt: { gte: since } },
      select: { createdAt: true, status: true }
    })
    // Group by date
    const byDate: Record<string, { total: number; success: number; failed: number }> = {}
    for (const d of deployments) {
      const key = d.createdAt.toISOString().slice(0, 10)
      if (!byDate[key]) byDate[key] = { total: 0, success: 0, failed: 0 }
      byDate[key].total++
      if (d.status === 'success') byDate[key].success++
      if (d.status === 'failed')  byDate[key].failed++
    }
    return { days: byDate }
  })

  // POST /:id/deployments/:deployId/redeploy — one-click redeploy with the
  // site's current repo/branch config.
  //
  // NOTE: this used to just insert a Deployment row with status 'pending'
  // and never actually start a deploy ("the normal deploy mechanism handles
  // it" — it didn't). That left every redeploy permanently stuck on
  // 'pending'. Fixed to actually call runDeploy(), same as POST /:id/deploy.
  app.post('/:id/deployments/:deployId/redeploy', async (request, reply) => {
    const siteId = Number((request.params as { id: string; deployId: string }).id)
    // deployId is accepted for the URL shape / future use (e.g. redeploying a
    // specific past commit) but a redeploy today just re-runs the site's
    // current branch — deploy.sh always clones HEAD of that branch.
    void (request.params as { deployId: string }).deployId

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (!site.repoUrl) return reply.code(400).send({ error: 'No repository URL configured' })
    if (site.status !== 'active') return reply.code(400).send({ error: 'Site is not active' })

    // Hook scripts are written inside runDeploy on the correct (local/remote) host.
    if (deployEmitters.has(siteId)) {
      await app.prisma.site.update({ where: { id: siteId }, data: { deployQueued: true } })
      return reply.code(202).send({ ok: true, queued: true, message: 'Deploy queued — will start automatically after the current one finishes.' })
    }

    try {
      const deploymentId = await runDeploy(app, siteId, {
        rootPath: site.rootPath,
        repoUrl: site.repoUrl,
        branch: site.branch,
        phpVersion: site.phpVersion,
        domain: site.domain,
        gitToken: site.gitToken ? decryptSecret(site.gitToken) : null,
        healthCheck: site.healthCheck,
        healthCheckUrl: site.healthCheckUrl,
        serverId: site.serverId,
        preDeploy: site.preDeploy,
        postDeploy: site.postDeploy,
        ...siteTestOpts(site)
      })
      return reply.code(202).send({ ok: true, deploymentId })
    } catch (err: unknown) {
      const e = err as { code?: number; message: string }
      return reply.code(e.code ?? 500).send({ error: e.message })
    }
  })

  // POST /:id/rollback
  app.post('/:id/rollback', {
    schema: {
      body: {
        type: 'object',
        required: ['release'],
        properties: { release: { type: 'string', pattern: '^\\d{14}$' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    const siteId = Number((request.params as { id: string }).id)
    const { release } = request.body as { release: string }

    if (!/^\d{14}$/.test(release)) return reply.code(400).send({ error: 'Invalid release name.' })

    const site = await app.prisma.site.findUnique({ where: { id: siteId } })
    if (!site) return reply.code(404).send({ error: 'Site not found' })
    if (deployEmitters.has(siteId)) return reply.code(409).send({ error: 'A deploy / rollback is already running.' })

    const rbCtx = await serverCtxForSite(app.prisma, site)
    const releasePath = path.join(site.rootPath, 'releases', release)
    const releaseExists = isLocal(rbCtx)
      ? await fs.access(releasePath).then(() => true).catch(() => false)
      : await execOn(rbCtx, 'bash', ['-lc', `test -d ${shellEscape(releasePath)}`]).then(() => true).catch(() => false)
    if (!releaseExists) return reply.code(404).send({ error: `Release ${release} not found.` })

    const deployment = await app.prisma.deployment.create({
      data: { siteId, branch: 'rollback', commit: release, status: 'running' }
    })

    const emitter = new EventEmitter()
    emitter.setMaxListeners(20)
    deployEmitters.set(siteId, emitter)
    const buffer: string[] = []
    deployLogBuffers.set(deployment.id, buffer)

    const push = (line: string) => { buffer.push(line); emitter.emit('log', line) }

    ;(async () => {
      const currentPath = path.join(site.rootPath, 'current')
      try {
        push(`↩  Rolling back to release ${release}…`)
        await execOn(rbCtx, 'bash', ['-lc', `ln -sfn ${shellEscape(releasePath)} ${shellEscape(currentPath)}`])
        push(`✓  current → releases/${release}`)
        try {
          await execOn(rbCtx, 'bash', ['-lc', `php${site.phpVersion} ${shellEscape(currentPath + '/artisan')} queue:restart --no-interaction`])
          push('✓  queue:restart signal sent')
        } catch { push('⚠  queue:restart failed') }
        push('Rollback complete.')
        await app.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'success', log: buffer.join('\n') } })
        app.audit('rollback.success', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'success')
      } catch (err: unknown) {
        const msg = (err as Error).message ?? 'Unknown error'
        push(`✗  Rollback failed: ${msg}`)
        await app.prisma.deployment.update({ where: { id: deployment.id }, data: { status: 'failed', log: buffer.join('\n') } })
        app.audit('rollback.failed', { siteId, meta: { domain: site.domain, release } })
        emitter.emit('done', 'failed')
      } finally {
        deployEmitters.delete(siteId)
        setTimeout(() => deployLogBuffers.delete(deployment.id), 30 * 60_000)
      }
    })()

    return { started: true, deploymentId: deployment.id }
  })
}
