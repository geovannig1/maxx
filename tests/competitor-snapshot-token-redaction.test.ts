import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Meta's Ad Library API returns ad_snapshot_url with the caller's access token embedded
// (https://www.facebook.com/ads/archive/render_ad/?id=<id>&access_token=<token>). That token can
// manage the ad account, so it must never be stored, sent to the browser, or put in a model prompt.
const EMBEDDED_CREDENTIAL = 'EAA-snapshot-fake-value'
const TOKENISED = `https://www.facebook.com/ads/archive/render_ad/?id=1234567890&access_token=${EMBEDDED_CREDENTIAL}`

describe('redactSnapshotUrl', () => {
  it('removes the access token and keeps the ad id', async () => {
    const { redactSnapshotUrl } = await import('@/lib/competitors/snapshot-url')
    const redacted = redactSnapshotUrl(TOKENISED)
    expect(redacted).not.toContain(EMBEDDED_CREDENTIAL)
    expect(redacted).not.toContain('access_token')
    expect(redacted).toBe('https://www.facebook.com/ads/archive/render_ad/?id=1234567890')
  })

  it('rejects anything that is not an https facebook.com URL', async () => {
    const { redactSnapshotUrl } = await import('@/lib/competitors/snapshot-url')
    expect(redactSnapshotUrl('javascript:alert(1)')).toBeNull()
    expect(redactSnapshotUrl('http://www.facebook.com/ads/archive/render_ad/?id=1')).toBeNull()
    expect(redactSnapshotUrl('https://facebook.com.attacker.example/?id=1')).toBeNull()
    expect(redactSnapshotUrl('not a url')).toBeNull()
    expect(redactSnapshotUrl(null)).toBeNull()
  })

  it('builds the public Ad Library link from a numeric archive id only', async () => {
    const { publicAdLibraryUrl } = await import('@/lib/competitors/snapshot-url')
    expect(publicAdLibraryUrl('1234567890')).toBe('https://www.facebook.com/ads/library/?id=1234567890')
    expect(publicAdLibraryUrl('12&access_token=x')).toBeNull()
    expect(publicAdLibraryUrl(undefined)).toBeNull()
  })
})

describe('competitor ad projection (every API route and MCP tool reads through it)', () => {
  it('never returns the embedded access token', async () => {
    const { projectCompetitorAdRecord } = await import('@/lib/competitors/diagnostic-projection')
    const projected = projectCompetitorAdRecord({ id: 'a', ad_archive_id: '1234567890', ad_snapshot_url: TOKENISED })
    expect(JSON.stringify(projected)).not.toContain(EMBEDDED_CREDENTIAL)
    expect(JSON.stringify(projected)).not.toContain('access_token')
    // Control: the ad identity still comes through.
    expect(projected.ad_archive_id).toBe('1234567890')
  })
})

describe('Ad Library fetcher storage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('META_ACCESS_TOKEN', 'EAA-test-secret-token')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.doUnmock('@/lib/supabase/admin')
  })

  it('stores snapshot URLs without the access token', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({ from: () => ({ upsert }) }) }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(),
      json: async () => ({ data: [{ id: '1234567890', page_id: 'p', ad_snapshot_url: TOKENISED }] }),
    } as Response))
    const { fetchCompetitorAds } = await import('@/lib/platforms/meta/ad-library-fetcher')

    await expect(fetchCompetitorAds('competitor-1', 'page-1')).resolves.toBe(1)
    const rows = upsert.mock.calls[0][0] as Array<Record<string, unknown>>
    expect(JSON.stringify(rows)).not.toContain(EMBEDDED_CREDENTIAL)
    // Control: the row itself was written with its archive id.
    expect(rows[0].ad_archive_id).toBe('1234567890')
  })
})

// Security review: the database CHECK was a blacklist that missed encoded and renamed parameters. It is
// now an allowlist of exactly what redactSnapshotUrl emits, so the redactor must never emit anything
// else: one non-conforming value aborts the fetcher's whole upsert batch.
describe('redactSnapshotUrl output always satisfies the database allowlist', () => {
  const SAMPLE = 'EAAfake0value'
  const HOSTILE = [
    // The previous blacklist's bypasses.
    `https://www.facebook.com/ads/archive/render_ad/?id=1&%61ccess_token=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&access-token=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&accessToken=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&access%255Ftoken=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&%2561ccess_token=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&oauth_token=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&Access%5FToken=${SAMPLE}`,
    // Values smuggled into the id, the path or the fragment.
    `https://www.facebook.com/ads/archive/render_ad/?id=1%26access_token%3D${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad/?id=12abc`,
    `https://www.facebook.com/ads/archive/render_ad/?id=-1`,
    `https://www.facebook.com/ads/archive/render_ad/?id=%31%32`,
    `https://www.facebook.com/ads/archive/render_ad/?id=１２`,
    `https://www.facebook.com/ads/archive/render_ad/?id=&id=7`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1#access_token=${SAMPLE}`,
    `https://www.facebook.com/ads/archive/render_ad;access_token=${SAMPLE}/?id=1`,
    `https://www.facebook.com/ads/archive/render%5Fad/?id=1`,
    `https://www.facebook.com/ads/archive/%2e%2e/render_ad/?id=1`,
    `https://www.facebook.com/ads/archive/render ad/?id=1`,
    `https://www.facebook.com/ads/archive/rénder_ad/?id=1`,
    `https://www.facebook.com/ads/archive/render_ad/:x@y/?id=1`,
    `https://www.facebook.com/ads/archive/render_ad/'x'/?id=1`,
    `https://www.facebook.com/ads/archive/render_ad/?id=1&id=2`,
    // Host, port, userinfo and scheme variants.
    `https://facebook.com:8443/ads/archive/render_ad/?id=1`,
    `https://facebook.com:443/ads/archive/render_ad/?id=1`,
    `https://user:pw@www.facebook.com/ads/archive/render_ad/?id=1`,
    `HTTPS://WWW.FACEBOOK.COM/ads/archive/render_ad/?id=1`,
    `https://facebook.com./ads/archive/render_ad/?id=1`,
    `https://m.facebook.com/ads/archive/render_ad/?id=1`,
    `https://www.facebook.com`,
    `https://www.facebook.com?id=5`,
    `http://www.facebook.com/ads/archive/render_ad/?id=1`,
    `javascript:alert(1)`,
    '',
  ]

  // Deterministic generator: the same seed explores the same thousands of combinations every run.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  function generated(count: number): string[] {
    const rand = mulberry32(20261108)
    const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)]
    const schemes = ['https://', 'HTTPS://', 'http://', 'https:/', 'https:\\\\']
    const users = ['', '', '', 'a@', 'a:b@', '%40@']
    const hosts = ['www.facebook.com', 'facebook.com', 'WWW.Facebook.com', 'facebook.com.', 'xn--facebook-.com', 'facebook.com.evil.test', '[::1]']
    const ports = ['', '', '', ':443', ':8443', ':0']
    const segments = ['ads', 'archive', 'render_ad', 'library', '..', '.', '%2e', '%2F', 'a b', 'ü', ';p=1', '~x', '!', '$', "'", '(', '*', ',', '%00', '@', ':', 'A-Z_0.9']
    const keys = ['id', 'ID', 'access_token', '%61ccess_token', 'accessToken', 'access-token', 'oauth_token', 'access%255Ftoken', 'x', '']
    const values = ['1', '1234567890', '12abc', '', '%31', 'a=b', '1%26b%3D2', SAMPLE, '0'.repeat(40), '-5', '+5']
    const fragments = ['', '', '#', '#access_token=x', '#id=1']
    const out: string[] = []
    for (let n = 0; n < count; n++) {
      const path = Array.from({ length: Math.floor(rand() * 5) }, () => pick(segments)).join('/')
      const query = Array.from({ length: Math.floor(rand() * 4) }, () => `${pick(keys)}=${pick(values)}`).join('&')
      out.push(`${pick(schemes)}${pick(users)}${pick(hosts)}${pick(ports)}/${path}${rand() < 0.3 ? '/' : ''}${query ? `?${query}` : ''}${pick(fragments)}`)
    }
    return out
  }

  it('returns null or a string the migration allowlist accepts, for every hostile input', async () => {
    const { snapshotUrlAllowlist } = await import('./fixtures/snapshot-url-allowlist')
    const { redactSnapshotUrl } = await import('@/lib/competitors/snapshot-url')
    const allowlist = snapshotUrlAllowlist()
    const violations: Array<{ input: string; output: string }> = []
    let emitted = 0
    for (const input of [...HOSTILE, ...generated(5_000)]) {
      const output = redactSnapshotUrl(input)
      if (output === null) continue
      emitted += 1
      if (!allowlist.test(output) || /token/i.test(output)) violations.push({ input, output })
    }
    expect(violations).toEqual([])
    // Control: the generator does produce acceptable URLs, so an always-null redactor cannot pass.
    expect(emitted).toBeGreaterThan(100)
  })

  it('keeps a digits-only id, drops any other id, and refuses paths outside the allowed set', async () => {
    const { redactSnapshotUrl } = await import('@/lib/competitors/snapshot-url')
    expect(redactSnapshotUrl('https://www.facebook.com/ads/archive/render_ad/?id=1234567890&access_token=x'))
      .toBe('https://www.facebook.com/ads/archive/render_ad/?id=1234567890')
    expect(redactSnapshotUrl('https://www.facebook.com/ads/archive/render_ad/?id=12abc'))
      .toBe('https://www.facebook.com/ads/archive/render_ad/')
    expect(redactSnapshotUrl('https://facebook.com:8443/ads/archive/render_ad/?id=1')).toBeNull()
    expect(redactSnapshotUrl('https://www.facebook.com/ads/archive/render%5Fad/?id=1')).toBeNull()
    expect(redactSnapshotUrl(`https://www.facebook.com/ads/archive/render_ad;access_token=${SAMPLE}/?id=1`)).toBeNull()
  })
})
