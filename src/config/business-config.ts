// The ONE configuration source for business-wide settings: the business timezone and currency
// and the ad-platform conversion that represents an outcome.
//
// Meta reports delivery in the ad account's own timezone and currency, so the active ad account's
// `timezone_name` and `currency` are authoritative wherever the server reads the account. Every
// synchronous path and every browser render cannot read the database, so they read the validated
// environment values below. The two must agree: `businessLocaleFromAccount` refuses a mismatch rather
// than letting one report compute dates in two zones or label one currency as another.
//
// Client-safe and dependency-free: NEXT_PUBLIC_* values are inlined at build time, so the literal
// `process.env.NEXT_PUBLIC_…` reads below must stay literal.

/** The default when nothing is configured. The only timezone literal allowed in `src` (enforced by
 *  tests/business-locale-literals.test.ts). */
export const DEFAULT_BUSINESS_TIMEZONE = 'America/New_York'
export const DEFAULT_BUSINESS_CURRENCY = 'USD'

export const TIMEZONE_ENV = 'NEXT_PUBLIC_ACCOUNT_TIMEZONE'
export const CURRENCY_ENV = 'NEXT_PUBLIC_ACCOUNT_CURRENCY'
export const LOCALE_ENV = 'NEXT_PUBLIC_ACCOUNT_LOCALE'
export const DEFAULT_BUSINESS_LOCALE = 'en-US'

// Every metric claim window is validated through this check, and constructing an Intl formatter per
// call dominated report builds. Only accepted zones are remembered; the cap bounds case variants.
const acceptedTimeZones = new Set<string>()

/** True for an IANA timezone the runtime can format in (e.g. `Europe/Berlin`, `UTC`). */
export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 64) return false
  if (acceptedTimeZones.has(value)) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    if (acceptedTimeZones.size < 1024) acceptedTimeZones.add(value)
    return true
  } catch {
    return false
  }
}

let isoCurrencies: ReadonlySet<string> | null = null

/** True for an upper-case ISO 4217 code the runtime knows (e.g. `EUR`). */
export function isIsoCurrency(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false
  isoCurrencies ??= new Set(Intl.supportedValuesOf('currency'))
  return isoCurrencies.has(value)
}

export class BusinessLocaleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BusinessLocaleError'
  }
}

/** IANA timezone the business and its ad account operate in. All "today / window / business date"
 *  math uses it. An invalid configured value fails loudly instead of silently becoming the default. */
export function accountTimezone(): string {
  const value = process.env.NEXT_PUBLIC_ACCOUNT_TIMEZONE?.trim()
  if (!value) return DEFAULT_BUSINESS_TIMEZONE
  if (!isIanaTimeZone(value)) {
    throw new BusinessLocaleError('business_timezone_invalid', `${TIMEZONE_ENV} must be an IANA timezone such as Europe/Berlin.`)
  }
  return value
}

/** ISO 4217 currency of the ad account and of business totals. Totals in another currency are never
 *  relabelled as this one. */
export function accountCurrency(): string {
  const value = process.env.NEXT_PUBLIC_ACCOUNT_CURRENCY?.trim()
  if (!value) return DEFAULT_BUSINESS_CURRENCY
  if (!isIsoCurrency(value)) {
    throw new BusinessLocaleError('business_currency_invalid', `${CURRENCY_ENV} must be an upper-case ISO 4217 code such as EUR.`)
  }
  return value
}

/** BCP 47 locale for number, money and date formatting on owner screens (e.g. `de-DE`). Formatting
 *  only: it never changes a currency or a timezone. */
export function accountLocale(): string {
  const value = process.env.NEXT_PUBLIC_ACCOUNT_LOCALE?.trim()
  if (!value) return DEFAULT_BUSINESS_LOCALE
  let supported: string[] = []
  try { supported = Intl.NumberFormat.supportedLocalesOf(value) } catch { supported = [] }
  if (supported.length === 0) {
    throw new BusinessLocaleError('business_locale_invalid', `${LOCALE_ENV} must be a BCP 47 locale such as de-DE.`)
  }
  return value
}

export const MIN_SPEND_TO_JUDGE_ENV = 'NEXT_PUBLIC_MIN_SPEND_TO_JUDGE'
export const DEFAULT_MIN_SPEND_TO_JUDGE = 20

/** Spend, in the account currency, below which an entity is too early to judge. Every other spend
 *  floor is a fixed multiple of it (src/config/spend-floors.ts). The default suits USD/EUR-sized currency
 *  units; a JPY account sets something like 3000. An invalid value fails loudly, naming the variable. */
export function minSpendToJudge(): number {
  const value = process.env.NEXT_PUBLIC_MIN_SPEND_TO_JUDGE?.trim()
  if (!value) return DEFAULT_MIN_SPEND_TO_JUDGE
  const amount = Number(value)
  if (!/^\d+(\.\d+)?$/.test(value) || !(amount > 0)) {
    throw new BusinessLocaleError('min_spend_to_judge_invalid', `${MIN_SPEND_TO_JUDGE_ENV} must be a positive amount in the account currency, such as 3000.`)
  }
  return amount
}

export interface BusinessLocale {
  timezone: string
  currency: string
  /** Where the values were read: the active ad account row, or configuration when no row was read. */
  source: 'ad_account' | 'configuration'
}

export function configuredBusinessLocale(): BusinessLocale {
  return { timezone: accountTimezone(), currency: accountCurrency(), source: 'configuration' }
}

/** The locale columns of an `ad_accounts` row. */
export interface AccountLocaleRow {
  timezone_name?: unknown
  currency?: unknown
}

/**
 * PURE. The account's own timezone and currency, checked against configuration. A missing row (or a
 * row read without these columns) falls back to configuration; a present but invalid value, or one
 * that disagrees with configuration, throws a `BusinessLocaleError` naming the variable to set.
 */
export function businessLocaleFromAccount(row: AccountLocaleRow | null | undefined): BusinessLocale {
  const configured = configuredBusinessLocale()
  if (!row || (row.timezone_name == null && row.currency == null)) return configured
  const timezone = row.timezone_name == null ? configured.timezone : row.timezone_name
  const currency = row.currency == null ? configured.currency : String(row.currency).trim().toUpperCase()
  if (!isIanaTimeZone(timezone)) {
    throw new BusinessLocaleError('account_timezone_invalid', 'The ad account has no valid IANA timezone.')
  }
  if (!isIsoCurrency(currency)) {
    throw new BusinessLocaleError('account_currency_invalid', 'The ad account has no valid ISO 4217 currency.')
  }
  if (timezone !== configured.timezone) {
    throw new BusinessLocaleError('business_timezone_mismatch',
      `The ad account reports in ${timezone} but ${TIMEZONE_ENV} resolves to ${configured.timezone}; set ${TIMEZONE_ENV}=${timezone}.`)
  }
  if (currency !== configured.currency) {
    throw new BusinessLocaleError('business_currency_mismatch',
      `The ad account reports in ${currency} but ${CURRENCY_ENV} resolves to ${configured.currency}; set ${CURRENCY_ENV}=${currency}.`)
  }
  return { timezone, currency, source: 'ad_account' }
}

/** Calendar date (YYYY-MM-DD) of an instant in `timezone` (default: the configured business zone).
 *  Returns '' for an unparseable instant. */
export function businessDateOf(instant: string | Date, timezone: string = accountTimezone()): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: timezone })
}

/** Public: the id must reach the browser so server and browser renders count the same Meta actions
 *  (a custom conversion id is not a secret). */
export const OUTCOME_EVENT_ENV = 'NEXT_PUBLIC_META_OUTCOME_EVENT'
/** The Meta pixel event that marked an outcome before the v1 release made it configuration; kept as the default. */
export const DEFAULT_META_OUTCOME_EVENT = 'AppointmentConfirmed'

/**
 * Name of the Meta pixel (custom or standard) event that marks a business outcome, as Meta reports it in
 * Results indicators, actions and pixel event stats. Public so the browser counts the same event as the
 * server. Defaults to AppointmentConfirmed; a malformed value fails loudly.
 */
export function metaOutcomeEventName(): string {
  const value = process.env.NEXT_PUBLIC_META_OUTCOME_EVENT?.trim()
  if (!value) return DEFAULT_META_OUTCOME_EVENT
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new BusinessLocaleError('outcome_event_invalid', `${OUTCOME_EVENT_ENV} must be a Meta event name of letters, digits and underscores, such as Purchase.`)
  }
  return value
}

export const OUTCOME_CONVERSION_ID_ENV = 'NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID'
/** Deprecated name, still accepted. It is not public, so the browser never sees it: set the new name. */
export const DEPRECATED_OUTCOME_CONVERSION_ID_ENV = 'META_APPOINTMENT_CONVERSION_ID'

/**
 * Optional numeric id of the Meta custom conversion that represents a business outcome. Action types
 * carrying this id count as the outcome event in addition to the named event. Empty when unset.
 */
export function metaOutcomeConversionId(): string {
  const value = process.env.NEXT_PUBLIC_META_OUTCOME_CONVERSION_ID?.trim()
    || process.env.META_APPOINTMENT_CONVERSION_ID?.trim()
    || ''
  if (value !== '' && !/^\d{1,32}$/.test(value)) {
    throw new BusinessLocaleError('outcome_conversion_id_invalid', `${OUTCOME_CONVERSION_ID_ENV} must be the numeric id of a Meta custom conversion.`)
  }
  return value
}
