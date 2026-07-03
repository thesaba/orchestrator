import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bucketFor } from './ssl-monitor'

test('maps days-left to the smallest matching alert threshold', () => {
  assert.equal(bucketFor(0), 1)
  assert.equal(bucketFor(1), 1)
  assert.equal(bucketFor(2), 3)
  assert.equal(bucketFor(3), 3)
  assert.equal(bucketFor(5), 7)
  assert.equal(bucketFor(7), 7)
  assert.equal(bucketFor(10), 14)
  assert.equal(bucketFor(14), 14)
})

test('returns null when the cert is comfortably far from expiry', () => {
  assert.equal(bucketFor(15), null)
  assert.equal(bucketFor(30), null)
  assert.equal(bucketFor(90), null)
})
