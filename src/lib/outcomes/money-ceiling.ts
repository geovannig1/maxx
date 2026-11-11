// Sanity ceiling for one outcome's money: a value above it is a sender bug or an attack, not a
// sale. Webhook and CSV ingest refuse it with a 4xx, and no Conversions API event ever carries it.
// OUTCOME_MONEY_CEILING (major units of the account currency) overrides the default; an unusable
// setting falls back to the default rather than lifting the ceiling.

export const DEFAULT_OUTCOME_MONEY_CEILING = 1_000_000_000

export function outcomeMoneyCeiling(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OUTCOME_MONEY_CEILING?.trim()
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_OUTCOME_MONEY_CEILING
}

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/

const EXPONENT_DECIMAL = /^(\d+)(?:\.(\d+))?e([+-]?\d{1,3})$/i

/** PURE. An exponent form ("1e9", "1.0e-7") as an exact plain decimal string, moving the point in the
 *  digits themselves (a float would turn 1e-7 into 1.00000000000000004e-7). Null when not that form. */
function expandExponent(raw: string): string | null {
  const match = EXPONENT_DECIMAL.exec(raw)
  if (!match) return null
  const digits = `${match[1]}${match[2] ?? ''}`
  const point = match[1].length + Number(match[3])
  const whole = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0')
  const fraction = (point <= 0 ? `${'0'.repeat(-point)}${digits}` : digits.slice(point)).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** The ceiling as an exact plain decimal string: the setting as written (expanded when it uses an
 *  exponent) when it is a finite positive number, else the default. A usable setting is never replaced
 *  by the larger default, and an unusable one never lifts the ceiling. */
function ceilingDecimal(env: Record<string, string | undefined>): string {
  const raw = env.OUTCOME_MONEY_CEILING?.trim() ?? ''
  const value = raw ? Number(raw) : Number.NaN
  if (!(Number.isFinite(value) && value > 0)) return String(DEFAULT_OUTCOME_MONEY_CEILING)
  if (PLAIN_DECIMAL.test(raw)) return raw
  const expanded = expandExponent(raw)
  if (expanded !== null && PLAIN_DECIMAL.test(expanded)) return expanded
  return Number.isInteger(value) ? BigInt(value).toString() : String(DEFAULT_OUTCOME_MONEY_CEILING)
}

/** PURE. Compare two non-negative plain decimal strings exactly: -1, 0 or 1. */
function compareDecimal(a: string, b: string): number {
  const [, ai, af = ''] = PLAIN_DECIMAL.exec(a)!
  const [, bi, bf = ''] = PLAIN_DECIMAL.exec(b)!
  const aInt = ai.replace(/^0+(?=\d)/, '')
  const bInt = bi.replace(/^0+(?=\d)/, '')
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1
  if (aInt !== bInt) return aInt < bInt ? -1 : 1
  const width = Math.max(af.length, bf.length)
  const aFrac = af.padEnd(width, '0')
  const bFrac = bf.padEnd(width, '0')
  return aFrac === bFrac ? 0 : aFrac < bFrac ? -1 : 1
}

/** true when `value` (an exact decimal string or a number) is a finite amount above the ceiling. A
 *  null/absent value is "not observed" and never exceeds it. A plain decimal string is compared exactly,
 *  digit by digit, never through a float (a double cannot tell 999999999999999.000001 from its integer). */
export function exceedsOutcomeMoneyCeiling(
  value: string | number | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'string' && PLAIN_DECIMAL.test(value)) return compareDecimal(value, ceilingDecimal(env)) > 0
  const amount = typeof value === 'number' ? value : Number(value)
  return !Number.isFinite(amount) || amount > outcomeMoneyCeiling(env)
}
