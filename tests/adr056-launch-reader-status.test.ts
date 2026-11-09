import { describe, expect, it, vi } from 'vitest'

// @ts-expect-error Vitest supports a virtual module option for Next's server-only boundary.
vi.mock('server-only', () => ({}), { virtual: true })

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({
    ok: true,
    account: { id: 'account-db-id', accountId: 'act_123', accountName: 'Example Studio' },
  })),
  activeAccountErrorCode: vi.fn((reason: string) => reason),
}))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: vi.fn() }))

const taggedMetaIds = [
  '100000000000000013',
  '100000000000000014',
  '100000000000000015',
  '100000000000000016',
]

const tagged = Array.from({ length: 4 }, (_, index) => ({
  id: `new-${index}`,
  ad_id: taggedMetaIds[index],
  adset_id: `adset-${index}`,
  ad_name: `${index % 2 === 0 ? 'Warm' : 'Cold'} | Creative ${index} renamed after launch`,
  meta_creative_id: `creative-${index}`,
  meta_created_time: `2026-08-13T09:17:${String(24 + index).padStart(2, '0')}-04:00`,
  meta_updated_time: '2026-08-13T10:02:22-04:00',
  effective_status: 'PAUSED',
  ad_account_id: 'account-db-id',
}))

const predecessors = tagged.map((ad, index) => ({
  ...ad,
  id: `old-${index}`,
  ad_id: `meta-old-${index}`,
  ad_name: `${index % 2 === 0 ? 'Warm' : 'Cold'} | Creative ${index}`,
  meta_created_time: '2026-06-01T12:00:00-04:00',
  effective_status: 'ACTIVE',
}))

function fakeDb(syncLogs: Array<Record<string, unknown>> = [{
  ad_account_id: 'account-db-id', status: 'success',
  date_range_start: '2026-08-01', date_range_end: '2026-08-14',
  completed_at: '2026-08-16T10:00:00Z',
}]) {
  const accountDates = Array.from({ length: 14 }, (_, index) => ({
    ad_account_id: 'account-db-id',
    entity_level: 'account',
    date_start: `2026-08-${String(index + 1).padStart(2, '0')}`,
  }))
  const rows: Record<string, Array<Record<string, unknown>>> = {
    ads: [...tagged, ...predecessors],
    daily_insights: accountDates,
    ad_accounts: [{ id: 'account-db-id', last_synced_at: '2026-08-15T10:00:00Z' }],
    api_sync_logs: syncLogs,
    adsets: tagged.map((ad) => ({
      ad_account_id: 'account-db-id', id: ad.adset_id, learning_stage: 'LEARNING',
    })),
  }

  return {
    from(table: string) {
      let selected = [...(rows[table] ?? [])]
      const builder = {
        select() { return builder },
        eq(column: string, value: unknown) {
          selected = selected.filter((row) => row[column] === value)
          return builder
        },
        gte(column: string, value: unknown) {
          selected = selected.filter((row) => String(row[column]) >= String(value))
          return builder
        },
        lte(column: string, value: unknown) {
          selected = selected.filter((row) => String(row[column]) <= String(value))
          return builder
        },
        order() { return builder },
        limit() { return builder },
        maybeSingle: async () => ({ data: selected[0] ?? null, error: null }),
        then(resolve: (result: { data: typeof selected; error: null }) => unknown) {
          return Promise.resolve({ data: selected, error: null }).then(resolve)
        },
      }
      return builder
    },
  }
}

describe('ADR-056 production reader historical identity', () => {
  it('reads the historical cohort when tagged ads are no longer active', async () => {
    const { readAdr056LaunchComparison } = await import('@/lib/launch/adr056-launch-reader')
    const result = await readAdr056LaunchComparison(
      { lastClosedDate: '2026-08-14' },
      fakeDb() as never,
    )

    expect(result.status).toBe('partial')
    expect(result.blockers).toContain('cohort_ad_insight_days_missing')
    expect(result.taggedAds).toHaveLength(4)
    expect(result.taggedAds.every((ad) => ad.effectiveStatus === 'PAUSED')).toBe(true)
    expect(result.predecessorAds).toHaveLength(4)
    expect(result.source.lastSyncedAt).toBe('2026-08-16T10:00:00Z')
  })

  it('does not treat the account ingest timestamp as freshness without a successful covering generation', async () => {
    const { readAdr056LaunchComparison } = await import('@/lib/launch/adr056-launch-reader')
    const result = await readAdr056LaunchComparison(
      { lastClosedDate: '2026-08-14' },
      fakeDb([]) as never,
    )

    expect(result.source.lastSyncedAt).toBeNull()
    expect(result.blockers).toContain('source_generation_window_uncovered')
  })
})
