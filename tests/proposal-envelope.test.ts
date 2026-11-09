import { describe, it, expect } from 'vitest'
import { severityToRisk, PROPOSED_ACTIONS_LABEL, READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'
import { describeDeliveryEvidence } from '@/mcp/tools/creative-fatigue'
import { resultMessage } from '@/components/changes/ChangeReviewList'

// Shared copy states the real decision/execution contract. It never upgrades untrusted prose into a
// proposal merely by prefixing it.

describe('severityToRisk', () => {
  it('maps severity to a risk word without inventing confidence', () => {
    expect(severityToRisk('critical')).toBe('high')
    expect(severityToRisk('warning')).toBe('medium')
    expect(severityToRisk('info')).toBe('low')
    expect(severityToRisk(null)).toBe('low')
    expect(severityToRisk(undefined)).toBe('low')
  })
})

describe('envelope constants are authority-aware and environment-neutral', () => {
  it('states all execution gates without claiming the current env value', () => {
    expect(READ_ONLY_APPLY_NOTE).toMatch(/ActionDecision/i)
    expect(READ_ONLY_APPLY_NOTE).toMatch(/owner approval/i)
    expect(READ_ONLY_APPLY_NOTE).toMatch(/write mode/i)
    expect(READ_ONLY_APPLY_NOTE).not.toMatch(/write mode (?:is )?off/i)
    expect(PROPOSED_ACTIONS_LABEL).toMatch(/diagnostic/i)
  })
})

describe('change review copy fails closed on missing decision lineage', () => {
  it('renders the authority failure as a block, never a success', () => {
    expect(resultMessage('approve', 'AUTHORITY_REQUIRED')).toEqual({
      text: 'Blocked — this request has no valid current execution-eligible ActionDecision lineage.',
      ok: false,
    })
  })
})

describe('creative delivery evidence has no action envelope', () => {
  it('returns a diagnostic-only observation and an empty prescription list', () => {
    expect(describeDeliveryEvidence({ impressions: 1_000, frequencyObservationCount: 7 })).toMatchObject({
      action_authority_tier: 'diagnostic_only',
      evidence_state: 'observed',
      prescriptions: [],
    })
  })

  it('does not accept cost or outcome fields that could manufacture a creative instruction', () => {
    const evidence = describeDeliveryEvidence({
      impressions: 1_000,
      frequencyObservationCount: 7,
      cpl: 500,
      bookings: 0,
    } as Parameters<typeof describeDeliveryEvidence>[0])

    expect(evidence.observation).not.toMatch(/\b(pause|refresh|increase|reduce|scale|cut)\b/i)
    expect(evidence.prescriptions).toEqual([])
  })
})
