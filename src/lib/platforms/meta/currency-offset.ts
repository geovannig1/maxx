import { accountCurrency } from '@/config/business-config'

// Meta's own minor-unit table for budget, bid and spend-cap fields. It is NOT ISO 4217: Meta sends and
// accepts e.g. HUF and TWD in whole units (offset 1) although ISO gives them two decimals, and BHD/JOD
// in hundredths (offset 100) although ISO gives them three. Display formatting keeps using
// Intl/ISO digits (format-currency.ts); anything sent to or read from a Meta money field uses this.
//
// Source: https://developers.facebook.com/docs/marketing-api/currencies ("offset" column), read
// 2026-11-08. A currency missing from that page is not a Meta ad-account currency: refuse it.

const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND'])
const OFFSET_HUNDRED = new Set([
  'DZD', 'ARS', 'AUD', 'BHD', 'BDT', 'BOB', 'BGN', 'BRL', 'GBP', 'CAD', 'CNY', 'HRK', 'CZK', 'DKK',
  'EGP', 'EUR', 'GTQ', 'HNL', 'HKD', 'INR', 'ILS', 'JOD', 'KES', 'LVL', 'LTL', 'MOP', 'MYR', 'MXN',
  'NZD', 'NIO', 'NGN', 'NOK', 'PKR', 'PEN', 'PHP', 'PLN', 'QAR', 'RON', 'RUB', 'SAR', 'RSD', 'SGD',
  'SKK', 'ZAR', 'SEK', 'CHF', 'THB', 'TRY', 'AED', 'UAH', 'USD', 'UYU', 'VEF', 'FBZ', 'VES',
])

/** Meta's offset for `currency` (1 or 100), or null when Meta does not list it as an account currency. */
export function metaCurrencyOffset(currency: string): 1 | 100 | null {
  if (OFFSET_ONE.has(currency)) return 1
  if (OFFSET_HUNDRED.has(currency)) return 100
  return null
}

/** Whether Meta lists `currency` as an ad-account currency. */
export function metaSupportsCurrency(currency: string): boolean {
  return metaCurrencyOffset(currency) !== null
}

function requireOffset(currency: string): number {
  const offset = metaCurrencyOffset(currency)
  if (offset === null) throw new Error(`meta_currency_unsupported: ${currency}`)
  return offset
}

/** A major-unit amount as the integer Meta expects in a budget field. Throws on a non-finite amount or
 *  a currency Meta does not support. */
export function toMetaMinorUnits(amount: number, currency: string = accountCurrency()): number {
  if (!Number.isFinite(amount)) throw new Error('money_amount_not_finite')
  return Math.round(amount * requireOffset(currency))
}

/** A Meta budget/spend-cap field value back in major units. Throws on an unsupported currency. */
export function fromMetaMinorUnits(minor: number, currency: string = accountCurrency()): number {
  return minor / requireOffset(currency)
}
