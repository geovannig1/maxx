import { beforeEach, describe, it, expect, vi } from 'vitest'

const metaMocks = vi.hoisted(() => ({ metaGetPaginated: vi.fn() }))

vi.mock('@/lib/platforms/meta/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/meta/client')>()
  return { ...actual, metaGetPaginated: metaMocks.metaGetPaginated }
})

import { MetaApiError } from '@/lib/platforms/meta/client'
import { fetchAdSets } from '@/lib/platforms/meta/fetch-adsets'
import { buildAdsetRow } from '@/lib/sync/upsert-adsets'
import type { MetaAdSet } from '@/types/meta-api'

// The synced targeting spec carries only the CONFIGURED expansion state, in one of two shapes
// depending on ad-set vintage (both live in this account): targeting_automation.advantage_audience
// on modern ad sets, targeting_optimization: "expansion_all" on legacy ones. Neither says what Meta
// ACTUALLY relaxed at delivery. The sibling ad-set field `targeting_optimization_types` does:
//   [{"key":"detailed_targeting","value":1},{"key":"lookalike","value":1}]
//
// inferNarrowAudience() treats it as authoritative over the configured spec — see
// tests/diagnostics/delivery.test.ts.

const ACCOUNT = '00000000-0000-4000-8000-0000000000aa'
const CAMPAIGN_DB_ID = '00000000-0000-4000-8000-0000000000bb'
const NOW = '2026-08-01T12:00:00.000Z'

function metaAdset(overrides: Partial<MetaAdSet> = {}): MetaAdSet {
  return {
    id: '100000000000000012',
    name: 'Warm Engagers | Retargeting',
    campaign_id: 'c-1',
    targeting: { age_min: 18, age_max: 65, custom_audiences: [{ id: '1', name: 'website 180d' }] },
    ...overrides,
  } as MetaAdSet
}

describe('ad set targeting capture', () => {
  it('stores what Meta actually relaxed, not only what was configured', () => {
    const row = buildAdsetRow(
      metaAdset({
        targeting_optimization_types: [
          { key: 'detailed_targeting', value: 1 },
          { key: 'lookalike', value: 1 },
        ],
      } as Partial<MetaAdSet>),
      { adAccountDbId: ACCOUNT, campaignDbId: CAMPAIGN_DB_ID, now: NOW },
    )

    expect(row.targeting_optimization_types).toEqual([
      { key: 'detailed_targeting', value: 1 },
      { key: 'lookalike', value: 1 },
    ])
  })

  it('records null rather than an empty relaxation when Meta returns nothing', () => {
    const row = buildAdsetRow(metaAdset(), {
      adAccountDbId: ACCOUNT,
      campaignDbId: CAMPAIGN_DB_ID,
      now: NOW,
    })

    // Absent must stay distinguishable from "Meta relaxed nothing" — an empty array would assert
    // a fact we never received.
    expect(row.targeting_optimization_types).toBeNull()
  })

  it('still carries the targeting spec through untouched', () => {
    const row = buildAdsetRow(metaAdset(), {
      adAccountDbId: ACCOUNT,
      campaignDbId: CAMPAIGN_DB_ID,
      now: NOW,
    })

    expect(row.targeting).toEqual({
      age_min: 18,
      age_max: 65,
      custom_audiences: [{ id: '1', name: 'website 180d' }],
    })
    expect(row.targeting_last_synced_at).toBe(NOW)
  })
})

describe('ad set targeting fetch', () => {
  beforeEach(() => metaMocks.metaGetPaginated.mockReset())

  it('retries without the optional relaxation field when Graph rejects that field', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        message: '(#100) Tried accessing nonexisting field (targeting_optimization_types)',
        code: 100,
      }))
      .mockResolvedValueOnce([metaAdset({ daily_budget: '9000' })])

    await expect(fetchAdSets('123')).resolves.toEqual([
      expect.objectContaining({ daily_budget: '90' }),
    ])
    expect(metaMocks.metaGetPaginated).toHaveBeenCalledTimes(2)
    expect(metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields).toContain('targeting_optimization_types')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('targeting_optimization_types')
  })

  it('does not retry unrelated Meta errors', async () => {
    metaMocks.metaGetPaginated.mockRejectedValueOnce(new MetaApiError({
      message: 'Invalid OAuth access token',
      code: 190,
    }))

    await expect(fetchAdSets('123')).rejects.toMatchObject({ code: 190 })
    expect(metaMocks.metaGetPaginated).toHaveBeenCalledTimes(1)
  })
})
