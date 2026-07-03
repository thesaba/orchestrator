// Canonical list of PHP versions the panel offers in its selectors. Keep this
// in sync as new PHP releases land — it's the single source of truth used by
// both the provision form and the per-site "switch PHP version" control.
//
// Note: switching a live site still validates server-side that the chosen
// version is actually installed before applying it.
export const PHP_VERSIONS = ['8.1', '8.2', '8.3', '8.4', '8.5'] as const

export const DEFAULT_PHP_VERSION = '8.3'

/**
 * Build Polaris Select options from the canonical list, merged with any extra
 * versions detected on the server (so a newer/older install always shows up).
 */
export function phpVersionOptions(extra: readonly string[] = []): { label: string; value: string }[] {
  const all = Array.from(new Set<string>([...PHP_VERSIONS, ...extra]))
  all.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return all.map((v) => ({ label: `PHP ${v}`, value: v }))
}
