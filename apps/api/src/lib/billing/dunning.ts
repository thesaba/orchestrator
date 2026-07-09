/**
 * The dunning ladder — a pure, side-effect-free policy engine.
 *
 * Nothing here touches the database, nginx or the network. It answers exactly
 * one question: "given an invoice's due date, today's date and a policy, what
 * enforcement level should this site be at, and which notifications are due?"
 *
 * Keeping it pure means the whole escalation story is unit-testable without a
 * server, and the risky part (actually applying a level) lives behind a single
 * guarded function in enforce.ts.
 */

/** Billing runs on the operator's wall clock, not UTC. */
export const BILLING_TZ = 'Asia/Tbilisi'

/** What a ladder step does when it fires. */
export type DunningAction =
  | 'remind'         // notification only, before the due date
  | 'invoice_due'    // notification only, on the due date
  | 'banner'         // inject a dismissible "payment overdue" banner
  | 'restrict'       // block /admin, /login — public site stays up
  | 'suspend'        // branded 503 suspension page
  | 'stop_workers'   // stop queue workers + scheduler (site already suspended)
  | 'final_warning'  // notification only
  | 'archive'        // backup + remove files. NEVER deletes the database.

/** Serving-layer state actually applied to a site. Ordered, least → most severe. */
export type EnforcementLevel = 'none' | 'banner' | 'restrict' | 'suspend' | 'archived'

export const LEVEL_ORDER: EnforcementLevel[] = ['none', 'banner', 'restrict', 'suspend', 'archived']

export function levelRank(l: EnforcementLevel): number {
  const i = LEVEL_ORDER.indexOf(l)
  return i === -1 ? 0 : i
}

/** Is `a` more severe than `b`? */
export function isMoreSevere(a: EnforcementLevel, b: EnforcementLevel): boolean {
  return levelRank(a) > levelRank(b)
}

export interface DunningStep {
  /** Days relative to the invoice due date. Negative = before it falls due. */
  offsetDays: number
  action: DunningAction
}

/**
 * The built-in ladder. Deliberately slow and loud: a client is warned four
 * times and keeps a working public site for ten days before anything is cut.
 */
export const DEFAULT_DUNNING_POLICY: DunningStep[] = [
  { offsetDays: -7, action: 'remind' },
  { offsetDays: 0, action: 'invoice_due' },
  { offsetDays: 4, action: 'banner' },
  { offsetDays: 7, action: 'restrict' },
  { offsetDays: 10, action: 'suspend' },
  { offsetDays: 30, action: 'stop_workers' },
  { offsetDays: 60, action: 'final_warning' },
  { offsetDays: 90, action: 'archive' }
]

/** Actions that only send a message — they never change the serving layer. */
const NOTIFY_ONLY: ReadonlySet<DunningAction> = new Set<DunningAction>([
  'remind',
  'invoice_due',
  'final_warning'
])

export function isNotifyOnly(a: DunningAction): boolean {
  return NOTIFY_ONLY.has(a)
}

/** The enforcement level an action drives the site to (null = notify only). */
export function actionLevel(a: DunningAction): EnforcementLevel | null {
  switch (a) {
    case 'banner':
      return 'banner'
    case 'restrict':
      return 'restrict'
    case 'suspend':
      return 'suspend'
    case 'stop_workers':
      return 'suspend' // already suspended; this only adds a side effect
    case 'archive':
      return 'archived'
    default:
      return null
  }
}

// ── Timezone-correct whole-day arithmetic ──────────────────────────────────
// Billing decisions are made on calendar days in Asia/Tbilisi, not on 24h
// intervals from a timestamp — otherwise "day 10" flips at a random hour.

function tzYMD(d: Date, timeZone: string): [number, number, number] {
  // 'en-CA' formats as YYYY-MM-DD, which is trivially splittable.
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d)
  const [y, m, day] = s.split('-').map(Number)
  return [y, m, day]
}

/** Whole days since the epoch, as seen on the wall clock in `timeZone`. */
export function dayIndex(d: Date, timeZone: string = BILLING_TZ): number {
  const [y, m, day] = tzYMD(d, timeZone)
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000)
}

/** Calendar days from `a` to `b` (positive when b is later). */
export function daysBetween(a: Date, b: Date, timeZone: string = BILLING_TZ): number {
  return dayIndex(b, timeZone) - dayIndex(a, timeZone)
}

/** How many days past due (negative = not yet due, 0 = due today). */
export function daysOverdue(dueDate: Date, now: Date, timeZone: string = BILLING_TZ): number {
  return daysBetween(dueDate, now, timeZone)
}

// ── Policy parsing ─────────────────────────────────────────────────────────

const VALID_ACTIONS = new Set<string>([
  'remind',
  'invoice_due',
  'banner',
  'restrict',
  'suspend',
  'stop_workers',
  'final_warning',
  'archive'
])

/**
 * Parse a stored policy JSON string. Any malformed/empty value falls back to
 * the default ladder rather than throwing — a bad policy row must never be
 * able to take a billing run down, and "no policy" must never mean "suspend
 * immediately".
 */
export function parsePolicy(json: string | null | undefined, fallback = DEFAULT_DUNNING_POLICY): DunningStep[] {
  if (!json || !json.trim()) return [...fallback]
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return [...fallback]
  }
  if (!Array.isArray(raw) || raw.length === 0) return [...fallback]
  const steps: DunningStep[] = []
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const offsetDays = Number(o.offsetDays)
    const action = String(o.action ?? '')
    if (!Number.isFinite(offsetDays) || !VALID_ACTIONS.has(action)) continue
    steps.push({ offsetDays: Math.trunc(offsetDays), action: action as DunningAction })
  }
  if (steps.length === 0) return [...fallback]
  return steps.sort((a, b) => a.offsetDays - b.offsetDays)
}

// ── The ladder itself ──────────────────────────────────────────────────────

export interface LadderOptions {
  /** Enforcement (not notifications) is withheld until this many days overdue. */
  gracePeriodDays?: number
  /** Plan-level switch. false → never escalate past `banner`. */
  autoSuspend?: boolean
  /** Per-subscription VIP valve. true → never escalate past `banner`. */
  neverAutoSuspend?: boolean
  timeZone?: string
}

export interface LadderResult {
  daysOverdue: number
  /** The level the site *should* be at right now. */
  targetLevel: EnforcementLevel
  /** Steps whose offset has been reached (notifications + enforcement). */
  firedSteps: DunningStep[]
  /** Notification actions that have fired (a caller de-dupes via BillingEvent). */
  notifyActions: DunningAction[]
  /** True when a cap (autoSuspend/neverAutoSuspend) held the level back. */
  cappedByPolicy: boolean
  /** True when the grace period is currently holding enforcement back. */
  withinGrace: boolean
  /** Extra side effect requested by the ladder at this point. */
  stopWorkers: boolean
}

/**
 * Resolve where a subscription should be, given one unpaid invoice.
 *
 * The result is *idempotent and absolute*: it describes the level the site
 * should be at, not a transition. The caller compares it with the stored
 * level and only acts on a difference, so re-running the daily tick (or
 * running it twice) can never double-escalate.
 */
export function resolveLadder(
  dueDate: Date,
  now: Date,
  policy: DunningStep[],
  opts: LadderOptions = {}
): LadderResult {
  const tz = opts.timeZone ?? BILLING_TZ
  const grace = Math.max(0, opts.gracePeriodDays ?? 0)
  const suspendAllowed = (opts.autoSuspend ?? true) && !(opts.neverAutoSuspend ?? false)

  const overdue = daysOverdue(dueDate, now, tz)
  const firedSteps = policy.filter((s) => overdue >= s.offsetDays)

  const notifyActions = firedSteps.filter((s) => isNotifyOnly(s.action)).map((s) => s.action)

  // Enforcement is suppressed entirely while inside the grace period.
  const withinGrace = overdue < grace
  const enforcementSteps = withinGrace ? [] : firedSteps.filter((s) => !isNotifyOnly(s.action))

  let target: EnforcementLevel = 'none'
  for (const s of enforcementSteps) {
    const lvl = actionLevel(s.action)
    if (lvl && isMoreSevere(lvl, target)) target = lvl
  }

  // Safety cap: a VIP / autoSuspend-off subscription never goes past `banner`.
  let cappedByPolicy = false
  if (!suspendAllowed && isMoreSevere(target, 'banner')) {
    target = 'banner'
    cappedByPolicy = true
  }

  const stopWorkers =
    suspendAllowed && enforcementSteps.some((s) => s.action === 'stop_workers')

  return {
    daysOverdue: overdue,
    targetLevel: target,
    firedSteps,
    notifyActions,
    cappedByPolicy,
    withinGrace,
    stopWorkers
  }
}

export interface NextStepPreview {
  step: DunningStep
  /** Calendar date the step fires on. */
  date: Date
  daysAway: number
  level: EnforcementLevel | null
}

export interface NextStepOptions {
  timeZone?: string
  /**
   * The most severe level this subscription can ever reach (see `capLevel`).
   * Steps that would exceed it are skipped: telling the operator that a
   * never-auto-suspended site will `stop_workers` in 18 days is a lie, because
   * that rung requires a suspension that will never happen.
   */
  maxLevel?: EnforcementLevel
}

/**
 * The next step that has *not* fired yet and that can *actually* fire —
 * powers the "what happens next" preview so the operator is never surprised,
 * and never warned about something impossible.
 */
export function nextStep(
  dueDate: Date,
  now: Date,
  policy: DunningStep[],
  opts: NextStepOptions = {}
): NextStepPreview | null {
  const tz = opts.timeZone ?? BILLING_TZ
  const max = opts.maxLevel ?? 'archived'
  const overdue = daysOverdue(dueDate, now, tz)

  const upcoming = policy
    .filter((s) => s.offsetDays > overdue)
    .filter((s) => {
      // Notification rungs always happen; enforcement rungs only if the cap allows.
      if (isNotifyOnly(s.action)) return true
      const lvl = actionLevel(s.action)
      return !lvl || !isMoreSevere(lvl, max)
    })
    .sort((a, b) => a.offsetDays - b.offsetDays)[0]

  if (!upcoming) return null
  const date = new Date(dueDate.getTime() + upcoming.offsetDays * 86_400_000)
  return {
    step: upcoming,
    date,
    daysAway: upcoming.offsetDays - overdue,
    level: actionLevel(upcoming.action)
  }
}

/** Next billing anchor date after `from`, honouring a 1–28 day-of-month anchor. */
export function nextInvoiceDate(
  from: Date,
  interval: string,
  intervalDays: number | null | undefined,
  anchorDay: number | null | undefined
): Date {
  const d = new Date(from.getTime())
  if (interval === 'custom_days') {
    const n = Math.max(1, intervalDays ?? 30)
    d.setUTCDate(d.getUTCDate() + n)
    return d
  }
  const months = interval === 'yearly' ? 12 : 1
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
  // Clamp to 28 so every month has the day — no Feb-30 surprises.
  const day = Math.min(Math.max(anchorDay ?? d.getUTCDate(), 1), 28)
  target.setUTCDate(day)
  return target
}
