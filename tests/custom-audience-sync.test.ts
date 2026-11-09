import { beforeEach, describe, expect, it, vi } from 'vitest'

const metaMocks = vi.hoisted(() => ({ metaGetPaginated: vi.fn(), rpc: vi.fn() }))

vi.mock('@/lib/platforms/meta/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platforms/meta/client')>()
  return { ...actual, metaGetPaginated: metaMocks.metaGetPaginated }
})
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({ rpc: metaMocks.rpc }),
}))

import { fetchCustomAudiences } from '@/lib/platforms/meta/fetch-custom-audiences'
import { MetaApiError } from '@/lib/platforms/meta/client'
import { buildCustomAudienceRow, upsertCustomAudiences } from '@/lib/sync/upsert-custom-audiences'
import type { MetaCustomAudience } from '@/types/meta-api'

const NOW = '2026-08-16T12:00:00.000Z'

describe('custom audience sync', () => {
  beforeEach(() => {
    metaMocks.metaGetPaginated.mockReset()
    metaMocks.rpc.mockReset()
  })

  it('requests the audience metadata needed to diagnose composition and health', async () => {
    metaMocks.metaGetPaginated.mockResolvedValue([])

    await expect(fetchCustomAudiences('100000000000777')).resolves.toEqual([])
    expect(metaMocks.metaGetPaginated).toHaveBeenCalledWith(
      '/act_100000000000777/customaudiences',
      expect.objectContaining({
        fields: expect.stringContaining('lookalike_spec'),
        limit: '200',
      }),
    )
    const fields = metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields as string
    for (const field of [
      'approximate_count_lower_bound',
      'approximate_count_upper_bound',
      'retention_days',
      'operation_status',
      'delivery_status',
      'time_updated',
    ]) expect(fields).toContain(field)
  })

  it('does not duplicate an existing act_ account prefix', async () => {
    metaMocks.metaGetPaginated.mockResolvedValue([])

    await fetchCustomAudiences('act_100000000000777')

    expect(metaMocks.metaGetPaginated).toHaveBeenCalledWith(
      '/act_100000000000777/customaudiences',
      expect.any(Object),
    )
  })

  it('retries without account_id when Meta does not expose that optional field', async () => {
    metaMocks.metaGetPaginated
      .mockRejectedValueOnce(new MetaApiError({
        code: 100,
        message: '(#100) Tried accessing nonexisting field (account_id)',
      }))
      .mockResolvedValueOnce([])

    await expect(fetchCustomAudiences('100000000000777')).resolves.toEqual([])

    expect(metaMocks.metaGetPaginated).toHaveBeenCalledTimes(2)
    expect(metaMocks.metaGetPaginated.mock.calls[0]?.[1]?.fields).toContain('account_id')
    expect(metaMocks.metaGetPaginated.mock.calls[1]?.[1]?.fields).not.toContain('account_id')
  })

  it('persists failed lookalike status, size bounds, source, retention, and ownership', () => {
    const audience: MetaCustomAudience = {
      id: 'lal-1',
      name: 'Website 1% Lookalike',
      subtype: 'LOOKALIKE',
      account_id: 'untrusted-payload-account',
      approximate_count_lower_bound: -1,
      approximate_count_upper_bound: -1,
      retention_days: 180,
      lookalike_spec: {
        origin: [{ id: 'website-180', name: 'Website Visitors 180 Days' }],
        ratio: 0.01,
      },
      operation_status: { code: 433, description: 'Could not create lookalike' },
      delivery_status: { code: 300, description: 'Not available' },
      time_updated: '2026-08-12T08:40:00-0400',
    }

    expect(buildCustomAudienceRow(audience, {
      adAccountDbId: 'account-db-1',
      metaAccountId: '100000000000777',
      now: NOW,
    })).toMatchObject({
      ad_account_id: 'account-db-1',
      audience_id: 'lal-1',
      subtype: 'LOOKALIKE',
      meta_account_id: '100000000000777',
      source_audience_id: 'website-180',
      source_audience_name: 'Website Visitors 180 Days',
      approximate_count_lower_bound: -1,
      approximate_count_upper_bound: -1,
      retention_days: 180,
      operation_status: { code: 433, description: 'Could not create lookalike' },
      delivery_status: { code: 300, description: 'Not available' },
      meta_updated_at: '2026-08-12T12:40:00.000Z',
      last_synced_at: NOW,
    })
  })

  it('normalizes Meta Unix-second audience timestamps before sending them to Postgres', () => {
    const audience: MetaCustomAudience = {
      id: 'website-180',
      time_updated: '1776830400',
    }

    expect(buildCustomAudienceRow(audience, {
      adAccountDbId: 'account-db-1',
      metaAccountId: '100000000000777',
      now: NOW,
    }).meta_updated_at).toBe('2026-04-22T04:00:00.000Z')
  })

  it('publishes an empty inventory through the atomic replacement RPC', async () => {
    metaMocks.rpc.mockResolvedValue({ data: 0, error: null })

    await expect(upsertCustomAudiences('account-db-1', '100000000000777', [])).resolves.toBe(0)
    expect(metaMocks.rpc).toHaveBeenCalledWith('replace_custom_audience_inventory', expect.objectContaining({
      p_ad_account_id: 'account-db-1',
      p_meta_account_id: '100000000000777',
      p_rows: [],
    }))
  })
})
