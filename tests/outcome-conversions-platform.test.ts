import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Generic outcome conversions are platform-neutral core code. The Meta event
// payload and the Meta credentials (META_*) belong to the Meta platform's conversions capability;
// core reaches them only through the registry.

const db = vi.hoisted(() => ({ pixel: null as string | null }))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { pixel_id: db.pixel } }) }) }) }) }),
  }),
}))

import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'

const conversions = () => requireCapability(getAdPlatform('meta'), 'conversions')

/** Meta-specific vocabulary: environment names, event payload keys and the identity hashing. */
function metaSpecifics(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const patterns = [
    /\bMETA_[A-Z_]+\b/g,
    /\b(?:user_data|action_source|event_source_url|test_event_code|custom_data|event_time)\b/g,
    /\bhash(?:Email|Phone|Name)\b/g,
  ]
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[0]))
}

describe('generic outcome conversions are platform-neutral', () => {
  it('the core module reads no META_* variable and builds no Meta payload', () => {
    expect(metaSpecifics('src/lib/conversions/outcome-conversions.ts')).toEqual([])
  })

  it('control: the same scan finds that vocabulary in the Meta conversions module', () => {
    const found = metaSpecifics('src/lib/platforms/meta/outcome-event.ts')
    expect(found).toEqual(expect.arrayContaining(['META_TEST_EVENT_CODE', 'META_PIXEL_ID', 'user_data', 'hashEmail']))
  })
})

describe('Meta conversions capability: test code and credentials', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.stubEnv('META_PIXEL_ID', '')
    db.pixel = null
  })

  it('reads the test event code from the given environment only', () => {
    expect(conversions().testEventCode({ META_TEST_EVENT_CODE: 'T1' })).toBe('T1')
    expect(conversions().testEventCode({ META_TEST_EVENT_CODE: '' })).toBeNull()
    expect(conversions().testEventCode({})).toBeNull()
  })

  it('prefers the configured pixel and the conversions token, falling back to the general token', async () => {
    await expect(conversions().resolveSendCredentials({
      META_PIXEL_ID: '111', META_CAPI_ACCESS_TOKEN: 'capi', META_ACCESS_TOKEN: 'general',
    })).resolves.toEqual({ destinationId: '111', accessToken: 'capi' })
    await expect(conversions().resolveSendCredentials({ META_PIXEL_ID: '111', META_ACCESS_TOKEN: 'general' }))
      .resolves.toEqual({ destinationId: '111', accessToken: 'general' })
  })

  it('treats an empty conversions token as set (no fallback), and so as unavailable', async () => {
    await expect(conversions().resolveSendCredentials({
      META_PIXEL_ID: '111', META_CAPI_ACCESS_TOKEN: '', META_ACCESS_TOKEN: 'general',
    })).resolves.toEqual({ destinationId: '111', accessToken: null })
  })

  it('falls back to the active account pixel when none is configured, and reports none as null', async () => {
    db.pixel = 'account-pixel'
    await expect(conversions().resolveSendCredentials({ META_ACCESS_TOKEN: 't' }))
      .resolves.toEqual({ destinationId: 'account-pixel', accessToken: 't' })
    db.pixel = null
    await expect(conversions().resolveSendCredentials({})).resolves.toEqual({ destinationId: null, accessToken: null })
  })
})

describe('Meta conversions capability: the outcome event', () => {
  const NOW = Date.parse('2026-11-08T12:00:00Z')
  const OUTCOME = {
    id: '0b6f2a8e-3c4d-4e5f-8a9b-0c1d2e3f4a5b', occurred_at: '2026-11-08T11:00:00Z', gross_value: '19.99',
    currency: 'GBP', email: 'lead@example.test', phone: null, first_name: null, last_name: null,
    fbp: null, fbc: null, landing_page: 'https://example.test/contact',
  }

  it('returns the platform payload with the neutral event identity, time and value', () => {
    const built = conversions().buildOutcomeEvent(OUTCOME, { eventName: 'Lead', nowMs: NOW, testEventCode: 'T1' })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.event).toEqual({
      id: `maxx-${OUTCOME.id}`, timeSec: Date.parse('2026-11-08T11:00:00Z') / 1000, value: 19.99, currency: 'GBP',
    })
    expect(built.payload).toMatchObject({ data: [{ event_id: `maxx-${OUTCOME.id}`, event_name: 'Lead' }], test_event_code: 'T1' })
  })

  it('reports no value when none was observed, and a terminal skip unchanged', () => {
    const none = conversions().buildOutcomeEvent({ ...OUTCOME, gross_value: null }, { eventName: 'Lead', nowMs: NOW })
    expect(none.ok && none.event).toMatchObject({ value: null, currency: null })
    expect(conversions().buildOutcomeEvent({ ...OUTCOME, landing_page: null }, { eventName: 'Lead', nowMs: NOW }))
      .toEqual({ ok: false, skip: 'no_event_source_url' })
  })
})
