import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readPaidTouchAdAssignments } from '@/lib/economics/paid-touch-assignment-reader'
import { summarizePaidTouchBookingLag } from '@/lib/reporting/measurement-lag'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

type Row = Record<string, unknown>
type Result = { data: Row[] | null; error: null; count?: number }
const ACCOUNT = '00000000-0000-4000-8000-000000000001'
const LINK_1 = '00000000-0000-4000-8000-000000000101'
const LINK_2 = '00000000-0000-4000-8000-000000000102'
const LINK_3 = '00000000-0000-4000-8000-000000000103'
const TOUCH_1 = '00000000-0000-4000-8000-000000000201'
const TOUCH_2 = '00000000-0000-4000-8000-000000000202'
const TOUCH_3 = '00000000-0000-4000-8000-000000000203'
const SOURCE = '00000000-0000-4000-8000-000000000301'
const OUTCOME_101 = '00000000-0000-4000-a000-000000000101'
const OUTCOME_102 = '00000000-0000-4000-a000-000000000102'
const OUTCOME_103 = '00000000-0000-4000-a000-000000000103'

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
        then(resolve: (result: Result) => void) {
          const rows = tables[table] ?? []
          if (state.head) resolve({ data: null, error: null, count: rows.length })
          else resolve({ data: rows.slice(state.range[0], state.range[1] + 1), error: null })
        },
      }
      return builder
    },
  } as unknown as SupabaseClient
}

const baseAssignment = {
  outcomeId: oid(101),
  linkId: 'link',
  touchId: 'touch',
  metaCampaignId: '1',
  metaAdsetId: '2',
  metaAdId: '3',
  observedAt: '2026-08-01T10:00:00Z',
  outcomeCreatedAt: '2026-08-01T11:00:00Z',
  linkedAt: '2026-08-01T12:00:00Z',
  policyVersion: 1 as const,
}

describe('measurement paid-touch booking lag', () => {
  it('summarizes lag from actual paid-touch assignment reader output', async () => {
    const read = await readPaidTouchAdAssignments(fakeDb({
      outcome_sources: [{ id: SOURCE }],
      outcomes: [
        { id: OUTCOME_101, external_id: '101' },
        { id: OUTCOME_102, external_id: '102' },
        { id: OUTCOME_103, external_id: '103' },
      ],
      outcome_touch_links: [
        { id: LINK_1, outcome_id: OUTCOME_101, last_touch_id: TOUCH_1, last_interaction_at: '2026-08-01T00:00:00Z', outcome_created_at: '2026-08-02T00:00:00Z', linked_at: '2026-08-02T01:00:00Z', policy_version: 1 },
        { id: LINK_2, outcome_id: OUTCOME_102, last_touch_id: TOUCH_2, last_interaction_at: '2026-08-01T00:00:00Z', outcome_created_at: '2026-08-02T02:09:36Z', linked_at: '2026-08-02T03:00:00Z', policy_version: 1 },
        { id: LINK_3, outcome_id: OUTCOME_103, last_touch_id: TOUCH_3, last_interaction_at: '2026-08-01T00:00:00Z', outcome_created_at: '2026-08-10T00:00:00Z', linked_at: '2026-08-10T01:00:00Z', policy_version: 1 },
      ],
      paid_touch_observations: [
        { id: TOUCH_1, observed_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', identity_complete: true, meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3001' },
        { id: TOUCH_2, observed_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', identity_complete: true, meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3002' },
        { id: TOUCH_3, observed_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z', identity_complete: true, meta_campaign_id: '1001', meta_adset_id: '2001', meta_ad_id: '3003' },
      ],
    }), ACCOUNT, [OUTCOME_101, OUTCOME_102, OUTCOME_103], '2026-08-11T00:00:00Z')

    const summary = summarizePaidTouchBookingLag({ assignments: read.assignments, linkedCount: 3, asOf: '2026-08-11T00:00:00Z' })

    expect(read.assignments.map(row => row.outcomeCreatedAt)).toEqual([
      '2026-08-02T00:00:00Z', '2026-08-02T02:09:36Z', '2026-08-10T00:00:00Z',
    ])
    expect(summary).toMatchObject({ sampleCount: 3, linkedCount: 3, medianDays: 1.1, p90Days: 9, longestDays: 9 })
  })

  it('uses sub-millisecond chronology and rounding instead of Date.parse truncation', () => {
    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-03T00:00:00.000000Z',
      assignments: [{ ...baseAssignment,
        observedAt: '2026-08-01T00:00:00.000999Z',
        outcomeCreatedAt: '2026-08-02T01:12:00.000998Z',
        linkedAt: '2026-08-02T01:12:00.000999Z' }],
    })).toMatchObject({ sampleCount: 1, medianDays: 1, p90Days: 1, longestDays: 1 })

    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00.000000Z',
      assignments: [{ ...baseAssignment,
        observedAt: '2026-08-01T00:00:00.000002Z',
        outcomeCreatedAt: '2026-08-01T00:00:00.000001Z',
        linkedAt: '2026-08-01T00:00:00.000003Z' }],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_chronology_invalid' })
  })



  it('rejects invalid timezone offset minutes while accepting a valid explicit offset', () => {
    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00+00:00',
      assignments: [{ ...baseAssignment,
        observedAt: '2026-08-01T10:00:00+00:60',
        outcomeCreatedAt: '2026-08-01T11:00:00+00:00',
        linkedAt: '2026-08-01T12:00:00+00:00' }],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_chronology_invalid' })

    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00+00:00',
      assignments: [{ ...baseAssignment,
        observedAt: '2026-08-01T10:00:00+00:00',
        outcomeCreatedAt: '2026-08-01T11:00:00+00:00',
        linkedAt: '2026-08-01T12:00:00+00:00' }],
    })).toMatchObject({ sampleCount: 1, medianDays: 0, p90Days: 0, longestDays: 0 })
  })

  it('distinguishes measured zero lag from a missing booking-created timestamp', () => {
    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [{ ...baseAssignment, outcomeCreatedAt: baseAssignment.observedAt, linkedAt: '2026-08-01T10:00:01Z' }],
    })).toMatchObject({ sampleCount: 1, medianDays: 0, p90Days: 0, longestDays: 0 })

    const missingCreatedAt = { ...baseAssignment }
    delete (missingCreatedAt as Partial<typeof baseAssignment>).outcomeCreatedAt
    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [missingCreatedAt],
    })).toMatchObject({ sampleCount: 0, medianDays: null, p90Days: null, longestDays: null,
      blocker: 'paid_touch_booking_lag_sample_unavailable' })
  })

  it('rejects duplicate appointment lag samples and invalid linked counts at the helper boundary', () => {
    const duplicate = { ...baseAssignment, linkId: 'link-2', touchId: 'touch-2' }
    expect(summarizePaidTouchBookingLag({
      linkedCount: 2,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [baseAssignment, duplicate],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_sample_count_invalid' })

    expect(summarizePaidTouchBookingLag({
      linkedCount: -1,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_population_invalid' })
  })

  it('rejects impossible lag sample populations and future retained links', () => {
    const second = { ...baseAssignment, outcomeId: oid(102), linkId: 'link-2', touchId: 'touch-2' }
    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [baseAssignment, second],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_sample_count_invalid' })

    expect(summarizePaidTouchBookingLag({
      linkedCount: 1,
      asOf: '2026-08-02T00:00:00Z',
      assignments: [{ ...baseAssignment, outcomeCreatedAt: '2026-08-01T23:00:00Z', linkedAt: '2026-08-02T00:00:01Z' }],
    })).toMatchObject({ sampleCount: 0, blocker: 'paid_touch_booking_lag_chronology_invalid' })
  })
})
