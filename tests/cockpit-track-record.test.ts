import { describe, expect, it } from 'vitest'
import {
  summarizeTrackRecord,
  TRACK_RECORD_DISPLAY_FLOOR,
  type OutcomeRowInput,
} from '@/lib/cockpit/series-loader'

const row = (overrides: Partial<OutcomeRowInput> = {}): OutcomeRowInput => ({
  flag_type: 'scale',
  metric_name: 'causal_incremental_contribution',
  outcome: 'worked',
  outcome_note: null,
  review_status: 'approved',
  ...overrides,
})

const rows = (play: string, outcome: 'worked' | 'failed', count: number): OutcomeRowInput[] =>
  Array.from({ length: count }, () => row({ flag_type: play, outcome }))

describe('summarizeTrackRecord', () => {
  it('counts only owner-approved, causal-metric, non-estimate outcomes', () => {
    const result = summarizeTrackRecord([
      ...rows('scale', 'worked', 6),
      row({ flag_type: 'scale', metric_name: 'some_other_metric' }),
      row({ flag_type: 'scale', review_status: 'rejected' }),
      row({ flag_type: 'scale', outcome_note: 'estimate-only: GA4 under 50%' }),
      row({ flag_type: 'scale', outcome: null }),
    ])

    expect(result.plays).toEqual([{ play: 'scale', worked: 6, failed: 0, inconclusive: 0 }])
    expect(result.totalDecisive).toBe(6)
  })

  it(`withholds a play below the ${TRACK_RECORD_DISPLAY_FLOOR}-decisive display floor but still counts it`, () => {
    const result = summarizeTrackRecord([...rows('pause', 'worked', 2), ...rows('pause', 'failed', 1)])

    expect(result.plays).toEqual([])
    expect(result.totalDecisive).toBe(3)
  })

  it('counts pending reviews separately and never as record evidence', () => {
    const result = summarizeTrackRecord([
      ...rows('scale', 'worked', 6),
      row({ review_status: 'pending' }),
      row({ review_status: null }),
    ])

    expect(result.pendingReview).toBe(2)
    expect(result.plays).toHaveLength(1)
    expect(result.totalDecisive).toBe(6)
  })

  it('keeps inconclusive outcomes visible but out of the decisive count', () => {
    const result = summarizeTrackRecord([
      ...rows('scale', 'worked', 4),
      ...rows('scale', 'failed', 2),
      row({ flag_type: 'scale', outcome: 'inconclusive' }),
    ])

    expect(result.plays).toEqual([{ play: 'scale', worked: 4, failed: 2, inconclusive: 1 }])
    expect(result.totalDecisive).toBe(6)
  })

  it('ignores unknown outcome values rather than inventing a bucket', () => {
    const result = summarizeTrackRecord([
      ...rows('scale', 'worked', 6),
      row({ flag_type: 'scale', outcome: 'surprised' }),
    ])

    expect(result.totalDecisive).toBe(6)
    expect(result.plays[0]?.inconclusive).toBe(0)
  })
})
