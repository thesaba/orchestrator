/**
 * Money handling for billing.
 *
 * RULE: every amount in the database and in this module is an INTEGER in the
 * currency's minor unit (tetri for GEL, cents for USD/EUR). Floats are never
 * used for arithmetic — 0.1 + 0.2 !== 0.3 and rounding drift in an invoicing
 * system is unacceptable. Conversion to/from a human string happens only at
 * the edges (UI input, display, receipts).
 */

export interface CurrencyInfo {
  code: string
  symbol: string
  /** Number of decimal places, i.e. 10^decimals minor units per major unit. */
  decimals: number
  /** Symbol goes after the number (true for GEL: "30.00 ₾"). */
  suffix: boolean
}

export const CURRENCIES: Record<string, CurrencyInfo> = {
  GEL: { code: 'GEL', symbol: '₾', decimals: 2, suffix: true },
  USD: { code: 'USD', symbol: '$', decimals: 2, suffix: false },
  EUR: { code: 'EUR', symbol: '€', decimals: 2, suffix: false }
}

export const DEFAULT_CURRENCY = 'GEL'

export function currencyInfo(code: string): CurrencyInfo {
  return CURRENCIES[code?.toUpperCase()] ?? CURRENCIES[DEFAULT_CURRENCY]
}

/** 10^decimals — minor units in one major unit. */
function factor(code: string): number {
  return 10 ** currencyInfo(code).decimals
}

/**
 * Parse a human-typed amount ("30", "30.5", "30.50", "1 200,75") into minor
 * units. Returns null when the input isn't a valid amount, so callers can
 * surface a validation error rather than silently charging 0.
 */
export function parseMoney(input: string | number, currency = DEFAULT_CURRENCY): number | null {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    return Math.round(input * factor(currency))
  }
  const cleaned = String(input)
    .trim()
    .replace(/\s+/g, '')
    .replace(/,/g, '.') // accept comma decimal separator
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const value = Number(cleaned)
  if (!Number.isFinite(value)) return null
  // Round on the string-derived number: parseMoney("30.005") → 3001 (half-up).
  return Math.round(value * factor(currency))
}

/** Minor units → plain decimal string without a symbol, e.g. 3000 → "30.00". */
export function formatAmount(minor: number, currency = DEFAULT_CURRENCY): string {
  const { decimals } = currencyInfo(currency)
  const neg = minor < 0
  const abs = Math.abs(Math.trunc(minor))
  const f = 10 ** decimals
  const major = Math.trunc(abs / f)
  const rest = abs % f
  const frac = decimals > 0 ? '.' + String(rest).padStart(decimals, '0') : ''
  return `${neg ? '-' : ''}${major}${frac}`
}

/** Minor units → display string with symbol, e.g. 3000 → "30.00 ₾". */
export function formatMoney(minor: number, currency = DEFAULT_CURRENCY): string {
  const info = currencyInfo(currency)
  const n = formatAmount(minor, currency)
  return info.suffix ? `${n} ${info.symbol}` : `${info.symbol}${n}`
}

/** Remaining balance on an invoice, never negative (overpayment → 0). */
export function balanceDue(amount: number, amountPaid: number): number {
  return Math.max(0, amount - amountPaid)
}

/** Sum minor-unit amounts safely (integers only). */
export function sumMinor(values: number[]): number {
  return values.reduce((a, b) => a + Math.trunc(b), 0)
}
