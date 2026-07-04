import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTestSummary } from './test-parse'

test('parses a failing Pest summary (with ANSI + duration)', () => {
  const log = 'Tests:    \x1b[31m101 failed\x1b[39m, \x1b[32m4 passed\x1b[39m (14 assertions)\n  Duration: 12.06s'
  const r = parseTestSummary(log)
  assert.equal(r.passed, 4)
  assert.equal(r.failed, 101)
  assert.equal(r.total, 105)
  assert.equal(r.durationMs, 12060)
})

test('parses an all-passing Pest summary', () => {
  const r = parseTestSummary('Tests:    42 passed (98 assertions)\nDuration: 3.5s')
  assert.equal(r.passed, 42)
  assert.equal(r.failed, 0)
  assert.equal(r.total, 42)
  assert.equal(r.durationMs, 3500)
})

test('counts skipped/todo toward total but not pass/fail', () => {
  const r = parseTestSummary('Tests:  2 failed, 10 passed, 3 skipped, 1 todo (20 assertions)\nDuration: 1.0s')
  assert.equal(r.passed, 10)
  assert.equal(r.failed, 2)
  assert.equal(r.total, 16)
})

test('parses a PHPUnit failure summary', () => {
  const r = parseTestSummary('FAILURES!\nTests: 5, Assertions: 12, Failures: 2, Errors: 1.\nTime: 00:01.234')
  assert.equal(r.total, 5)
  assert.equal(r.failed, 3)
  assert.equal(r.passed, 2)
  assert.equal(r.durationMs, 1234)
})

test('parses a PHPUnit OK summary', () => {
  const r = parseTestSummary('OK (5 tests, 12 assertions)\nTime: 00:00.456')
  assert.equal(r.total, 5)
  assert.equal(r.failed, 0)
  assert.equal(r.passed, 5)
  assert.equal(r.durationMs, 456)
})

test('returns all-null for unparseable output', () => {
  const r = parseTestSummary('some random build output with no summary')
  assert.equal(r.passed, null)
  assert.equal(r.failed, null)
  assert.equal(r.total, null)
  assert.equal(r.durationMs, null)
})
