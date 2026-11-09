import { beforeEach, describe, expect, it, vi } from 'vitest'

const metaMocks = vi.hoisted(() => ({ metaGetPaginated: vi.fn() }))

vi.mock('@/lib/platforms/meta/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/meta/client')>()
  return { ...actual, metaGetPaginated: metaMocks.metaGetPaginated }
})

import { MetaApiError } from '@/lib/platforms/meta/client'
import {
  normalizeDeliverySubStatus,
  normalizePersistedDeliverySubStatus,
  type DeliverySubStatusRead,
} from '@/lib/platforms/meta/delivery-sub-status'
import { fetchAdSets } from '@/lib/platforms/meta/fetch-adsets'
import { fetchAds } from '@/lib/platforms/meta/fetch-ads'
import { buildAdsetRow } from '@/lib/sync/upsert-adsets'
import { buildAdRow } from '@/lib/sync/upsert-ads'
import type { MetaAd, MetaAdSet } from '@/types/meta-api'

const ACCOUNT_DB_ID = '00000000-0000-4000-8000-0000000000aa'
const CAMPAIGN_DB_ID = '00000000-0000-4000-8000-0000000000bb'
const ADSET_DB_ID = '00000000-0000-4000-8000-0000000000cc'
const NOW = '2026-08-01T20:00:00.000Z'

function metaAdset(overrides: Record<string, unknown> = {}): MetaAdSet {
  return {
    id: 'adset-1',
    name: 'Cold',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    campaign_id: 'campaign-1',
    ...overrides,
  } as MetaAdSet
}

function metaAd(overrides: Record<string, unknown> = {}): MetaAd {
  return {
    id: 'ad-1',
    name: 'Cold video',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    campaign_id: 'campaign-1',
    adset_id: 'adset-1',
    ...overrides,
  } as MetaAd
}

describe('delivery sub-status normalization', () => {
  it.each<{ name: string; raw: unknown; requested: boolean; expected: DeliverySubStatusRead }>([
    {
      name: 'retains Meta status and substatus codes',
      raw: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
      requested: true,
      expected: {
        read_available: true,
        payload: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
      },
    },
    {
      name: 'represents successful omission as readable with no payload',
      raw: undefined,
      requested: true,
      expected: { read_available: true, payload: null },
    },
    {
      name: 'represents an unrequested field as unavailable',
      raw: undefined,
      requested: false,
      expected: { read_available: false, payload: null },
    },
    {
      name: 'rejects a non-object payload',
      raw: ['warning'],
      requested: true,
      expected: { read_available: false, payload: null },
    },
    {
      name: 'rejects an invalid status value',
      raw: { status: 7, substatuses: [] },
      requested: true,
      expected: { read_available: false, payload: null },
    },
    {
      name: 'rejects non-string substatuses',
      raw: { status: 'warning', substatuses: ['valid', 7] },
      requested: true,
      expected: { read_available: false, payload: null },
    },
  ])('$name', ({ raw, requested, expected }) => {
    expect(normalizeDeliverySubStatus(raw, requested)).toEqual(expected)
  })

  it('rejects a non-canonical stored object instead of widening the persisted type', () => {
    expect(normalizePersistedDeliverySubStatus(
      { unrelated: 'value' },
      true,
      '2026-08-01T20:00:00.000Z',
    )).toEqual({ read_available: false, payload: null, synced_at: null })
  })
})

describe('delivery sub-status fetching', () => {
  beforeEach(() => metaMocks.metaGetPaginated.mockReset())

  it('marks every ad set readable after a successful field request, including omitted payloads', async () => {
    metaMocks.metaGetPaginated.mockResolvedValueOnce([
      metaAdset({
        delivery_sub_status: {
          status: 'warning',
          substatuses: ['budget_limited_learning_fail'],
        },
      }),
      metaAdset({ id: 'adset-2' }),
    ])

    await expect(fetchAdSets('123')).resolves.toEqual([
      expect.objectContaining({
        id: 'adset-1',
        delivery_sub_status_read_available: true,
        delivery_sub_status: {
          status: 'warning',
          substatuses: ['budget_limited_learning_fail'],
        },
      }),
      expect.objectContaining({
        id: 'adset-2',
        delivery_sub_status_read_available: true,
        delivery_sub_status: null,
      }),
    ])
  })

  it('drops only delivery_sub_status when Graph rejects it for ad sets', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        message: '(#100) Tried accessing nonexisting field (delivery_sub_status)',
        code: 100,
      }))
      .mockResolvedValueOnce([metaAdset({ targeting_optimization_types: [{ key: 'lookalike', value: 1 }] })])

    await expect(fetchAdSets('123')).resolves.toEqual([
      expect.objectContaining({
        delivery_sub_status_read_available: false,
        delivery_sub_status: null,
        targeting_optimization_types: [{ key: 'lookalike', value: 1 }],
      }),
    ])
    expect(metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields).toContain('delivery_sub_status')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('delivery_sub_status')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).toContain('targeting_optimization_types')
  })

  it('retains delivery_sub_status when Graph rejects only targeting relaxation', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        message: '(#100) Tried accessing nonexisting field (targeting_optimization_types)',
        code: 100,
      }))
      .mockResolvedValueOnce([metaAdset({
        delivery_sub_status: { status: 'warning', substatuses: ['auction_overlap'] },
      })])

    await expect(fetchAdSets('123')).resolves.toEqual([
      expect.objectContaining({
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['auction_overlap'] },
      }),
    ])
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).toContain('delivery_sub_status')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('targeting_optimization_types')
  })

  it('degrades only a malformed ad-set payload to unavailable', async () => {
    metaMocks.metaGetPaginated.mockResolvedValueOnce([
      metaAdset({ delivery_sub_status: { status: 'warning', substatuses: [9] } }),
      metaAdset({ id: 'adset-2' }),
    ])

    await expect(fetchAdSets('123')).resolves.toEqual([
      expect.objectContaining({ delivery_sub_status_read_available: false, delivery_sub_status: null }),
      expect.objectContaining({ delivery_sub_status_read_available: true, delivery_sub_status: null }),
    ])
  })

  it('applies the same exact-field fallback to ads', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        message: '(#100) Tried accessing nonexisting field (delivery_sub_status)',
        code: 100,
      }))
      .mockResolvedValueOnce([metaAd()])

    await expect(fetchAds('123')).resolves.toEqual([
      expect.objectContaining({ delivery_sub_status_read_available: false, delivery_sub_status: null }),
    ])
    expect(metaMocks.metaGetPaginated).toHaveBeenCalledTimes(2)
    expect(metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields).toContain('delivery_sub_status')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('delivery_sub_status')
  })

  it('normalizes successful ad payloads and omissions', async () => {
    metaMocks.metaGetPaginated.mockResolvedValueOnce([
      metaAd({ delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] } }),
      metaAd({ id: 'ad-2' }),
    ])

    await expect(fetchAds('123')).resolves.toEqual([
      expect.objectContaining({
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
      }),
      expect.objectContaining({
        delivery_sub_status_read_available: true,
        delivery_sub_status: null,
      }),
    ])
  })

  it('does not retry unrelated Meta errors', async () => {
    metaMocks.metaGetPaginated.mockRejectedValueOnce(new MetaApiError({
      message: 'Invalid OAuth access token',
      code: 190,
    }))

    await expect(fetchAds('123')).rejects.toMatchObject({ code: 190 })
    expect(metaMocks.metaGetPaginated).toHaveBeenCalledTimes(1)
  })
})

describe('delivery sub-status persistence rows', () => {
  it.each([
    {
      name: 'current ad-set payload',
      entity: metaAdset({
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
      }),
      expected: {
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
        delivery_sub_status_synced_at: NOW,
      },
    },
    {
      name: 'successful ad-set omission',
      entity: metaAdset({ delivery_sub_status_read_available: true, delivery_sub_status: null }),
      expected: {
        delivery_sub_status_read_available: true,
        delivery_sub_status: null,
        delivery_sub_status_synced_at: NOW,
      },
    },
    {
      name: 'unavailable ad-set read',
      entity: metaAdset({ delivery_sub_status_read_available: false, delivery_sub_status: null }),
      expected: {
        delivery_sub_status_read_available: false,
        delivery_sub_status: null,
        delivery_sub_status_synced_at: null,
      },
    },
  ])('maps $name without inventing state', ({ entity, expected }) => {
    expect(buildAdsetRow(entity, {
      adAccountDbId: ACCOUNT_DB_ID,
      campaignDbId: CAMPAIGN_DB_ID,
      now: NOW,
    })).toEqual(expect.objectContaining(expected))
  })

  it.each([
    {
      name: 'current ad payload',
      entity: metaAd({
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
      }),
      expected: {
        delivery_sub_status_read_available: true,
        delivery_sub_status: { status: 'warning', substatuses: ['creative_fatigue'] },
        delivery_sub_status_synced_at: NOW,
      },
    },
    {
      name: 'successful ad omission',
      entity: metaAd({ delivery_sub_status_read_available: true, delivery_sub_status: null }),
      expected: {
        delivery_sub_status_read_available: true,
        delivery_sub_status: null,
        delivery_sub_status_synced_at: NOW,
      },
    },
    {
      name: 'unavailable ad read',
      entity: metaAd({ delivery_sub_status_read_available: false, delivery_sub_status: null }),
      expected: {
        delivery_sub_status_read_available: false,
        delivery_sub_status: null,
        delivery_sub_status_synced_at: null,
      },
    },
  ])('maps $name without inventing state', ({ entity, expected }) => {
    expect(buildAdRow(entity, {
      adAccountDbId: ACCOUNT_DB_ID,
      campaignDbId: CAMPAIGN_DB_ID,
      adsetDbId: ADSET_DB_ID,
      now: NOW,
    })).toEqual(expect.objectContaining(expected))
  })
})
