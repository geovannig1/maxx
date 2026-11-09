import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readPaidTouchAdAssignments } from '@/lib/economics/paid-touch-assignment-reader'

type Row = Record<string, unknown>
const ACCOUNT = '00000000-0000-4000-8000-000000000001'
const LINK = '00000000-0000-4000-8000-000000000002'
const TOUCH = '00000000-0000-4000-8000-000000000003'
const SOURCE = '00000000-0000-4000-8000-000000000004'
const OUTCOME_101 = '00000000-0000-4000-8000-000000000101'
const OUTCOME_202 = '00000000-0000-4000-8000-000000000202'
// The Acuity source and the outcome recorded for appointment 101 (appointment 202 has none).
const IDENTITY = {
  outcome_sources: [{ id: SOURCE }],
  outcomes: [{ id: OUTCOME_101, external_id: '101' }],
}

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const state = { head: false, range: [0, 999] as [number, number] }
      const builder = {
        select(_columns: string, options?: { head?: boolean }) {
          state.head = options?.head === true
          return this
        },
        eq() { return this },
        in() { return this },
        lte() { return this },
        order() { return this },
        range(from: number, to: number) { state.range = [from, to]; return this },
        maybeSingle() { return Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }) },
        then(resolve: (result: { data: Row[] | null; error: null; count?: number }) => void) {
          const rows = tables[table] ?? []
          if (state.head) resolve({ data: null, error: null, count: rows.length })
          else resolve({ data: rows.slice(state.range[0], state.range[1] + 1), error: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

describe('paid-touch ad assignment reader', () => {
  it('resolves only immutable, complete Meta identity before the as-of cut', async () => {
    const result = await readPaidTouchAdAssignments(fakeDb({
      ...IDENTITY,
      outcome_touch_links: [{
        id: LINK, outcome_id: OUTCOME_101, last_touch_id: TOUCH,
        last_interaction_at: '2026-08-01T10:00:00Z',
        outcome_created_at: '2026-08-01T11:00:00Z',
        linked_at: '2026-08-01T12:00:00Z', policy_version: 1,
      }],
      paid_touch_observations: [{
        id: TOUCH, observed_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00Z', identity_complete: true,
        meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3001',
      }],
    }), ACCOUNT, [OUTCOME_101, OUTCOME_202], '2026-08-02T00:00:00Z')
    expect(result.assignments).toEqual([expect.objectContaining({
      outcomeId: OUTCOME_101, metaCampaignId: '1001', metaAdsetId: '2001', metaAdId: '3001',
      observedAt: '2026-08-01T10:00:00Z', outcomeCreatedAt: '2026-08-01T11:00:00Z', linkedAt: '2026-08-01T12:00:00Z',
    })])
    expect(result.unassignedOutcomeIds).toEqual([OUTCOME_202])
    expect(result.incompleteIdentityOutcomeIds).toEqual([])
  })

  it('does not promote a linked touch with incomplete ad identity', async () => {
    const result = await readPaidTouchAdAssignments(fakeDb({
      ...IDENTITY,
      outcome_touch_links: [{
        id: LINK, outcome_id: OUTCOME_101, last_touch_id: TOUCH,
        last_interaction_at: '2026-08-01T10:00:00Z',
        outcome_created_at: '2026-08-01T11:00:00Z',
        linked_at: '2026-08-01T12:00:00Z', policy_version: 1,
      }],
      paid_touch_observations: [{
        id: TOUCH, observed_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00Z', identity_complete: false,
        meta_campaign_id: '1001', meta_adset_id: null, meta_ad_id: null,
      }],
    }), ACCOUNT, [OUTCOME_101], '2026-08-02T00:00:00Z')
    expect(result.assignments).toEqual([])
    expect(result.incompleteIdentityOutcomeIds).toEqual([OUTCOME_101])
    expect(result.unassignedOutcomeIds).toEqual([OUTCOME_101])
  })





  it('rejects invalid timezone offset minutes in retained link timestamps', async () => {
    await expect(readPaidTouchAdAssignments(fakeDb({
      ...IDENTITY,
      outcome_touch_links: [{
        id: LINK, outcome_id: OUTCOME_101, last_touch_id: TOUCH,
        last_interaction_at: '2026-08-01T10:00:00+00:60',
        outcome_created_at: '2026-08-01T11:00:00+00:00',
        linked_at: '2026-08-01T12:00:00+00:00', policy_version: 1,
      }],
      paid_touch_observations: [{
        id: TOUCH, observed_at: '2026-08-01T10:00:00+00:00', created_at: '2026-08-01T10:00:00+00:00',
        identity_complete: true, meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3001',
      }],
    }), ACCOUNT, [OUTCOME_101], '2026-08-02T00:00:00+00:00')).rejects.toThrow(/timestamp is invalid|Malformed paid-touch link row/i)
  })

  it('rejects a paid link that is linked after the as-of cut even if the mock query returns it', async () => {
    await expect(readPaidTouchAdAssignments(fakeDb({
      ...IDENTITY,
      outcome_touch_links: [{
        id: LINK, outcome_id: OUTCOME_101, last_touch_id: TOUCH,
        last_interaction_at: '2026-08-01T10:00:00Z',
        outcome_created_at: '2026-08-01T11:00:00Z',
        linked_at: '2026-08-02T00:00:00.000001Z', policy_version: 1,
      }],
      paid_touch_observations: [{
        id: TOUCH, observed_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00Z',
        identity_complete: true, meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3001',
      }],
    }), ACCOUNT, [OUTCOME_101], '2026-08-02T00:00:00Z')).rejects.toThrow(/linked after the as-of cut/i)
  })

  it('rejects a touch that was recorded after the requested as-of cut', async () => {
    await expect(readPaidTouchAdAssignments(fakeDb({
      ...IDENTITY,
      outcome_touch_links: [{
        id: LINK, outcome_id: OUTCOME_101, last_touch_id: TOUCH,
        last_interaction_at: '2026-08-01T10:00:00Z',
        outcome_created_at: '2026-08-01T11:00:00Z',
        linked_at: '2026-08-01T12:00:00Z', policy_version: 1,
      }],
      paid_touch_observations: [{
        id: TOUCH, observed_at: '2026-08-01T10:00:00Z', created_at: '2026-08-03T10:00:00Z',
        identity_complete: true, meta_campaign_id: '1001',
        meta_adset_id: '2001', meta_ad_id: '3001',
      }],
    }), ACCOUNT, [OUTCOME_101], '2026-08-02T00:00:00Z')).rejects.toThrow(/recorded after the as-of cut/i)
  })
})
