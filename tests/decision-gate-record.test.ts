import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import {
  DECISION_GATE_NAMES,
  buildDecisionGateRecord,
  canRunLiveDecisionPipeline,
} from '@/lib/sync/orchestrator'
import { blockerLabel } from '@/lib/diagnostics/blocker-labels'
import { isCoverageBlockerCode } from '@/lib/sync/upsert-insights'

const ALL_OPEN = {
  lifecycleRun: true,
  insightLevelsComplete: true,
  metaOutcomeMetricsComplete: true,
  paidCohortPublished: true,
}

describe('decision gate record', () => {
  it('names every gate that canRunLiveDecisionPipeline reads', () => {
    // If a fifth input is ever ANDed into the gate without being added here, the record would report a
    // live verdict on a frozen pipeline — the exact blind spot this record exists to close.
    expect([...DECISION_GATE_NAMES]).toEqual([
      'lifecycleRun',
      'insightLevelsComplete',
      'metaOutcomeMetricsComplete',
      'paidCohortPublished',
    ])
    const source = fs.readFileSync('src/lib/sync/orchestrator.ts', 'utf8')
    const body = source.match(/export function canRunLiveDecisionPipeline\([\s\S]*?\n}/)?.[0] ?? ''
    for (const name of DECISION_GATE_NAMES) expect(body).toContain(name)
  })

  it('agrees with the gate function on every combination of its inputs', () => {
    for (let mask = 0; mask < 16; mask++) {
      const gates = Object.fromEntries(
        DECISION_GATE_NAMES.map((name, i) => [name, Boolean(mask & (1 << i))]),
      ) as Record<(typeof DECISION_GATE_NAMES)[number], boolean>
      const record = buildDecisionGateRecord(gates, [], '2026-08-19T00:00:00.000Z')
      const expected = canRunLiveDecisionPipeline(
        gates.lifecycleRun,
        gates.insightLevelsComplete,
        gates.metaOutcomeMetricsComplete,
        gates.paidCohortPublished,
      )
      expect(record.verdict).toBe(expected ? 'live' : 'frozen')
      expect(record.closedBy.length === 0).toBe(expected)
    }
  })

  it('lists EVERY closed gate, not just the first', () => {
    // "Clear this one and advice resumes" is only true when closedBy has a single entry. Reporting the
    // first false gate would have made that claim on a run with three of them closed.
    const record = buildDecisionGateRecord(
      { ...ALL_OPEN, insightLevelsComplete: false, paidCohortPublished: false },
      [],
      '2026-08-19T00:00:00.000Z',
    )
    expect(record.closedBy).toEqual(['insightLevelsComplete', 'paidCohortPublished'])
  })

  it('carries the conversion blockers that explain a closed outcome gate', () => {
    const record = buildDecisionGateRecord(
      { ...ALL_OPEN, metaOutcomeMetricsComplete: false },
      ['meta_outcome_ad_value_unavailable:2026-08-15'],
      '2026-08-19T00:00:00.000Z',
    )
    expect(record.verdict).toBe('frozen')
    expect(record.closedBy).toEqual(['metaOutcomeMetricsComplete'])
    expect(record.metaOutcomeBlockerCodes).toEqual(['meta_outcome_ad_value_unavailable:2026-08-15'])
  })
})

describe('meta outcome blocker labels', () => {
  it('renders level and date in the owner\'s language, with no raw token left', () => {
    expect(blockerLabel('meta_outcome_ad_value_unavailable:2026-08-15'))
      .toBe('Meta reported a booking but no booking value (ad level, 2026-08-15)')
    expect(blockerLabel('meta_outcome_adset_value_mismatch:2026-08-11'))
      .toBe('booking value disagrees between reporting levels (ad set level, 2026-08-11)')
    expect(blockerLabel('meta_outcome_campaign_source_unavailable'))
      .toBe('Meta returned nothing at this reporting level (campaign level)')
  })

  it('degrades an unknown code to words rather than a bare enum token', () => {
    expect(blockerLabel('meta_outcome_ad_some_future_reason:2026-08-15'))
      .not.toMatch(/_/)
    expect(blockerLabel('totally_unknown_code')).toBe('totally unknown code')
  })
})

describe('outcome-plane coverage split (policy v1)', () => {
  it('classifies every blocker reason as exactly one of coverage or integrity', () => {
    // A code that is neither would silently disappear from both lists.
    const codes = [
      'meta_outcome_ad_value_unavailable:2026-08-15',
      'meta_outcome_campaign_value_unavailable',
      'meta_outcome_adset_value_mismatch:2026-08-11',
      'meta_outcome_ad_payload_invalid:2026-08-01',
      'meta_outcome_campaign_source_unavailable',
      'meta_outcome_account_rollup_failed',
      'meta_outcome_ad_attribution_split_unavailable:2026-08-02',
      'meta_outcome_campaign_appointment_results_unavailable',
    ]
    const coverage = codes.filter(isCoverageBlockerCode)
    const integrity = codes.filter((c) => !isCoverageBlockerCode(c))
    expect(coverage.length + integrity.length).toBe(codes.length)
    expect(coverage).toEqual([
      'meta_outcome_ad_value_unavailable:2026-08-15',
      'meta_outcome_campaign_value_unavailable',
    ])
  })

  it('does NOT downgrade attribution_split_unavailable', () => {
    // Raised in review as an absence, and it partly is — but one code covers both "Meta sent no
    // partition" (absence) and "the partition does not sum to its own total" (incoherence).
    // Reclassifying it wholesale would downgrade the second. It stays integrity until the code is
    // split in two. See the ADR.
    expect(isCoverageBlockerCode('meta_outcome_ad_attribution_split_unavailable:2026-08-02')).toBe(false)
  })

  it('does not confuse a mismatch for an absence', () => {
    // `value_mismatch` ends in a different reason than `value_unavailable`; a naive `includes("value")`
    // would swallow both and stop a genuine incoherence from freezing anything.
    expect(isCoverageBlockerCode('meta_outcome_adset_value_mismatch:2026-08-11')).toBe(false)
  })
})
