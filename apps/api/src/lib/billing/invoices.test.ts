import { test } from 'node:test'
import assert from 'node:assert/strict'

import { agingBuckets, mrr, invoiceBalance } from './invoices'

const NOW = new Date('2026-03-01T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

// ── aging ───────────────────────────────────────────────────────────────────

test('aging buckets classify by days past due and ignore settled invoices', () => {
  const b = agingBuckets(
    [
      { amount: 1000, amountPaid: 0, dueDate: daysAgo(-5) }, // not yet due
      { amount: 2000, amountPaid: 0, dueDate: daysAgo(10) }, // 1–30
      { amount: 3000, amountPaid: 0, dueDate: daysAgo(45) }, // 31–60
      { amount: 4000, amountPaid: 0, dueDate: daysAgo(90) }, // 61+
      { amount: 5000, amountPaid: 5000, dueDate: daysAgo(99) } // paid → excluded
    ],
    NOW
  )
  assert.equal(b.current, 1000)
  assert.equal(b.d1_30, 2000)
  assert.equal(b.d31_60, 3000)
  assert.equal(b.d61_plus, 4000)
  assert.equal(b.total, 10000)
})

test('a partially paid invoice ages only its remaining balance', () => {
  const b = agingBuckets([{ amount: 5000, amountPaid: 2000, dueDate: daysAgo(10) }], NOW)
  assert.equal(b.d1_30, 3000)
  assert.equal(b.total, 3000)
})

test('overpayment never produces a negative bucket', () => {
  const b = agingBuckets([{ amount: 1000, amountPaid: 4000, dueDate: daysAgo(10) }], NOW)
  assert.equal(b.total, 0)
})

// ── invoiceBalance: the panel and the client portal must never disagree ─────

test('a voided invoice is owed by nobody', () => {
  assert.equal(invoiceBalance({ status: 'void', amount: 5000, amountPaid: 0 }), 0)
})

test('open / partial / overdue invoices owe their remaining balance', () => {
  assert.equal(invoiceBalance({ status: 'open', amount: 5000, amountPaid: 0 }), 5000)
  assert.equal(invoiceBalance({ status: 'partial', amount: 5000, amountPaid: 2000 }), 3000)
  assert.equal(invoiceBalance({ status: 'overdue', amount: 5000, amountPaid: 0 }), 5000)
  assert.equal(invoiceBalance({ status: 'paid', amount: 5000, amountPaid: 5000 }), 0)
})

test('summing balances excludes voided invoices (the portal-vs-panel bug)', () => {
  const invoices = [
    { status: 'open', amount: 5000, amountPaid: 0 },
    { status: 'void', amount: 5000, amountPaid: 0 } // must NOT add 50.00
  ]
  const outstanding = invoices.reduce((s, i) => s + invoiceBalance(i), 0)
  assert.equal(outstanding, 5000)
})

// ── MRR ─────────────────────────────────────────────────────────────────────

test('MRR normalises yearly and custom intervals to a month', () => {
  const total = mrr([
    { amount: 3000, interval: 'monthly', status: 'active' },
    { amount: 12000, interval: 'yearly', status: 'active' }, // → 1000/mo
    { amount: 1000, interval: 'custom_days', intervalDays: 15, status: 'active' } // → 2000/mo
  ])
  assert.equal(total, 3000 + 1000 + 2000)
})

test('MRR still counts past-due and suspended clients (revenue is owed, not lost)', () => {
  const total = mrr([
    { amount: 1000, interval: 'monthly', status: 'past_due' },
    { amount: 1000, interval: 'monthly', status: 'suspended' }
  ])
  assert.equal(total, 2000)
})

test('MRR excludes cancelled and paused subscriptions', () => {
  const total = mrr([
    { amount: 9999, interval: 'monthly', status: 'cancelled' },
    { amount: 8888, interval: 'monthly', status: 'paused' }
  ])
  assert.equal(total, 0)
})
