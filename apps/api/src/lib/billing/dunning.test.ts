import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DUNNING_POLICY,
  parsePolicy,
  resolveLadder,
  nextStep,
  nextInvoiceDate,
  daysOverdue,
  actionLevel,
  isMoreSevere
} from './dunning'

import { parseMoney, formatMoney, formatAmount, balanceDue } from './money'

/** Due 2026-01-10 (Tbilisi). Helper to build "N days after due" instants. */
const DUE = new Date('2026-01-10T00:00:00+04:00')
const at = (days: number) => new Date(DUE.getTime() + days * 86_400_000)

// ── ladder progression ──────────────────────────────────────────────────────

test('before the due date nothing is enforced', () => {
  const r = resolveLadder(DUE, at(-3), DEFAULT_DUNNING_POLICY)
  assert.equal(r.targetLevel, 'none')
  assert.equal(r.daysOverdue, -3)
})

test('the -7d reminder fires but changes no level', () => {
  const r = resolveLadder(DUE, at(-7), DEFAULT_DUNNING_POLICY)
  assert.ok(r.notifyActions.includes('remind'))
  assert.equal(r.targetLevel, 'none')
})

test('grace period holds enforcement back even once a step fired', () => {
  // day 4 would normally trigger `banner`, but a 5-day grace suppresses it.
  const r = resolveLadder(DUE, at(4), DEFAULT_DUNNING_POLICY, { gracePeriodDays: 5 })
  assert.equal(r.withinGrace, true)
  assert.equal(r.targetLevel, 'none')
})

test('ladder escalates banner → restrict → suspend → archived', () => {
  const p = DEFAULT_DUNNING_POLICY
  assert.equal(resolveLadder(DUE, at(4), p).targetLevel, 'banner')
  assert.equal(resolveLadder(DUE, at(7), p).targetLevel, 'restrict')
  assert.equal(resolveLadder(DUE, at(10), p).targetLevel, 'suspend')
  assert.equal(resolveLadder(DUE, at(90), p).targetLevel, 'archived')
})

test('resolveLadder is absolute, not incremental (idempotent re-runs)', () => {
  const a = resolveLadder(DUE, at(12), DEFAULT_DUNNING_POLICY)
  const b = resolveLadder(DUE, at(12), DEFAULT_DUNNING_POLICY)
  assert.deepEqual(a.targetLevel, b.targetLevel)
  assert.equal(a.targetLevel, 'suspend')
})

// ── safety caps ─────────────────────────────────────────────────────────────

test('neverAutoSuspend caps escalation at banner, forever', () => {
  const r = resolveLadder(DUE, at(365), DEFAULT_DUNNING_POLICY, { neverAutoSuspend: true })
  assert.equal(r.targetLevel, 'banner')
  assert.equal(r.cappedByPolicy, true)
  assert.equal(r.stopWorkers, false)
})

test('autoSuspend=false caps escalation at banner', () => {
  const r = resolveLadder(DUE, at(100), DEFAULT_DUNNING_POLICY, { autoSuspend: false })
  assert.equal(r.targetLevel, 'banner')
  assert.equal(r.cappedByPolicy, true)
})

test('stop_workers only fires once suspension is allowed and reached', () => {
  assert.equal(resolveLadder(DUE, at(29), DEFAULT_DUNNING_POLICY).stopWorkers, false)
  assert.equal(resolveLadder(DUE, at(30), DEFAULT_DUNNING_POLICY).stopWorkers, true)
})

// ── policy parsing must never fail open ─────────────────────────────────────

test('malformed / empty policy falls back to the default ladder', () => {
  assert.deepEqual(parsePolicy(''), DEFAULT_DUNNING_POLICY)
  assert.deepEqual(parsePolicy(null), DEFAULT_DUNNING_POLICY)
  assert.deepEqual(parsePolicy('{not json'), DEFAULT_DUNNING_POLICY)
  assert.deepEqual(parsePolicy('[]'), DEFAULT_DUNNING_POLICY)
  assert.deepEqual(parsePolicy('[{"offsetDays":1,"action":"nope"}]'), DEFAULT_DUNNING_POLICY)
})

test('a valid custom policy is parsed and sorted', () => {
  const p = parsePolicy('[{"offsetDays":9,"action":"suspend"},{"offsetDays":2,"action":"banner"}]')
  assert.deepEqual(p, [
    { offsetDays: 2, action: 'banner' },
    { offsetDays: 9, action: 'suspend' }
  ])
})

test('a policy with no suspend step never suspends', () => {
  const p = parsePolicy('[{"offsetDays":1,"action":"banner"}]')
  assert.equal(resolveLadder(DUE, at(999), p).targetLevel, 'banner')
})

// ── the wrong-suspension guards, as pure assertions ──────────────────────────

test('an invoice not yet due never drives any enforcement', () => {
  // Future due date → negative overdue → level none, whatever the policy.
  for (const d of [-1, -7, -30]) {
    assert.equal(resolveLadder(DUE, at(d), DEFAULT_DUNNING_POLICY).targetLevel, 'none')
  }
})

test('grace fully covering the first enforcement rung yields no enforcement', () => {
  // banner is +4; a 5-day grace means day 4 is still inside grace.
  const r = resolveLadder(DUE, at(4), DEFAULT_DUNNING_POLICY, { gracePeriodDays: 5 })
  assert.equal(r.targetLevel, 'none')
  assert.equal(r.withinGrace, true)
})

// ── preview ─────────────────────────────────────────────────────────────────

test('nextStep previews the upcoming action and its date', () => {
  const n = nextStep(DUE, at(5), DEFAULT_DUNNING_POLICY)
  assert.ok(n)
  assert.equal(n!.step.action, 'restrict')
  assert.equal(n!.daysAway, 2)
  assert.equal(n!.level, 'restrict')
})

test('nextStep returns null once the ladder is exhausted', () => {
  assert.equal(nextStep(DUE, at(500), DEFAULT_DUNNING_POLICY), null)
})

test('a capped subscription is never promised a rung it can never reach', () => {
  // 12 days overdue, capped at banner. The raw next step is +30 stop_workers,
  // but that requires a suspension which will never happen — the honest answer
  // is the next NOTIFICATION rung, +60 final_warning.
  const raw = nextStep(DUE, at(12), DEFAULT_DUNNING_POLICY)
  assert.equal(raw!.step.action, 'stop_workers')

  const capped = nextStep(DUE, at(12), DEFAULT_DUNNING_POLICY, { maxLevel: 'banner' })
  assert.equal(capped!.step.action, 'final_warning')
  assert.equal(capped!.daysAway, 48)
})

test('a capped subscription skips restrict/suspend but keeps notifications', () => {
  const n = nextStep(DUE, at(1), DEFAULT_DUNNING_POLICY, { maxLevel: 'banner' })
  assert.equal(n!.step.action, 'banner') // +4 banner is still reachable
  const after = nextStep(DUE, at(5), DEFAULT_DUNNING_POLICY, { maxLevel: 'banner' })
  assert.equal(after!.step.action, 'final_warning') // +7 restrict and +10 suspend skipped
})

test('an uncapped subscription still sees every rung', () => {
  const n = nextStep(DUE, at(12), DEFAULT_DUNNING_POLICY, { maxLevel: 'archived' })
  assert.equal(n!.step.action, 'stop_workers')
})

// ── level ordering ──────────────────────────────────────────────────────────

test('level severity ordering', () => {
  assert.ok(isMoreSevere('suspend', 'banner'))
  assert.ok(!isMoreSevere('banner', 'suspend'))
  assert.equal(actionLevel('remind'), null)
  assert.equal(actionLevel('stop_workers'), 'suspend')
})

// ── timezone-correct day math ───────────────────────────────────────────────

test('daysOverdue counts calendar days, not 24h blocks', () => {
  // 23:00 Tbilisi on the due date is still "day 0", not day 1.
  const late = new Date('2026-01-10T23:00:00+04:00')
  assert.equal(daysOverdue(DUE, late), 0)
  // 00:30 the next day is day 1 even though only 1.5h elapsed.
  const justAfter = new Date('2026-01-11T00:30:00+04:00')
  assert.equal(daysOverdue(DUE, justAfter), 1)
})

// ── anchor dates ────────────────────────────────────────────────────────────

test('nextInvoiceDate honours a per-client anchor day', () => {
  const d = nextInvoiceDate(new Date('2026-01-15T00:00:00Z'), 'monthly', null, 5)
  assert.equal(d.toISOString().slice(0, 10), '2026-02-05')
})

test('anchor day is clamped to 28 so February always exists', () => {
  const d = nextInvoiceDate(new Date('2026-01-31T00:00:00Z'), 'monthly', null, 31)
  assert.equal(d.toISOString().slice(0, 10), '2026-02-28')
})

test('custom_days interval advances by N days', () => {
  const d = nextInvoiceDate(new Date('2026-01-01T00:00:00Z'), 'custom_days', 45, null)
  assert.equal(d.toISOString().slice(0, 10), '2026-02-15')
})

// ── money: integers only, no float drift ────────────────────────────────────

test('parseMoney handles commas, spaces and decimals', () => {
  assert.equal(parseMoney('30'), 3000)
  assert.equal(parseMoney('30.5'), 3050)
  assert.equal(parseMoney('30,50'), 3050)
  assert.equal(parseMoney('1 200.75'), 120075)
  assert.equal(parseMoney('abc'), null)
  assert.equal(parseMoney(''), null)
})

test('the classic float trap does not apply', () => {
  // 0.1 + 0.2 in minor units is exact.
  assert.equal(parseMoney('0.1')! + parseMoney('0.2')!, parseMoney('0.3'))
})

test('formatting round-trips', () => {
  assert.equal(formatAmount(3000), '30.00')
  assert.equal(formatAmount(5), '0.05')
  assert.equal(formatMoney(3000, 'GEL'), '30.00 ₾')
  assert.equal(formatMoney(3000, 'USD'), '$30.00')
})

test('balanceDue never goes negative on overpayment', () => {
  assert.equal(balanceDue(3000, 1000), 2000)
  assert.equal(balanceDue(3000, 5000), 0)
})
