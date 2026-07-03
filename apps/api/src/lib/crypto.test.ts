import { test } from 'node:test'
import assert from 'node:assert/strict'

// A deterministic key for the test run.
process.env.ENCRYPTION_KEY = 'unit-test-encryption-key'

import { encryptSecret, decryptSecret, isEncrypted, readSecret, writeSecret } from './crypto'

test('encryptSecret → decryptSecret round-trips', () => {
  const enc = encryptSecret('hunter2')
  assert.notEqual(enc, 'hunter2')
  assert.ok(isEncrypted(enc))
  assert.equal(decryptSecret(enc), 'hunter2')
})

test('each encryption uses a fresh IV (ciphertexts differ)', () => {
  assert.notEqual(encryptSecret('same'), encryptSecret('same'))
})

test('decryptSecret returns null on malformed input', () => {
  assert.equal(decryptSecret('not-a-cipher'), null)
  assert.equal(decryptSecret('a:b:c'), null)
})

test('isEncrypted distinguishes ciphertext from plaintext', () => {
  assert.ok(isEncrypted(encryptSecret('x')))
  assert.equal(isEncrypted('plaintext'), false)
  assert.equal(isEncrypted('user@example.com'), false)
})

test('readSecret transparently handles plaintext (legacy) and ciphertext', () => {
  assert.equal(readSecret('legacy-plaintext'), 'legacy-plaintext')
  assert.equal(readSecret(writeSecret('sekret')), 'sekret')
  assert.equal(readSecret(''), '')
  assert.equal(readSecret(null), '')
  assert.equal(readSecret(undefined), '')
})

test('writeSecret passes empty values through unchanged', () => {
  assert.equal(writeSecret(''), '')
  assert.equal(writeSecret(null), '')
  assert.equal(writeSecret(undefined), '')
})
