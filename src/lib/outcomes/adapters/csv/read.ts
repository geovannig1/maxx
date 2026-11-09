import type { NormalizedOutcome } from '@/lib/outcomes/adapter'
import { OUTCOME_STATUSES, OUTCOME_TYPES, type OutcomeOrigin } from '@/lib/outcomes/model'
import { isIsoCurrency } from '@/config/business-config'
import { CSV_COLUMNS, MAX_CSV_ROWS } from './contract'
import { parseCsv, type CsvParseError } from './parse'
import { parseExactDecimal, parseIsoInstant } from './values'
import { exceedsOutcomeMoneyCeiling } from '@/lib/outcomes/money-ceiling'

/**
 * A whole outcome CSV file → validated generic outcomes plus per-row errors. Pure: it
 * reads no database, so the preview and the commit validate a file identically.
 *
 * Errors name the row (spreadsheet numbering, header = 1), the column and a code with a fixed message.
 * They never contain a cell value or a header text, because a cell can carry personal data and errors
 * are returned to the browser and may be logged.
 */

export interface CsvRowError {
  row: number
  /** The contract column, or null for a problem with the whole row. */
  field: string | null
  code: string
  message: string
}

export interface CsvOutcomeRow {
  row: number
  outcome: NormalizedOutcome
}

export type CsvFileErrorCode = CsvParseError | 'no_rows' | 'missing_columns' | 'unknown_columns' | 'duplicate_columns'

export interface CsvFileError {
  code: CsvFileErrorCode
  message: string
  row?: number | null
  /** Contract column names (never header text from the file). */
  columns?: string[]
  /** 1-based positions of header cells that are not contract columns. */
  positions?: number[]
}

export type CsvReadResult =
  | { ok: true; rows: CsvOutcomeRow[]; errors: CsvRowError[]; totalRows: number; invalidRows: number }
  | { ok: false; fileError: CsvFileError }

export interface CsvLocale {
  /** IANA timezone in which a date-only value is read. */
  timezone: string
  /** The ad account currency: the only currency a row may carry. */
  currency: string
}

const FILE_MESSAGES: Record<CsvFileErrorCode, string> = {
  empty_file: 'The file is empty.',
  binary_content: 'The file is not text. Export the sheet as CSV (comma separated, UTF-8) and upload that.',
  unterminated_quote: 'A quoted cell is never closed.',
  invalid_quote: 'A quote appears inside a cell that is not wrapped in quotes, or text follows a closing quote.',
  too_many_rows: `The file has more than ${MAX_CSV_ROWS.toLocaleString('en-US')} rows. Split it into smaller files.`,
  no_rows: 'The file has a header but no rows.',
  missing_columns: 'Required columns are missing.',
  unknown_columns: 'Some columns are not part of the CSV format. Rename or remove them.',
  duplicate_columns: 'A column appears more than once.',
}

const ROW_MESSAGES: Record<string, string> = {
  required: 'This value is required.',
  column_count: 'This row has a different number of cells than the header.',
  duplicate_external_id: 'Another row in this file has the same external_id.',
  invalid_choice: 'This value is not one of the allowed choices.',
  text_whitespace: 'Remove the spaces before or after the id.',
  text_too_long: 'This value is too long.',
  text_control_characters: 'This value contains a line break or another control character.',
  currency_invalid: 'This is not an ISO 4217 currency code (for example USD or EUR).',
  currency_not_account: 'Values must be in the ad account currency; totals in different currencies are never mixed.',
  decimal_separator: 'Write the number with a point for decimals and no thousands separator, e.g. 1200.50.',
  decimal_negative: 'Negative values are not accepted.',
  decimal_too_precise: 'Use at most 6 digits after the decimal point.',
  decimal_too_large: 'This number is too large.',
  decimal_above_ceiling: 'This value is above the outcome money ceiling (OUTCOME_MONEY_CEILING).',
  decimal_invalid: 'This is not a plain number. Write e.g. 120.50, without a currency symbol or sign.',
  date_invalid: 'This is not an ISO 8601 date or time, e.g. 2026-03-08 or 2026-03-08T14:30:00Z.',
  datetime_missing_offset: 'A time needs its timezone: add Z or an offset such as -05:00, or give the date alone.',
}

const COLUMN_NAMES = new Set(CSV_COLUMNS.map((c) => c.name))
const REQUIRED = CSV_COLUMNS.filter((c) => c.required).map((c) => c.name)
const ORIGINS: readonly OutcomeOrigin[] = ['website', 'staff_or_manual', 'unknown']
const CONTROL = /[\u0000-\u001f\u007f]/
const TEXT_LIMITS: Record<string, number> = { external_id: 256, outcome_label: 256, landing_page: 2048, referrer: 2048 }
const textLimit = (field: string) => TEXT_LIMITS[field] ?? 512

const fileError = (code: CsvFileErrorCode, extra: Partial<CsvFileError> = {}): CsvReadResult =>
  ({ ok: false, fileError: { code, message: FILE_MESSAGES[code], ...extra } })

function readHeader(header: string[]): { columns: string[] } | { error: CsvReadResult } {
  const columns = header.map((h) => h.trim().toLowerCase())
  const unknown = columns.flatMap((c, i) => (COLUMN_NAMES.has(c) ? [] : [i + 1]))
  if (unknown.length > 0) return { error: fileError('unknown_columns', { positions: unknown }) }
  const repeated = [...new Set(columns.filter((c, i) => columns.indexOf(c) !== i))]
  if (repeated.length > 0) return { error: fileError('duplicate_columns', { columns: repeated }) }
  const missing = REQUIRED.filter((c) => !columns.includes(c))
  if (missing.length > 0) return { error: fileError('missing_columns', { columns: missing }) }
  return { columns }
}

/** Reads one data row; pushes its errors and returns the outcome when the row is valid. */
function readRow(cells: Record<string, string>, row: number, locale: CsvLocale, errors: CsvRowError[]): NormalizedOutcome | null {
  const before = errors.length
  const fail = (field: string | null, code: string) => errors.push({ row, field, code, message: ROW_MESSAGES[code] })

  const text = (field: string, required = false): string | null => {
    const raw = cells[field] ?? ''
    const value = field === 'external_id' ? raw : raw.trim()
    if (value.trim() === '') {
      if (required) fail(field, 'required')
      return null
    }
    if (CONTROL.test(value)) return (fail(field, 'text_control_characters'), null)
    if (value !== value.trim()) return (fail(field, 'text_whitespace'), null)
    if (value.length > textLimit(field)) return (fail(field, 'text_too_long'), null)
    return value
  }
  const choice = <T extends string>(field: string, allowed: readonly T[], fallback: T | null): T | null => {
    const raw = (cells[field] ?? '').trim().toLowerCase()
    if (raw === '') {
      if (fallback === null) fail(field, 'required')
      return fallback
    }
    if (!(allowed as readonly string[]).includes(raw)) return (fail(field, 'invalid_choice'), null)
    return raw as T
  }
  const decimal = (field: string): string | null => {
    const r = parseExactDecimal(cells[field] ?? '')
    if (!r.ok) return (fail(field, r.code), null)
    if (exceedsOutcomeMoneyCeiling(r.value)) return (fail(field, 'decimal_above_ceiling'), null)
    return r.value
  }
  const instant = (field: string, required: boolean): string | null => {
    const r = parseIsoInstant(cells[field] ?? '', locale.timezone)
    if (!r.ok) return (fail(field, r.code), null)
    if (r.value === null && required) fail(field, 'required')
    return r.value
  }
  const currency = (): string => {
    const raw = (cells.currency ?? '').trim().toUpperCase()
    if (raw === '') return locale.currency
    if (!isIsoCurrency(raw)) fail('currency', 'currency_invalid')
    else if (raw !== locale.currency) fail('currency', 'currency_not_account')
    return raw
  }

  const outcome: NormalizedOutcome = {
    externalId: text('external_id', true) ?? '',
    outcomeType: choice('outcome_type', OUTCOME_TYPES, null) ?? 'custom',
    status: choice('status', OUTCOME_STATUSES, null) ?? 'pending',
    occurredAt: instant('occurred_at', true) ?? '',
    currency: currency(),
    grossValue: decimal('gross_value'),
    collectedValue: decimal('collected_value'),
    fulfilmentAt: instant('fulfilment_at', false),
    fulfilmentStatus: null,
    origin: choice('origin', ORIGINS, 'unknown') ?? 'unknown',
    outcomeLabel: text('outcome_label'),
    attribution: {
      fbclid: text('fbclid'), fbc: null, fbp: null, gclid: text('gclid'),
      utmSource: text('utm_source'), utmMedium: text('utm_medium'), utmCampaign: text('utm_campaign'),
      utmContent: text('utm_content'), utmTerm: text('utm_term'),
      landingPage: text('landing_page'), referrer: text('referrer'),
    },
    customer: { email: null, phone: null, firstName: null, lastName: null },
    conversionEventId: null,
    sourceUpdatedAt: null,
  }
  return errors.length === before ? outcome : null
}

export function readOutcomeCsv(input: string, locale: CsvLocale): CsvReadResult {
  const parsed = parseCsv(input, { maxRecords: MAX_CSV_ROWS + 1 })
  if (!parsed.ok) return fileError(parsed.error, { row: parsed.row })
  const [header, ...data] = parsed.records
  const head = readHeader(header.fields)
  if ('error' in head) return head.error
  if (data.length === 0) return fileError('no_rows')

  const errors: CsvRowError[] = []
  const candidates: CsvOutcomeRow[] = []
  for (const record of data) {
    if (record.fields.length !== head.columns.length) {
      errors.push({ row: record.row, field: null, code: 'column_count', message: ROW_MESSAGES.column_count })
      continue
    }
    const cells = Object.fromEntries(head.columns.map((c, i) => [c, record.fields[i]]))
    const outcome = readRow(cells, record.row, locale, errors)
    if (outcome) candidates.push({ row: record.row, outcome })
  }

  // An external_id is the outcome's identity in its source: two rows with one id cannot both be true,
  // so every row sharing it is refused rather than letting file order pick a winner.
  const idCounts = new Map<string, number>()
  for (const record of data) {
    if (record.fields.length !== head.columns.length) continue
    const id = record.fields[head.columns.indexOf('external_id')]
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  for (const record of data) {
    if (record.fields.length !== head.columns.length) continue
    const id = record.fields[head.columns.indexOf('external_id')]
    if (id && (idCounts.get(id) ?? 0) > 1) {
      errors.push({ row: record.row, field: 'external_id', code: 'duplicate_external_id', message: ROW_MESSAGES.duplicate_external_id })
    }
  }
  const rows = candidates.filter((c) => (idCounts.get(c.outcome.externalId) ?? 0) <= 1)
  errors.sort((a, b) => a.row - b.row)
  const invalidRows = new Set(errors.map((e) => e.row)).size
  return { ok: true, rows, errors, totalRows: data.length, invalidRows }
}
