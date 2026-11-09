import { BUSINESS_PROFILE } from '@/config/business-profile'
// Build Acuity scheduler links prefilled with attribution, for direct-to-scheduler placements that
// the on-site capture script (docs/tracking/acuity-attribution-capture.js) can't decorate — e.g. the
// Instagram bio link and the Google Business Profile "Book" link. Acuity prefills custom intake fields
// by NUMERIC field id (`field:ID=value`); the warehouse ledger later reads them back by field name.

export const ATTRIBUTION_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', 'landing_page', 'referrer',
] as const

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number]
export type AdParams = Partial<Record<AttributionKey, string>>
export type FieldIdMap = Partial<Record<AttributionKey, string | number>>

/** The scheduler base for Example Studio (branded Acuity URL). */
export const ACUITY_SCHEDULER_URL = BUSINESS_PROFILE.schedulerUrl

/** Pull recognized ad params out of a URL's query string. */
export function parseAdParams(url: string): AdParams {
  const out: AdParams = {}
  let qs: URLSearchParams
  try {
    qs = new URL(url, ACUITY_SCHEDULER_URL).searchParams
  } catch {
    return out
  }
  for (const key of ATTRIBUTION_KEYS) {
    const v = qs.get(key)
    if (v) out[key] = v
  }
  return out
}

/**
 * Append `field:ID=value` for every attribution param that has BOTH a configured field id and a value.
 * Existing query params on baseUrl are preserved; already-present `field:` prefills are not duplicated.
 */
export function buildDecoratedAcuityUrl(
  baseUrl: string,
  params: AdParams,
  fieldIds: FieldIdMap,
): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return baseUrl
  }
  for (const key of ATTRIBUTION_KEYS) {
    const id = fieldIds[key]
    const val = params[key]
    if (id === undefined || id === null || id === '' || !val) continue
    const fieldKey = `field:${id}`
    if (url.searchParams.has(fieldKey)) continue
    url.searchParams.set(fieldKey, val)
  }
  // URLSearchParams encodes ':' as '%3A'; Acuity expects the literal colon in `field:ID`.
  return url.toString().replace(/field%3A/g, 'field:')
}
