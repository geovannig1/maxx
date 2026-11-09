import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshSchemaDb } from './db/schema-db'

const metaMocks = vi.hoisted(() => ({ metaGetPaginated: vi.fn() }))

vi.mock('@/lib/platforms/meta/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/meta/client')>()
  return { ...actual, metaGetPaginated: metaMocks.metaGetPaginated }
})

import { MetaApiError } from '@/lib/platforms/meta/client'
import { fetchAds } from '@/lib/platforms/meta/fetch-ads'
import { buildAdRow, preserveDestinationOnUnavailableRead } from '@/lib/sync/upsert-ads'
import { buildAdsetRow } from '@/lib/sync/upsert-adsets'
import { normalizeAdSetupSnapshot, normalizeAdsetSetupSnapshot } from '@/lib/setup-history'
import type { MetaAd, MetaAdSet } from '@/types/meta-api'

const NOW = '2026-08-16T12:00:00.000Z'
const ACCOUNT_DB_ID = '00000000-0000-4000-8000-000000000110'
const CAMPAIGN_DB_ID = '00000000-0000-4000-8000-000000000111'
const ADSET_DB_ID = '00000000-0000-4000-8000-000000000112'

function metaAdset(overrides: Partial<MetaAdSet> = {}): MetaAdSet {
  return {
    id: '211', name: 'Bookings', status: 'ACTIVE', effective_status: 'ACTIVE', campaign_id: '111',
    ...overrides,
  }
}

function metaAd(overrides: Partial<MetaAd> = {}): MetaAd {
  return {
    id: '311', name: 'Book now', status: 'ACTIVE', effective_status: 'ACTIVE',
    campaign_id: '111', adset_id: '211',
    ...overrides,
  }
}

describe('current setup field capture', () => {
  beforeEach(() => metaMocks.metaGetPaginated.mockReset())

  it('persists ad-set attribution exactly and keeps omission unknown', () => {
    const attribution = [
      { event_type: 'CLICK_THROUGH', window_days: 7 },
      { event_type: 'VIEW_THROUGH', window_days: 1 },
    ]
    expect(buildAdsetRow(metaAdset({ attribution_spec: attribution }), {
      adAccountDbId: ACCOUNT_DB_ID, campaignDbId: CAMPAIGN_DB_ID, now: NOW,
    }).attribution_spec).toEqual(attribution)
    expect(buildAdsetRow(metaAdset(), {
      adAccountDbId: ACCOUNT_DB_ID, campaignDbId: CAMPAIGN_DB_ID, now: NOW,
    }).attribution_spec).toBeNull()
  })

  it('persists an ad-level landing destination only with successful field-read provenance', () => {
    expect(buildAdRow(metaAd({
      destination_url: 'https://example.com/book?offer=1', destination_url_read_available: true,
    }), {
      adAccountDbId: ACCOUNT_DB_ID, campaignDbId: CAMPAIGN_DB_ID,
      adsetDbId: ADSET_DB_ID, now: NOW,
    })).toMatchObject({
      destination_url: 'https://example.com/book?offer=1',
      destination_url_read_available: true,
      destination_url_synced_at: NOW,
    })
    expect(buildAdRow(metaAd({ destination_url_read_available: true }), {
      adAccountDbId: ACCOUNT_DB_ID, campaignDbId: CAMPAIGN_DB_ID,
      adsetDbId: ADSET_DB_ID, now: NOW,
    })).toMatchObject({
      destination_url: null,
      destination_url_read_available: true,
      destination_url_synced_at: NOW,
    })

    const unavailable = buildAdRow(metaAd({ destination_url_read_available: false }), {
      adAccountDbId: ACCOUNT_DB_ID, campaignDbId: CAMPAIGN_DB_ID,
      adsetDbId: ADSET_DB_ID, now: NOW,
    })
    expect(unavailable).toMatchObject({
      destination_url: null,
      destination_url_read_available: false,
      destination_url_synced_at: null,
    })
    expect(preserveDestinationOnUnavailableRead(unavailable)).not.toHaveProperty('destination_url')
  })

  it('requests destination_url and degrades to an unknown field when Graph rejects it', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        message: '(#100) Tried accessing nonexisting field (destination_url)',
        code: 100,
      }))
      .mockResolvedValueOnce([metaAd()])

    const result = await fetchAds('123')
    expect(result).toEqual([expect.objectContaining({ id: '311' })])
    expect(result[0].destination_url).toBeUndefined()
    expect(result[0].destination_url_read_available).toBe(false)
    expect(metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields).toContain('destination_url')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('destination_url')
  })

  it('marks an accepted destination field read available even when Meta omits the value', async () => {
    metaMocks.metaGetPaginated.mockResolvedValueOnce([metaAd()])

    const result = await fetchAds('123')

    expect(result[0].destination_url).toBeUndefined()
    expect(result[0].destination_url_read_available).toBe(true)
  })

  it('retains attribution and destination in setup-history fingerprints', () => {
    const attribution = [{ event_type: 'CLICK_THROUGH', window_days: 7 }]
    const adset = normalizeAdsetSetupSnapshot({
      id: ADSET_DB_ID, adset_id: '211', attribution_spec: attribution, last_synced_at: NOW,
    })
    const ad = normalizeAdSetupSnapshot({
      id: '00000000-0000-4000-8000-000000000113', ad_id: '311',
      destination_url: 'https://example.com/book', destination_url_read_available: true,
      destination_url_synced_at: NOW, last_synced_at: NOW,
    })

    expect(adset.config.attribution_spec).toEqual(attribution)
    expect(ad.config.destination_url).toBe('https://example.com/book')
    expect(ad.config.destination_url_read_available).toBe(true)
    expect(ad.config.destination_url_synced_at).toBe(NOW)
  })

  it('keeps setup fields additive and adds destination read provenance in the baseline schema', async () => {
    const db = await freshSchemaDb()
    try {
      const columns = (await db.query<Record<string, string>>(`
        SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND (table_name, column_name) IN (
           ('adsets','attribution_spec'), ('ads','destination_url'),
           ('ads','destination_url_read_available'), ('ads','destination_url_synced_at'))
         ORDER BY table_name, column_name`)).rows
      // Nullable additive columns: an omitted Graph field stays UNKNOWN, never an assumed value.
      expect(columns).toEqual([
        { table_name: 'ads', column_name: 'destination_url', data_type: 'text', is_nullable: 'YES' },
        { table_name: 'ads', column_name: 'destination_url_read_available', data_type: 'boolean', is_nullable: 'YES' },
        { table_name: 'ads', column_name: 'destination_url_synced_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { table_name: 'adsets', column_name: 'attribution_spec', data_type: 'jsonb', is_nullable: 'YES' },
      ])
      const contract = (await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.ads'::regclass AND contype = 'c' AND conname ~ 'destination_url_read_contract'`)).rows
      expect(contract).toEqual([{ conname: 'ads_destination_url_read_contract' }])
    } finally {
      await db.close()
    }
  })
})
