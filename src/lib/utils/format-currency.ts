import { accountCurrency, accountLocale } from '@/config/business-config'

// THE money formatter. Amounts are labelled with the account's ISO 4217 currency in the account locale;
// one currency is never relabelled as another. Callers pass `currency` only for an amount that is
// known to be in a different, explicitly stated currency.

export interface MoneyFormatOptions {
  currency?: string
  locale?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  compact?: boolean
}

const cache = new Map<string, Intl.NumberFormat>()

function formatter(options: MoneyFormatOptions): Intl.NumberFormat {
  const currency = options.currency ?? accountCurrency()
  const locale = options.locale ?? accountLocale()
  const key = JSON.stringify([currency, locale, options.minimumFractionDigits, options.maximumFractionDigits, options.compact])
  let format = cache.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      ...(options.compact ? { notation: 'compact' as const } : {}),
      ...(options.minimumFractionDigits !== undefined ? { minimumFractionDigits: options.minimumFractionDigits } : {}),
      ...(options.maximumFractionDigits !== undefined ? { maximumFractionDigits: options.maximumFractionDigits } : {}),
    })
    if (cache.size < 256) cache.set(key, format)
  }
  return format
}

/** A finite amount in the account currency (or `options.currency`), formatted for the account locale. */
export function formatMoney(value: number, options: MoneyFormatOptions = {}): string {
  return formatter(options).format(value)
}

/** A finite amount in the account currency with no decimals when it is whole ("$100", "€71.20"): for prose
 *  that used to print a bare number after a currency sign. */
export function formatMoneyAmount(value: number, options: MoneyFormatOptions = {}): string {
  return Number.isInteger(value) ? formatMoney(value, { ...options, maximumFractionDigits: 0 }) : formatMoney(value, options)
}

/** A finite amount with up to the currency's minor-unit digits and no trailing zeros ("$1,000",
 *  "$1,000.5", "¥1,235", "KWD 3.333"): for prose and totals that drop needless zeros. */
export function formatMoneyTrim(value: number, options: MoneyFormatOptions = {}): string {
  return formatMoney(value, { ...options, minimumFractionDigits: 0, maximumFractionDigits: currencyFractionDigits(options.currency) })
}

/** The currency's minor-unit digits (USD 2, JPY 0, KWD 3), as the runtime knows them. */
export function currencyFractionDigits(currency: string = accountCurrency()): number {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
}

/** An amount in the currency's minor unit (cents for USD, yen for JPY, fils for KWD), rounded to a whole unit. */
export function toMinorUnits(amount: number, currency: string = accountCurrency()): number {
  if (!Number.isFinite(amount)) throw new Error('money_amount_not_finite')
  return Math.round(amount * 10 ** currencyFractionDigits(currency))
}

/** An amount rounded to whole minor units of `currency` (USD 2 decimals, JPY 0, KWD 3), still in major
 *  units. Replaces the two-decimal `Math.round(x * 100) / 100`; non-finite input passes through unchanged. */
export function roundMoney(amount: number, currency: string = accountCurrency()): number {
  const scale = 10 ** currencyFractionDigits(currency)
  return Math.round(amount * scale) / scale
}

/** A minor-unit amount (as Meta returns budgets) back in major units of `currency`. */
export function fromMinorUnits(minor: number, currency: string = accountCurrency()): number {
  return minor / 10 ** currencyFractionDigits(currency)
}

export function formatCurrency(value: number | null | undefined, currency?: string): string {
  if (value == null) return '—'
  return formatMoney(value, { currency })
}

export function formatCompactCurrency(value: number | null | undefined, currency?: string): string {
  if (value == null) return '—'
  if (value >= 1000) return formatMoney(value, { currency, compact: true })
  return formatCurrency(value, currency)
}
