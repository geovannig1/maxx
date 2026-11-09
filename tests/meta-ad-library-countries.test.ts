import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISO_3166_ALPHA2, parseCountryCodes } from '@/config/countries'
import { formats } from '@/config/env-spec'

// the Ad Library search used to hard-code `ad_reached_countries: ["US"]`. The countries now come
// from META_AD_LIBRARY_COUNTRIES, else the ad account's business country as Meta reports it, else US.
// Every URL still goes through the Meta client (token in the Authorization header, never the URL).

function graphResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => body } as Response
}

const reachedCountries = (input: string): unknown =>
  JSON.parse(new URL(input).searchParams.get('ad_reached_countries') ?? 'null')

describe('ISO 3166-1 alpha-2 country list', () => {
  it('has the 249 assigned codes, each a region Intl can name', () => {
    expect(ISO_3166_ALPHA2.size).toBe(249)
    const names = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
    for (const code of ISO_3166_ALPHA2) expect(names.of(code), code).toBeTruthy()
  })

  it('parses a comma-separated list, upper-cases, trims and removes duplicates', () => {
    expect(parseCountryCodes(' de, AT ,de')).toEqual({ ok: true, codes: ['DE', 'AT'] })
  })

  it('controls: refuses reserved or invented codes, empty items and an empty list', () => {
    for (const bad of ['UK', 'EU', 'XX', 'USA', 'D', 'DE,,AT', 'DE;AT', '', ' , ']) {
      expect(parseCountryCodes(bad).ok, bad).toBe(false)
    }
  })

  it('the env format accepts the same values the parser accepts', () => {
    expect(formats.countryCodes.schema.safeParse('DE,AT').success).toBe(true)
    expect(formats.countryCodes.schema.safeParse('DE,UK').success).toBe(false)
  })
})

describe('Ad Library countries', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('META_ACCESS_TOKEN', 'EAA-ad-library-secret')
    vi.stubEnv('META_APPSECRET_PROOF_ENABLED', '')
    vi.stubEnv('META_AD_LIBRARY_COUNTRIES', '')
    vi.stubEnv('META_AD_ACCOUNT_ID', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('uses the configured countries and makes no account lookup', async () => {
    vi.stubEnv('META_AD_LIBRARY_COUNTRIES', 'de,AT')
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    const fetchSpy = vi.fn().mockResolvedValue(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await expect(fetchCompetitorAds('competitor-1', 'page-1')).resolves.toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [input, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(new URL(input).pathname).toMatch(/\/ads_archive$/)
    expect(reachedCountries(input)).toEqual(['DE', 'AT'])
    expect(input).not.toContain('access_token')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer EAA-ad-library-secret')
  })

  it('defaults to the ad account business country reported by Meta, read through the Meta client', async () => {
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(graphResponse({ id: 'act_123', business_country_code: 'FR' }))
      .mockResolvedValueOnce(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await fetchCompetitorAds('competitor-1', 'page-1')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [lookup, lookupInit] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(new URL(lookup).pathname).toMatch(/\/act_123$/)
    expect(new URL(lookup).searchParams.get('fields')).toBe('business_country_code')
    expect(lookup).not.toContain('access_token')
    expect(new Headers(lookupInit.headers).get('authorization')).toBe('Bearer EAA-ad-library-secret')
    expect(reachedCountries((fetchSpy.mock.calls[1] as [string])[0])).toEqual(['FR'])
  })

  it('looks the account country up once per process', async () => {
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(graphResponse({ business_country_code: 'FR' }))
      .mockResolvedValue(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await fetchCompetitorAds('competitor-1', 'page-1')
    await fetchCompetitorAds('competitor-2', 'page-2')
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(reachedCountries((fetchSpy.mock.calls[2] as [string])[0])).toEqual(['FR'])
  })

  it('falls back to US when Meta reports no usable country, or no account is configured', async () => {
    for (const account of [{ business_country_code: 'ZZ' }, {}, { error: { message: 'no', code: 100 } }]) {
      vi.resetModules()
      vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
      const fetchSpy = vi.fn()
        .mockResolvedValueOnce(graphResponse(account))
        .mockResolvedValueOnce(graphResponse({ data: [] }))
      vi.stubGlobal('fetch', fetchSpy)
      const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')
      await fetchCompetitorAds('competitor-1', 'page-1')
      expect(reachedCountries((fetchSpy.mock.calls[1] as [string])[0]), JSON.stringify(account)).toEqual(['US'])
    }

    vi.resetModules()
    vi.stubEnv('META_AD_ACCOUNT_ID', '')
    const fetchSpy = vi.fn().mockResolvedValue(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')
    await fetchCompetitorAds('competitor-1', 'page-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(reachedCountries((fetchSpy.mock.calls[0] as [string])[0])).toEqual(['US'])
  })

  it('refuses an invalid configured list without any network call, naming only the variable', async () => {
    vi.stubEnv('META_AD_LIBRARY_COUNTRIES', 'DE,UK')
    vi.stubEnv('META_AD_ACCOUNT_ID', 'act_123')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await expect(fetchCompetitorAds('competitor-1', 'page-1')).resolves.toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('META_AD_LIBRARY_COUNTRIES')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('UK')
  })
})
