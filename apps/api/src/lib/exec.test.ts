import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isValidGitUrl } from './exec'

test('accepts well-formed https and scp-like git URLs', () => {
  assert.ok(isValidGitUrl('https://github.com/owner/repo.git'))
  assert.ok(isValidGitUrl('http://gitlab.internal/owner/repo'))
  assert.ok(isValidGitUrl('git@github.com:owner/repo.git'))
})

test('rejects non-git/dangerous schemes', () => {
  assert.equal(isValidGitUrl('file:///etc/passwd'), false)
  assert.equal(isValidGitUrl('ext::sh -c whoami'), false)
  assert.equal(isValidGitUrl('ssh://x; rm -rf /'), false)
})

test('rejects option-injection and whitespace/control chars', () => {
  assert.equal(isValidGitUrl('-oProxyCommand=evil'), false)   // leading dash
  assert.equal(isValidGitUrl('https://x /y'), false)          // space
  assert.equal(isValidGitUrl('https://x\ny'), false)          // newline
  assert.equal(isValidGitUrl(''), false)
  assert.equal(isValidGitUrl('x'.repeat(501)), false)         // too long
})

test('shell metacharacters inside a valid URL are permitted (execFile makes them inert)', () => {
  // sites.ts runs `git ls-remote` via execFile (argv, no shell), so a URL
  // containing $() or backticks is passed literally and never executed.
  assert.ok(isValidGitUrl('https://host/repo$(id).git'))
})
