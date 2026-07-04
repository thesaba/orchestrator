// Best-effort parser for PHP test-runner summaries (Pest & PHPUnit). The deploy
// gate already knows pass/fail from the process exit code; this extracts the
// richer counts + duration for history and analytics. Returns nulls for
// anything it can't confidently parse — it never throws.

export interface TestSummary {
  passed: number | null
  failed: number | null
  total: number | null
  durationMs: number | null
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function parseTestSummary(rawLog: string): TestSummary {
  const log = stripAnsi(rawLog || '')
  const out: TestSummary = { passed: null, failed: null, total: null, durationMs: null }

  // ── Pest: "Tests:  101 failed, 4 passed, 2 skipped (14 assertions)" ──────────
  // Pest prints one such line; PHPUnit's "Tests: 5, Assertions: 12" is handled
  // separately below and is skipped here because it has no pass/fail keywords.
  // Guard requires the Pest "<n> <keyword>" shape so PHPUnit's "Tests: 5,
  // Assertions: 12, Failures: 2" (keyword-then-number) is NOT captured here.
  const pestLine = log.match(/^\s*Tests:\s+([^\n]+)$/im)
  if (pestLine && /\d+\s+(?:passed|failed|skipped|todo|pending|incomplete|risked|deprecated|warnings?)/i.test(pestLine[1])) {
    const seg = pestLine[1]
    const grab = (kind: string) => {
      const m = seg.match(new RegExp(`(\\d+)\\s+${kind}`, 'i'))
      return m ? Number(m[1]) : 0
    }
    const passed = grab('passed')
    const failed = grab('failed') + grab('errors?')
    // Non-pass, non-fail buckets still count toward the total.
    const other = grab('skipped') + grab('todo') + grab('pending') + grab('incomplete') +
                  grab('warnings?') + grab('risked') + grab('deprecated') + grab('notifications?')
    out.passed = passed
    out.failed = failed
    out.total = passed + failed + other
  }

  // ── PHPUnit failure: "Tests: 5, Assertions: 12, Failures: 2, Errors: 1" ──────
  if (out.total === null) {
    const pu = log.match(/Tests:\s+(\d+),\s+Assertions:\s+\d+(?:,\s+Failures:\s+(\d+))?(?:,\s+Errors:\s+(\d+))?/i)
    if (pu) {
      const total = Number(pu[1])
      const failed = (pu[2] ? Number(pu[2]) : 0) + (pu[3] ? Number(pu[3]) : 0)
      out.total = total
      out.failed = failed
      out.passed = Math.max(0, total - failed)
    }
  }

  // ── PHPUnit success: "OK (5 tests, 12 assertions)" ──────────────────────────
  if (out.total === null) {
    const ok = log.match(/\bOK\b\s+\((\d+)\s+tests?,/i)
    if (ok) {
      out.total = Number(ok[1])
      out.failed = 0
      out.passed = Number(ok[1])
    }
  }

  // ── Duration: Pest "Duration: 12.06s" | PHPUnit "Time: 00:01.234" ───────────
  const dur = log.match(/Duration:\s+([\d.]+)\s*s/i)
  if (dur) {
    out.durationMs = Math.round(parseFloat(dur[1]) * 1000)
  } else {
    const t = log.match(/Time:\s+(\d+):(\d+)(?:\.(\d+))?/i) // mm:ss(.ms)
    if (t) {
      const ms = t[3] ? Number((t[3] + '000').slice(0, 3)) : 0
      out.durationMs = (Number(t[1]) * 60 + Number(t[2])) * 1000 + ms
    }
  }

  return out
}
