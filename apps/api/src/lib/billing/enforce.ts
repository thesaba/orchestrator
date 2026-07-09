/**
 * The ONLY place billing is allowed to touch a live site.
 *
 * dunning.ts decides *what* level a site should be at (pure). This module is
 * the single, heavily-guarded door through which that decision reaches nginx.
 * Every risky action funnels through `applyEnforcement`, which:
 *
 *   1. refuses to do anything unless the master switch is "on"
 *      (default "off"; "dry_run" records the intent and changes nothing),
 *   2. never escalates a subscription flagged `neverAutoSuspend` past `banner`,
 *   3. never touches a site that is mid-deploy,
 *   4. is idempotent — applying the level a site is already at is a no-op,
 *   5. records a BillingEvent + audit entry for every transition, and
 *   6. relies on site-suspend.sh, which itself does backup → `nginx -t` →
 *      auto-rollback, so a failed apply leaves the site serving.
 *
 * Restoring is always one call away: `restoreSite()` returns a site to `none`
 * regardless of how it got suspended.
 */

import { FastifyInstance } from 'fastify'
import path from 'path'
import { execOn, isLocal } from '../server-exec'
import { serverCtxForSite } from '../servers'
import { ensureScriptsSynced } from '../server-sync'
import { EnforcementLevel, isMoreSevere } from './dunning'
import { formatMoney } from './money'

/** Settings key for the master switch. */
export const ENFORCEMENT_KEY = 'billing_enforcement'

export type EnforcementMode = 'off' | 'dry_run' | 'on'

/**
 * Read the master switch. Anything unrecognised — including a missing row —
 * resolves to "off". Billing must fail CLOSED: never suspend by accident.
 */
export async function enforcementMode(app: FastifyInstance): Promise<EnforcementMode> {
  const row = await app.prisma.setting.findUnique({ where: { key: ENFORCEMENT_KEY } }).catch(() => null)
  const v = row?.value?.trim().toLowerCase()
  return v === 'on' || v === 'dry_run' ? v : 'off'
}

export interface EnforceSubject {
  siteId: number
  domain: string
  serverId?: number | null
  /** Currently applied level, from the Subscription row. */
  currentLevel: EnforcementLevel
  neverAutoSuspend: boolean
  /** Shown on the suspension page / banner. */
  amountDueMinor?: number
  currency?: string
  contact?: string | null
  locale?: string | null
}

export interface EnforceResult {
  applied: boolean
  dryRun: boolean
  from: EnforcementLevel
  to: EnforcementLevel
  reason?: string
  output?: string
}

/** A site being deployed must never have its nginx rewritten underneath it. */
async function isDeploying(app: FastifyInstance, siteId: number): Promise<boolean> {
  const site = await app.prisma.site.findUnique({
    where: { id: siteId },
    select: { deployQueued: true }
  }).catch(() => null)
  if (site?.deployQueued) return true
  const running = await app.prisma.deployment.findFirst({
    where: { siteId, status: { in: ['pending', 'running'] } },
    select: { id: true }
  }).catch(() => null)
  return !!running
}

/** Cap the requested level according to the subscription's safety valve. */
export function capLevel(requested: EnforcementLevel, neverAutoSuspend: boolean): EnforcementLevel {
  if (neverAutoSuspend && isMoreSevere(requested, 'banner')) return 'banner'
  return requested
}

/**
 * Drive a site to `target`. Returns what happened without throwing for the
 * expected "we chose not to act" cases — the caller logs those as events.
 */
export async function applyEnforcement(
  app: FastifyInstance,
  subject: EnforceSubject,
  target: EnforcementLevel,
  opts: { subscriptionId?: number; invoiceId?: number; force?: boolean } = {}
): Promise<EnforceResult> {
  const from = subject.currentLevel
  const mode = await enforcementMode(app)
  const capped = capLevel(target, subject.neverAutoSuspend)

  const record = async (r: EnforceResult) => {
    if (opts.subscriptionId) {
      await (app.prisma as any).billingEvent.create({
        data: {
          subscriptionId: opts.subscriptionId,
          invoiceId: opts.invoiceId ?? null,
          type: r.applied ? (capped === 'none' ? 'restored' : capped) : 'dry_run',
          fromLevel: r.from,
          toLevel: r.to,
          detail: r.reason ?? null,
          dryRun: r.dryRun
        }
      }).catch(() => {})
    }
    return r
  }

  // 1. Master switch. `force` is used by the manual "restore now" action, which
  //    an operator triggers explicitly — but it still cannot suspend, only relax.
  if (mode === 'off' && !(opts.force && capped === 'none')) {
    return record({ applied: false, dryRun: false, from, to: capped, reason: 'billing enforcement is off' })
  }

  // 4. Idempotence.
  if (from === capped) {
    return { applied: false, dryRun: mode === 'dry_run', from, to: capped, reason: 'already at this level' }
  }

  // 3. Never fight a deploy.
  if (await isDeploying(app, subject.siteId)) {
    return record({ applied: false, dryRun: false, from, to: capped, reason: 'site is deploying — deferred' })
  }

  // 2 (already applied via capLevel) + dry run.
  if (mode === 'dry_run' && !opts.force) {
    return record({
      applied: false,
      dryRun: true,
      from,
      to: capped,
      reason: `dry run: would move ${from} → ${capped}`
    })
  }

  // 6. Do it — via the guarded script, on whichever server the site lives on.
  // `serverId` lives in schema.prisma but not in the checked-in generated
  // client (it is regenerated on deploy) — same convention as server-sync.ts.
  const site = (await app.prisma.site.findUnique({ where: { id: subject.siteId } })) as any
  if (!site) return record({ applied: false, dryRun: false, from, to: capped, reason: 'site not found' })

  const ctx = await serverCtxForSite(app.prisma, site)
  const synced = await ensureScriptsSynced(app.prisma, site.serverId)
  const script = isLocal(ctx)
    ? path.join(synced.scriptsDir, 'site-suspend.sh')
    : `${synced.scriptsDir}/site-suspend.sh`

  const env: Record<string, string> = {
    SUSP_LANG: subject.locale === 'en' ? 'en' : 'ka'
  }
  if (typeof subject.amountDueMinor === 'number' && subject.amountDueMinor > 0) {
    env.SUSP_AMOUNT = formatMoney(subject.amountDueMinor, subject.currency ?? 'GEL')
  }
  if (subject.contact) env.SUSP_CONTACT = subject.contact

  try {
    const { stdout, stderr } = await execOn(ctx, 'bash', [script, subject.domain, capped], {
      env,
      timeout: 60_000
    })
    app.audit('billing.enforce', {
      meta: { siteId: subject.siteId, domain: subject.domain, from, to: capped }
    })
    return record({
      applied: true,
      dryRun: false,
      from,
      to: capped,
      output: (stdout || '') + (stderr || '')
    })
  } catch (e: unknown) {
    // site-suspend.sh already rolled the site back; surface the failure loudly.
    const msg = (e as Error).message ?? String(e)
    app.audit('billing.enforce_failed', {
      meta: { siteId: subject.siteId, domain: subject.domain, from, to: capped, error: msg }
    })
    return record({ applied: false, dryRun: false, from, to: capped, reason: `apply failed: ${msg}` })
  }
}

/** Unconditionally return a site to normal serving. Used the moment an invoice is paid. */
export async function restoreSite(
  app: FastifyInstance,
  subject: EnforceSubject,
  opts: { subscriptionId?: number; invoiceId?: number } = {}
): Promise<EnforceResult> {
  return applyEnforcement(app, subject, 'none', { ...opts, force: true })
}

/**
 * Stop/start a suspended site's queue workers + scheduler. Separate from the
 * nginx level because it is the one action that touches running processes.
 * Best-effort: a supervisor hiccup must never abort a billing run.
 */
export async function setWorkersRunning(
  app: FastifyInstance,
  siteId: number,
  running: boolean
): Promise<boolean> {
  const site = (await app.prisma.site.findUnique({ where: { id: siteId } })) as any
  if (!site) return false
  try {
    const ctx = await serverCtxForSite(app.prisma, site)
    await execOn(ctx, 'supervisorctl', [running ? 'start' : 'stop', `${site.domain}:*`], { timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
