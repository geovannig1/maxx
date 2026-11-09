/**
 * The outcome CSV column contract. Client-safe: the import screen renders this table
 * and offers CSV_TEMPLATE as a download, so the documentation and the parser cannot drift apart.
 *
 * - The first row is the header. Header names match case-insensitively; surrounding spaces are ignored.
 * - The four required columns must be present and filled on every row. Optional columns may be left
 *   out entirely or left empty. A column not listed here is refused, so a misspelt column is never
 *   silently dropped.
 * - One row is one outcome, identified by `external_id` within the chosen source. Importing a row with
 *   an id already imported into that source updates that outcome; an identical row changes nothing.
 * - Money: exact decimal with a point (`120.50`), no currency symbol, sign or thousands separator.
 *   Empty means "not known" (stored as NULL); `0` means zero.
 * - Times: ISO 8601. `2026-03-08T14:30:00Z` or `2026-03-08T14:30:00-05:00`, or a date alone
 *   (`2026-03-08`), which means the start of that day in the business timezone.
 * - Customer details (name, email, phone) are not accepted: a CSV is never sent to an ad platform, so
 *   Maxx has no use for them.
 */

export interface CsvColumn {
  name: string
  required: boolean
  description: string
}

/** 4 MiB: below the 4.5 MB request body limit of serverless functions on Vercel. */
export const MAX_CSV_BYTES = 4 * 1024 * 1024
/** Data rows per file (the header is not counted). Larger histories are split into several files. */
export const MAX_CSV_ROWS = 10_000

const attribution = (name: string, what: string): CsvColumn => ({
  name, required: false, description: `${what} Kept for diagnostics; up to ${name === 'landing_page' || name === 'referrer' ? 2048 : 512} characters.`,
})

export const CSV_COLUMNS: readonly CsvColumn[] = [
  { name: 'external_id', required: true, description: 'Your system\'s own id for this result (order, lead or booking number). Unique within the file; importing the same id again updates the outcome. Up to 256 characters, no leading or trailing spaces.' },
  { name: 'outcome_type', required: true, description: 'lead, booking, sale, signup, quote, subscription or custom.' },
  { name: 'status', required: true, description: 'pending, confirmed, cancelled or refunded.' },
  { name: 'occurred_at', required: true, description: 'When the result happened: 2026-03-08T14:30:00Z, 2026-03-08T14:30:00-05:00, or a date alone (2026-03-08), read as the start of that day in the business timezone.' },
  { name: 'currency', required: false, description: 'ISO 4217 code of the values, which must be the ad account currency. Empty means the account currency.' },
  { name: 'gross_value', required: false, description: 'Listed, quoted or invoiced value, e.g. 120.50. A point for decimals; no currency symbol or thousands separator. Empty means not known; 0 means zero.' },
  { name: 'collected_value', required: false, description: 'Value actually collected, in the same format. Empty means not known; 0 means nothing was collected.' },
  { name: 'fulfilment_at', required: false, description: 'When the result is delivered or takes place (an appointment time, a delivery date). Same formats as occurred_at.' },
  { name: 'origin', required: false, description: 'website, staff_or_manual or unknown (the default). Recorded as stated; a CSV outcome is never sent to an ad platform.' },
  { name: 'outcome_label', required: false, description: 'Product, service or appointment type. Up to 256 characters.' },
  attribution('fbclid', 'Meta click id, if your system stored it.'),
  attribution('gclid', 'Google click id, if your system stored it.'),
  attribution('utm_source', 'UTM source.'),
  attribution('utm_medium', 'UTM medium.'),
  attribution('utm_campaign', 'UTM campaign.'),
  attribution('utm_content', 'UTM content.'),
  attribution('utm_term', 'UTM term.'),
  attribution('landing_page', 'First page the customer visited.'),
  attribution('referrer', 'Referring page.'),
]

export const CSV_TEMPLATE = [
  'external_id,outcome_type,status,occurred_at,currency,gross_value,collected_value,fulfilment_at,origin,outcome_label',
  'ORDER-1001,sale,confirmed,2026-03-08T14:30:00Z,,120.50,120.50,,website,Gift card',
  'LEAD-2002,lead,pending,2026-03-09,,,,,unknown,Quote request',
].join('\r\n') + '\r\n'
