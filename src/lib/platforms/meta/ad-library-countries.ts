import 'server-only'
import { isCountryCode, parseCountryCodes } from '@/config/countries'
import { META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'
import { fetchMetaGraph } from '@/lib/platforms/meta/client'

// The countries an Ad Library search covers (`ad_reached_countries`). Order of precedence:
//   1. META_AD_LIBRARY_COUNTRIES (ISO 3166-1 alpha-2, comma-separated). An invalid value refuses the
//      search: searching another country than the one configured would be a silent wrong answer.
//   2. The ad account's business country as Meta reports it (`business_country_code`), read once per
//      process through the Meta client (token in the Authorization header, never in the URL).
//   3. US, the previous fixed value, when no account is configured or Meta reports no usable country.

export const DEFAULT_AD_LIBRARY_COUNTRY = 'US'
const ACCOUNT_ID = /^act_\d{1,32}$/

let accountCountry: { accountId: string; code: Promise<string | null> } | null = null

async function readAccountCountry(accountId: string, accessToken: string): Promise<string | null> {
  try {
    const url = `${META_GRAPH_BASE}/${accountId}?${new URLSearchParams({ fields: 'business_country_code' })}`
    const response = await fetchMetaGraph(url, {}, accessToken)
    const body = await response.json() as { business_country_code?: unknown }
    const code = typeof body.business_country_code === 'string' ? body.business_country_code.trim().toUpperCase() : ''
    return isCountryCode(code) ? code : null
  } catch {
    return null
  }
}

/** The countries to search, or null when META_AD_LIBRARY_COUNTRIES is set but invalid. */
export async function resolveAdLibraryCountries(
  accessToken: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string[] | null> {
  const configured = env.META_AD_LIBRARY_COUNTRIES?.trim()
  if (configured) {
    const parsed = parseCountryCodes(configured)
    return parsed.ok ? parsed.codes : null
  }
  const accountId = env.META_AD_ACCOUNT_ID?.trim() ?? ''
  if (!ACCOUNT_ID.test(accountId)) return [DEFAULT_AD_LIBRARY_COUNTRY]
  // Only a usable answer is kept: a failed lookup is tried again on the next search.
  if (accountCountry?.accountId !== accountId) {
    accountCountry = { accountId, code: readAccountCountry(accountId, accessToken) }
  }
  const cached = accountCountry
  const code = await cached.code
  if (code === null && accountCountry === cached) accountCountry = null
  return [code ?? DEFAULT_AD_LIBRARY_COUNTRY]
}
