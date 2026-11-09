import { describe, expect, it } from 'vitest'
import { createMetricClaim, type MetricClaim } from '@/lib/cockpit/contracts'
import { composeAnswerSummary } from '@/lib/maxx/answer-summary'
import type { PersistedFinalActionDecisionEvidence } from '@/lib/maxx/answer-brief'
import { containsUngovernedActionLanguage } from '@/lib/authority/diagnostic-surface'

/**
 * The summary is a TEMPLATE over governed claims. Every figure it prints must be the figure the
 * evidence line prints for the same claim, and nothing it says may come from anywhere else.
 */

const WINDOW = { start: '2026-03-01', end: '2026-03-28', basis: 'closed_account_days' as const, timezone: 'America/New_York' }
const PRIOR = { start: '2026-02-01', end: '2026-02-28', basis: 'closed_account_days' as const, timezone: 'America/New_York' }

function level(key: string, label: string, value: number, unit: MetricClaim['unit']): MetricClaim {
  return createMetricClaim({
    claimId: `${key}:2026-03-01:2026-03-28`, metricKey: key, label, value, unit, formula: null, definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: '100000000000777' }, attributionScope: 'none', window: WINDOW,
    comparison: { method: 'none', window: null }, asOf: '2026-03-29T12:00:00.000Z',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 28, denominator: 28 },
    maturity: { state: 'settled', matureThrough: '2026-03-28' },
    freshness: { state: 'fresh', observedAt: '2026-03-29T12:00:00.000Z', maxAgeHours: 24 },
    setupFingerprint: 'sf', authority: { state: 'authoritative', policyVersion: 'cockpit-v3' },
    measurementKind: 'measured', inputClaimIds: [],
  })
}

function change(base: MetricClaim, value: number): MetricClaim {
  return createMetricClaim({
    ...base, claimId: `${base.metricKey}_change:2026-03-01:2026-03-28`, metricKey: `${base.metricKey}_change`,
    label: `${base.label} vs prior period`, value, unit: 'percent',
    comparison: { method: 'prior_equal_period', window: PRIOR },
    coverage: { state: 'complete', numerator: 2, denominator: 2 },
    authority: { state: 'context', policyVersion: 'cockpit-v3' },
    measurementKind: 'derived', inputClaimIds: [base.claimId, `${base.metricKey}:2026-02-01:2026-02-28`],
  })
}

function unavailable(key: string, label: string, codes: string[]): MetricClaim {
  return createMetricClaim({
    ...level(key, label, 1, 'ratio'), value: null,
    availability: { state: 'unavailable', blockerCodes: codes },
    coverage: { state: 'unknown', numerator: null, denominator: null },
  })
}

const spend = level('meta.spend', 'Meta spend', 148_978, 'money')
const roas = level('meta.purchase_roas', 'Meta Purchase ROAS', 5.06, 'ratio')
const cpa = level('meta.cost_per_result', 'Meta cost per Result', 14.54, 'money')
const results = level('meta.appointment_confirmed_results', 'Meta Results', 412, 'count')

function decision(overrides: Partial<PersistedFinalActionDecisionEvidence> = {}): PersistedFinalActionDecisionEvidence {
  return {
    id: 'decision-1', persisted: true, final: true, record_type: 'action_decisions', policy_version: 5,
    authority_tier: 'owner_review', approval_state: 'not_requested',
    lineage: { source_kind: 'recommendation', source_id: 'rec-1' }, ...overrides,
  }
}

describe('composeAnswerSummary', () => {
  it('leads a growth answer with spend, then ROAS and CPA, using the evidence figures', () => {
    const { summary } = composeAnswerSummary({
      observed: [cpa, change(cpa, -0.6), roas, change(roas, 0.001), spend, change(spend, 5)],
      unavailable: [], decisions: [],
    })
    expect(summary).toBe('Mar 1 – Mar 28, 2026: Meta spend is up 5% to $148,978 while Meta Purchase ROAS held at 5.06x; '
      + 'Meta cost per Result improved 0.6% to $14.54.')
  })

  it('reads a change under half a percent as held, and keeps cents on a fractional amount', () => {
    const fractional = level('meta.spend', 'Meta spend', 1963.4, 'money')
    const { summary } = composeAnswerSummary({ observed: [fractional, change(fractional, 0.3)], unavailable: [], decisions: [] })
    expect(summary).toContain('Meta spend held at $1,963.40')
  })

  it('states a decline as down, and a rising cost as worsened', () => {
    const { summary } = composeAnswerSummary({
      observed: [spend, change(spend, -12.345), cpa, change(cpa, 8.2)], unavailable: [], decisions: [],
    })
    expect(summary).toContain('Meta spend is down 12.35% to $148,978')
    expect(summary).toContain('Meta cost per Result worsened 8.2% to $14.54')
  })

  it('handles a mixed answer: a level without its change, a change without its level', () => {
    const { summary } = composeAnswerSummary({
      observed: [results, change(spend, 3)], unavailable: [], decisions: [],
    })
    expect(summary).toContain('Meta spend is up 3% against the prior period')
    expect(summary).toContain('Meta Results came to 412')
  })

  it('says honestly why a figure is unavailable, in plain words, never as a raw code', () => {
    const { summary } = composeAnswerSummary({
      observed: [spend],
      unavailable: [unavailable('meta.purchase_roas', 'Meta Purchase ROAS', ['stale_insight_source'])],
      decisions: [],
    })
    expect(summary).toContain("Meta Purchase ROAS isn't available for this window because the Meta delivery data behind this is out of date.")
    expect(summary).not.toContain('stale_insight_source')
  })

  it('summarises an answer where nothing could be measured', () => {
    const { summary } = composeAnswerSummary({
      observed: [],
      unavailable: [
        unavailable('meta.purchase_roas', 'Meta Purchase ROAS', ['stale_insight_source']),
        unavailable('meta.cost_per_result', 'Meta cost per Result', ['stale_insight_source']),
      ],
      decisions: [],
    })
    expect(summary).toMatch(/^None of the cited figures could be measured for this window\./)
    expect(summary).toContain("Meta Purchase ROAS isn't available")
    expect(summary).toContain('1 other figure is also unavailable')
  })

  it('stays within three sentences and points to the evidence for the rest', () => {
    const extra = ['meta.link_ctr', 'meta.cpm', 'meta.impressions'].map((key, i) => level(key, `Metric ${i}`, 10 + i, 'count'))
    const { summary } = composeAnswerSummary({
      observed: [spend, roas, cpa, results, ...extra],
      unavailable: [unavailable('meta.native_reach', 'Meta reach', ['stale_insight_source'])], decisions: [],
    })
    expect(summary.split(/(?<=\.)\s+/).length).toBeLessThanOrEqual(3)
    expect(summary).toContain('More figures are in the evidence below.')
  })

  it('omits the window when the lead figures cover different periods', () => {
    const other = createMetricClaim({ ...roas, window: { ...WINDOW, start: '2026-03-08' } })
    const { summary } = composeAnswerSummary({ observed: [spend, other], unavailable: [], decisions: [] })
    expect(summary.startsWith('Meta spend came to $148,978')).toBe(true)
  })
})

describe('recommended next step', () => {
  it('is null when the answer selected no persisted decision', () => {
    expect(composeAnswerSummary({ observed: [spend], unavailable: [], decisions: [] }).nextStep).toBeNull()
  })

  it('takes the highest-priority decision: authority tier, then approval, then kind', () => {
    const { nextStep } = composeAnswerSummary({
      observed: [spend], unavailable: [],
      decisions: [
        decision({ id: 'diag', authority_tier: 'diagnostic_only', owner_copy: 'Diagnostic copy.' }),
        decision({ id: 'review', authority_tier: 'owner_review', action_kind: 'creative_refresh',
          owner_copy: "Hook refresh on 'UGC · Morning routine 15s'." }),
        decision({ id: 'rejected', authority_tier: 'execution_eligible', approval_state: 'rejected', owner_copy: 'Rejected copy.' }),
      ],
    })
    expect(nextStep).toBe("Hook refresh on 'UGC · Morning routine 15s' — owner review")
  })

  it('prefers an approval that is pending over one not yet requested', () => {
    const { nextStep } = composeAnswerSummary({
      observed: [], unavailable: [],
      decisions: [
        decision({ id: 'a', owner_copy: 'First.' }),
        decision({ id: 'b', approval_state: 'pending', owner_copy: 'Second.' }),
      ],
    })
    expect(nextStep).toBe('Second — owner review, awaiting your approval')
  })

  it('never recommends a rejected decision', () => {
    expect(composeAnswerSummary({
      observed: [], unavailable: [], decisions: [decision({ approval_state: 'rejected', owner_copy: 'No.' })],
    }).nextStep).toBeNull()
  })

  it.each(['budget_scale', 'budget_cut', 'pause', 'activate', 'creative_refresh', 'structural', 'observe'] as const)(
    'names a %s decision without copy in words the action-language guard accepts', (kind) => {
      const { summary, nextStep } = composeAnswerSummary({
        observed: [spend, change(spend, 5)], unavailable: [], decisions: [decision({ action_kind: kind })],
      })
      expect(nextStep).toMatch(/^Review the persisted .+ decision — owner review$/)
      expect(containsUngovernedActionLanguage(`${summary}\n\n**Recommended next step:** ${nextStep}`)).toBe(false)
    })
})
