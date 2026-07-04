import type { CSSProperties } from 'react'

export type LogLevel = 'error' | 'success' | 'warning' | 'info' | 'step' | 'muted' | 'default'

// Shared log color scheme — used by every log/terminal viewer in the panel so
// deploy, provision, certbot, service-journal and Laravel logs all read
// consistently (errors red, success green, warnings amber, …).
export const LOG_COLORS: Record<LogLevel, CSSProperties> = {
  error:   { color: '#ff6b6b', fontWeight: 600 },
  success: { color: '#3fb950', fontWeight: 600 },
  warning: { color: '#e3b341' },
  info:    { color: '#79c0ff' },
  step:    { color: '#d2a8ff', fontWeight: 600 },
  muted:   { color: '#8b949e' },
  default: { color: '#e6edf3' }
}

// Classify a single log line into a color level. Handles structured Laravel
// logs (".ERROR", ".INFO") and free-form build/deploy output alike. Status
// glyphs (✓ / ✗ / ⚠) win over keywords, so "✓ Tests passed" is success and
// "✗ Tests FAILED" is an error regardless of the surrounding words.
export function classifyLogLine(raw: string): LogLevel {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '') // ignore ANSI when matching
  const l = line.toLowerCase()

  // 1) Explicit status glyphs (highest priority)
  if (/[✓✔√]/.test(line)) return 'success'
  if (/[✗✘×❌]/.test(line)) return 'error'
  if (/⚠/.test(line)) return 'warning'

  // 2) Laravel log levels
  if (l.includes('.critical') || l.includes('.error') || l.includes('.emergency')) return 'error'
  if (l.includes('.warning') || l.includes('.alert') || l.includes('.notice')) return 'warning'
  if (l.includes('.info') || l.includes('.debug')) return 'info'

  // 3) Error keywords
  if (/\b(error|errors|failed|failure|fatal|exception|denied|refused|cannot|could not|not found|sqlstate|aborting|abort)\b/.test(l)) return 'error'

  // 4) Success keywords
  if (/\b(success|succeeded|passed|complete|completed|installed|created|ok)\b/.test(l)) return 'success'

  // 5) Warning keywords
  if (/\b(warning|warn|deprecated|skipped|skipping|notice)\b/.test(l)) return 'warning'

  // 6) Phase / step markers, e.g. "[3b/8] …" or "=== … ==="
  if (/^\s*\[\d+[a-z]?\/\d+\]/i.test(line) || /^\s*={2,}.*={2,}\s*$/.test(line)) return 'step'

  // 7) Progress-ish info keywords
  if (/\b(installing|cloning|running|building|generating|linking|pruning|fetching|downloading|migrating)\b/.test(l)) return 'info'

  return 'default'
}
