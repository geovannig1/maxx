import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function graphResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    headers: new Headers(),
    json: async () => body,
  } as Response
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('authorization')
}

describe('Meta Graph token transport', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('META_ACCESS_TOKEN', 'EAA-test-secret-token')
    vi.stubEnv('META_APPSECRET_PROOF_ENABLED', '')
    vi.stubEnv('META_APP_SECRET', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps the token out of the first GET URL and sends it in the Authorization header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(graphResponse({ data: { id: '1' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const { metaGet } = await import('@/lib/platforms/meta/client')

    await metaGet('/act_1', { fields: 'id', access_token: 'caller-supplied-token' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [input, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(input).not.toContain('access_token')
    expect(input).not.toContain('caller-supplied-token')
    expect(authorizationHeader(init)).toBe('Bearer EAA-test-secret-token')
  })

  it('strips signed credentials from every paging URL and authenticates each page by header', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(graphResponse({
        data: [{ id: '1' }],
        paging: {
          next: 'https://graph.facebook.com/v25.0/act_1/ads?after=cursor-2&access_token=EAA-leaked-by-meta&appsecret_proof=untrusted-proof',
        },
      }))
      .mockResolvedValueOnce(graphResponse({ data: [{ id: '2' }] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { metaGetPaginated } = await import('@/lib/platforms/meta/client')

    await expect(metaGetPaginated<{ id: string }>('/act_1/ads')).resolves.toEqual([
      { id: '1' },
      { id: '2' },
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchSpy.mock.calls as Array<[string, RequestInit]>) {
      expect(input).not.toContain('access_token')
      expect(input).not.toContain('EAA-leaked-by-meta')
      expect(authorizationHeader(init)).toBe('Bearer EAA-test-secret-token')
    }
    expect(String(fetchSpy.mock.calls[1][0])).not.toContain('untrusted-proof')
  })

  it('recomputes the opt-in appsecret_proof instead of trusting the proof in a paging URL', async () => {
    vi.stubEnv('META_APPSECRET_PROOF_ENABLED', 'true')
    vi.stubEnv('META_APP_SECRET', 'matching-app-secret')
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(graphResponse({
        data: [{ id: '1' }],
        paging: {
          next: 'https://graph.facebook.com/v25.0/act_1/ads?after=cursor-2&appsecret_proof=attacker-proof&access_token=attacker-token',
        },
      }))
      .mockResolvedValueOnce(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { appSecretProof, metaGetPaginated } = await import('@/lib/platforms/meta/client')

    await metaGetPaginated('/act_1/ads')

    const expectedProof = appSecretProof('EAA-test-secret-token')
    for (const [input] of fetchSpy.mock.calls as Array<[string, RequestInit]>) {
      const url = new URL(input)
      expect(url.searchParams.get('access_token')).toBeNull()
      expect(url.searchParams.get('appsecret_proof')).toBe(expectedProof)
      expect(input).not.toContain('attacker-proof')
      expect(input).not.toContain('attacker-token')
    }
  })

  it('fails before network access when the token is absent', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { metaGet, metaGetPaginated } = await import('@/lib/platforms/meta/client')

    await expect(metaGet('/act_1')).rejects.toThrow(/META_ACCESS_TOKEN.*not configured/)
    await expect(metaGetPaginated('/act_1/ads')).rejects.toThrow(/META_ACCESS_TOKEN.*not configured/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a non-Meta paging origin before the bearer token can be exfiltrated', async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(graphResponse({
      data: [{ id: '1' }],
      paging: { next: 'https://attacker.invalid/steal?after=x&access_token=leaked' },
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { metaGetPaginated } = await import('@/lib/platforms/meta/client')

    await expect(metaGetPaginated('/act_1/ads')).rejects.toThrow(/non-Meta Graph URL/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('Meta URL credential source guard', () => {
  it('does not put META_ACCESS_TOKEN into URLs in any production source', async () => {
    const { readFile } = await import('node:fs/promises')
    const files = [
      'src/lib/platforms/meta/client.ts',
      'src/lib/platforms/meta/fetch-meta-recommendations.ts',
      'src/lib/platforms/meta/fetch-dataset-quality.ts',
      'src/lib/platforms/meta/fetch-dataset-stats.ts',
      'src/app/api/sync/midday/route.ts',
      'src/lib/platforms/meta/ad-library-fetcher.ts',
      'src/lib/platforms/meta/page-lookup.ts',
      'src/lib/tracking/health-monitor.ts',
      // A refactor moved the Graph calls of the two files above (and of the write executor) here.
      'src/lib/platforms/meta/pacing.ts',
      'src/lib/platforms/meta/pixel-status.ts',
      'src/lib/platforms/meta/writes.ts',
    ]

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      expect(source, file).not.toMatch(/searchParams\.set\(['"]access_token['"]|access_token:\s*accessToken/)
      expect(source, file).not.toMatch(/fetch\((?:next|cursor)(?:Insights|Campaigns|Adsets)?Url\)/)
    }
  })
})

describe('auxiliary Meta readers use the same token boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('META_ACCESS_TOKEN', 'EAA-auxiliary-secret')
    vi.stubEnv('META_APPSECRET_PROOF_ENABLED', '')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('page lookup sends header auth and no token in the URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(graphResponse({
      data: [{ id: 'page-1', name: 'Studio', instagram_business_account: { username: 'studio' } }],
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { lookupFacebookPageId } = await import('@/lib/platforms/meta/page-lookup')

    await expect(lookupFacebookPageId('@studio')).resolves.toBe('page-1')
    const [input, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(input).not.toContain('access_token')
    expect(input).not.toContain('EAA-auxiliary-secret')
    expect(authorizationHeader(init)).toBe('Bearer EAA-auxiliary-secret')
  })

  it('competitor paging strips Meta-supplied credentials on every page', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(graphResponse({
        data: [],
        paging: {
          next: 'https://graph.facebook.com/v25.0/ads_archive?after=two&access_token=server-copy&appsecret_proof=server-proof',
        },
      }))
      .mockResolvedValueOnce(graphResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await expect(fetchCompetitorAds('competitor-1', 'page-1')).resolves.toBe(0)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchSpy.mock.calls as Array<[string, RequestInit]>) {
      expect(input).not.toContain('access_token')
      expect(input).not.toContain('server-copy')
      expect(input).not.toContain('server-proof')
      expect(authorizationHeader(init)).toBe('Bearer EAA-auxiliary-secret')
    }
  })

  it('auxiliary readers make no network call without a token', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { lookupFacebookPageId } = await import('@/lib/platforms/meta/page-lookup')
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await expect(lookupFacebookPageId('@studio')).resolves.toBeNull()
    await expect(fetchCompetitorAds('competitor-1', 'page-1')).resolves.toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('tracking health reports configuration unavailable without attempting an unauthenticated call', async () => {
    vi.stubEnv('META_ACCESS_TOKEN', '')
    vi.stubEnv('META_PIXEL_ID', 'pixel-1')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: vi.fn() }))
    const { checkTrackingHealth } = await import('@/lib/tracking/health-monitor')

    const result = await checkTrackingHealth('account-1')

    expect(result.status).toBe('critical')
    expect(result.issues).toContain('META_ACCESS_TOKEN not configured — Meta pixel health is unavailable')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
