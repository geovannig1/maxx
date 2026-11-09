import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(
  new URL('../docs/tracking/acuity-attribution-capture.js', import.meta.url),
  'utf8',
)
const TOKEN_ID = '00000000-0000-4000-8000-000000000761'
const TOKEN = `pt1.${TOKEN_ID}.${'a'.repeat(43)}`

class ElementStub {
  attrs: Record<string, string>
  constructor(attrs: Record<string, string>) { this.attrs = { ...attrs } }
  getAttribute(name: string) { return this.attrs[name] ?? null }
  setAttribute(name: string, value: string) { this.attrs[name] = value }
}

function createHarness(options: {
  pageUrl?: string
  storedTokenState?: unknown
  fetchResult?: 'success' | 'failure' | 'malformed'
  captureId?: string
} = {}) {
  const page = new URL(options.pageUrl ?? 'https://example-studio.test/book/')
  const iframe = new ElementStub({ src: 'https://example-studio.as.me/' })
  const storage = new Map<string, string>()
  if (options.storedTokenState !== undefined) {
    storage.set('paid_touch_state', JSON.stringify(options.storedTokenState))
  }
  const fetch = vi.fn(async (_input: string, _init?: RequestInit) => {
    if (_init?.method === 'PATCH') return { ok: true, json: async () => ({ ok: true }) }
    if (options.fetchResult === 'failure') throw new Error('offline')
    if (options.fetchResult === 'malformed') return { ok: true, json: async () => ({ data: { token: 'forged' } }) }
    return {
      ok: true,
      json: async () => ({
        data: {
          token: TOKEN,
          expires_at: new Date(Date.now() + 90 * 24 * 3600_000).toISOString(),
          identity_complete: true,
        },
        conversion_sent: false,
      }),
    }
  })
  const document = {
    referrer: 'https://l.facebook.com/',
    readyState: 'complete',
    documentElement: {},
    cookie: '',
    querySelectorAll(selector: string) {
      if (selector === 'iframe') return [iframe]
      if (selector === 'a[href]') return []
      return []
    },
    addEventListener: vi.fn(),
  }
  const window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: vi.fn(),
    PAID_TOUCH_CONFIG: {
      endpoint: 'https://maxx.example/api/attribution/paid-touch',
      token_field_id: '19999999',
    },
  }
  vm.runInNewContext(source, {
    window,
    document,
    location: {
      href: page.href,
      search: page.search,
    },
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    encodeURIComponent,
    decodeURIComponent,
    fetch,
    crypto: { randomUUID: () => options.captureId ?? '00000000-0000-4000-8000-000000000762' },
    setTimeout: vi.fn(),
    MutationObserver: undefined,
  })
  return { iframe, storage, fetch }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

describe('versioned paid-touch browser capture artifact', () => {
  it('posts one immutable-ID Meta interaction and decorates Acuity only after a signed token returns', async () => {
    const harness = createHarness({
      pageUrl: 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social' +
        '&utm_campaign=Cold&utm_content=Proof&utm_term=Springfield' +
        '&meta_campaign_id=100000000000007&meta_adset_id=100000000000008' +
        '&meta_ad_id=100000000000009&fbclid=IwZXh0bgNhZW0CMTAAAR1',
    })
    expect(harness.iframe.attrs.src).not.toContain('field:19999999')
    await flush()

    expect(harness.fetch).toHaveBeenCalledTimes(2)
    const [endpoint, init] = harness.fetch.mock.calls.find(([, request]) => request?.method === 'POST')!
    expect(endpoint).toBe('https://maxx.example/api/attribution/paid-touch')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      capture_id: '00000000-0000-4000-8000-000000000762',
      source: 'meta',
      utm_medium: 'paid_social',
      meta_campaign_id: '100000000000007',
      meta_adset_id: '100000000000008',
      meta_ad_id: '100000000000009',
      previous_token: null,
    })
    expect(harness.iframe.attrs.src).toContain(`field:19999999=${encodeURIComponent(TOKEN)}`)
    const [, acknowledgement] = harness.fetch.mock.calls.find(([, request]) => request?.method === 'PATCH')!
    expect(JSON.parse(String(acknowledgement?.body))).toMatchObject({
      capture_id: '00000000-0000-4000-8000-000000000762',
      token: TOKEN,
      delivery_status: 'scheduler_decorated',
    })
  })

  it('reuses a valid stored token on a direct revisit without creating a new touch', async () => {
    const harness = createHarness({
      storedTokenState: { token: TOKEN, expires_at: '2099-10-28T21:00:00.000Z', pending: null },
    })
    await flush()
    expect(harness.fetch).not.toHaveBeenCalled()
    expect(harness.iframe.attrs.src).toContain(`field:19999999=${encodeURIComponent(TOKEN)}`)
  })

  it('reuses the resolved capture when the same paid query is reloaded', async () => {
    const pageUrl = 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social' +
      '&utm_campaign=Cold&utm_content=Proof&utm_term=Springfield' +
      '&meta_campaign_id=100000000000007&meta_adset_id=100000000000008' +
      '&meta_ad_id=100000000000009&fbclid=IwZXh0bgNhZW0CMTAAAR1'
    const first = createHarness({ pageUrl })
    await flush()
    const resolvedState = JSON.parse(first.storage.get('paid_touch_state') ?? '{}')
    expect(resolvedState).toMatchObject({
      token: TOKEN,
      capture_id: '00000000-0000-4000-8000-000000000762',
      pending: null,
    })

    const reload = createHarness({
      pageUrl,
      storedTokenState: resolvedState,
      captureId: '00000000-0000-4000-8000-000000000763',
    })
    await flush()

    expect(reload.fetch.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(0)
    expect(reload.fetch.mock.calls.every(([, request]) => request?.method === 'PATCH')).toBe(true)
    expect(reload.iframe.attrs.src).toContain(`field:19999999=${encodeURIComponent(TOKEN)}`)
    expect(JSON.parse(reload.storage.get('paid_touch_state') ?? '{}')).toMatchObject({
      token: TOKEN,
      capture_id: '00000000-0000-4000-8000-000000000762',
      pending: null,
    })
  })

  it('chains a different paid evidence key through the prior resolved token', async () => {
    const first = createHarness({
      pageUrl: 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social&fbclid=FIRSTCLICK',
    })
    await flush()
    const resolvedState = JSON.parse(first.storage.get('paid_touch_state') ?? '{}')

    const next = createHarness({
      pageUrl: 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social&fbclid=SECONDCLICK',
      storedTokenState: resolvedState,
      captureId: '00000000-0000-4000-8000-000000000763',
    })
    await flush()

    const postCalls = next.fetch.mock.calls.filter(([, request]) => request?.method === 'POST')
    expect(postCalls).toHaveLength(1)
    const body = JSON.parse(String(postCalls[0]?.[1]?.body))
    expect(body).toMatchObject({
      capture_id: '00000000-0000-4000-8000-000000000763',
      fbclid: 'SECONDCLICK',
      previous_token: TOKEN,
    })
  })

  it('bounds reload reuse when paid evidence has no unique fbclid', async () => {
    const pageUrl = 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social' +
      '&meta_campaign_id=100000000000007&meta_adset_id=100000000000008&meta_ad_id=100000000000009'
    const evidenceKey = JSON.stringify({
      source: 'meta',
      fbclid: null,
      meta_campaign_id: '100000000000007',
      meta_adset_id: '100000000000008',
      meta_ad_id: '100000000000009',
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    })
    const recentState = {
      token: TOKEN,
      expires_at: '2099-10-28T21:00:00.000Z',
      capture_id: '00000000-0000-4000-8000-000000000762',
      evidence_key: evidenceKey,
      captured_at: new Date(Date.now() - 29 * 60_000).toISOString(),
      scheduler_acknowledged: true,
      pending: null,
    }

    const recentReload = createHarness({ pageUrl, storedTokenState: recentState })
    await flush()
    expect(recentReload.fetch).not.toHaveBeenCalled()

    const laterReload = createHarness({
      pageUrl,
      storedTokenState: { ...recentState, captured_at: new Date(Date.now() - 31 * 60_000).toISOString() },
      captureId: '00000000-0000-4000-8000-000000000763',
    })
    await flush()
    const postCalls = laterReload.fetch.mock.calls.filter(([, request]) => request?.method === 'POST')
    expect(postCalls).toHaveLength(1)
    expect(JSON.parse(String(postCalls[0]?.[1]?.body))).toMatchObject({
      capture_id: '00000000-0000-4000-8000-000000000763',
      previous_token: TOKEN,
    })
  })

  it('blocks stale-token decoration while a newer paid interaction is pending or failed', async () => {
    const harness = createHarness({
      pageUrl: 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social&fbclid=NEWCLICK',
      storedTokenState: { token: TOKEN, expires_at: '2099-10-28T21:00:00.000Z', pending: null },
      fetchResult: 'failure',
    })
    await flush()
    expect(harness.fetch).toHaveBeenCalledOnce()
    expect(harness.iframe.attrs.src).not.toContain('field:19999999')
    expect(JSON.parse(harness.storage.get('paid_touch_state') ?? '{}')).toMatchObject({
      token: TOKEN,
      pending: { capture_id: '00000000-0000-4000-8000-000000000762' },
    })
  })

  it('rejects a malformed endpoint token and never contains a conversion sender', async () => {
    const harness = createHarness({
      pageUrl: 'https://example-studio.test/book/?utm_source=meta&utm_medium=paid_social&fbclid=NEWCLICK',
      fetchResult: 'malformed',
    })
    await flush()
    expect(harness.iframe.attrs.src).not.toContain('field:19999999')
    expect(source).not.toMatch(/AppointmentConfirmed|graph\.facebook|dataLayer\.push/)
  })
})
