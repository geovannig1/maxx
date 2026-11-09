/**
 * Cell value rules for the outcome CSV import.
 *
 * Money is an exact decimal: it is validated as text and kept as text (no float conversion), so the
 * database stores exactly what the file says. An empty cell is NULL ("not observed"); "0" is an
 * observed zero. Anything a reader could interpret two ways is refused: thousands separators, a
 * decimal comma, currency symbols, signs, exponents and leading zeros.
 *
 * Instants are ISO 8601. A timestamp must carry `Z` or an offset; a bare local date-time is refused
 * because it does not name its zone. A date alone means the start of that day in the business
 * timezone (local midnight, or the first instant of the day where midnight does not exist).
 */

export type DecimalCode =
  | 'decimal_separator'
  | 'decimal_negative'
  | 'decimal_too_precise'
  | 'decimal_too_large'
  | 'decimal_invalid'

const MAX_INTEGER_DIGITS = 15
const MAX_FRACTION_DIGITS = 6
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export function parseExactDecimal(raw: string): { ok: true; value: string | null } | { ok: false; code: DecimalCode } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  if (/^\d[\d.]*[,' _][\d,' _.]*\d$/.test(text) || /^\d+,\d+$/.test(text)) return { ok: false, code: 'decimal_separator' }
  if (/^-\d/.test(text)) return { ok: false, code: 'decimal_negative' }
  const match = DECIMAL.exec(text)
  if (!match) return { ok: false, code: 'decimal_invalid' }
  const [, integer, fraction = ''] = match
  if (integer.length > MAX_INTEGER_DIGITS) return { ok: false, code: 'decimal_too_large' }
  if (fraction.length > MAX_FRACTION_DIGITS) return { ok: false, code: 'decimal_too_precise' }
  const trimmed = fraction.replace(/0+$/, '')
  return { ok: true, value: trimmed ? `${integer}.${trimmed}` : integer }
}

export type InstantCode = 'date_invalid' | 'datetime_missing_offset'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const probe = new Date(Date.UTC(y, m - 1, d))
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
function localDate(ms: number, timezone: string): string {
  let format = dateFormatters.get(timezone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dateFormatters.set(timezone, format)
  }
  return format.format(ms)
}

const MINUTE_MS = 60_000

/**
 * The first instant (ISO, UTC) whose calendar date in `timezone` is `date` (YYYY-MM-DD). UTC offsets
 * lie within -12h..+14h, so the answer is in [UTC midnight - 14h, UTC midnight + 12h]; a binary search
 * over whole minutes finds it, including on days whose local midnight was skipped by a DST change.
 */
export function startOfDayIn(date: string, timezone: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const utcMidnight = Date.UTC(y, m - 1, d)
  let lo = (utcMidnight - 14 * 3_600_000) / MINUTE_MS // local date is before `date`
  let hi = (utcMidnight + 12 * 3_600_000) / MINUTE_MS // local date is `date` (or later)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (localDate(mid * MINUTE_MS, timezone) < date) lo = mid
    else hi = mid
  }
  return new Date(hi * MINUTE_MS).toISOString()
}

export function parseIsoInstant(
  raw: string,
  timezone: string,
): { ok: true; value: string | null; dateOnly: boolean } | { ok: false; code: InstantCode } {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null, dateOnly: false }

  const dateOnly = DATE_ONLY.exec(text)
  if (dateOnly) {
    const [y, m, d] = dateOnly.slice(1).map(Number)
    if (!validDate(y, m, d)) return { ok: false, code: 'date_invalid' }
    return { ok: true, value: startOfDayIn(text, timezone), dateOnly: true }
  }

  const dt = DATE_TIME.exec(text)
  if (!dt) return { ok: false, code: 'date_invalid' }
  const [, ys, ms, ds, hs, mins, ss = '0', frac = '', offset] = dt
  const [y, m, d, h, min, s] = [ys, ms, ds, hs, mins, ss].map(Number)
  if (!validDate(y, m, d) || h > 23 || min > 59 || s > 59) return { ok: false, code: 'date_invalid' }
  if (!offset) return { ok: false, code: 'datetime_missing_offset' }
  let offsetMinutes = 0
  if (offset !== 'Z') {
    const oh = Number(offset.slice(1, 3))
    const om = Number(offset.slice(4, 6))
    if (oh > 14 || om > 59) return { ok: false, code: 'date_invalid' }
    offsetMinutes = (offset[0] === '-' ? -1 : 1) * (oh * 60 + om)
  }
  const millis = Number(frac.padEnd(3, '0') || '0')
  const instant = Date.UTC(y, m - 1, d, h, min, s, millis) - offsetMinutes * MINUTE_MS
  return { ok: true, value: new Date(instant).toISOString(), dateOnly: false }
}
