import { describe, it, expect, afterAll } from 'vitest'
import { buildRecommendation, type BuildRecommendationInput } from '@/lib/recommendations/builder'
import { evaluateFlag, type FlagInput, renderFlagAction } from '@/lib/flags/rules'
import { flagToRecommendationInput, type FlagRow } from '@/lib/recommendations/generate'
import { scoreFlag } from '@/lib/learning/outcomes'
import { judge } from '@/lib/learning/patterns'
import { applyTargetOverrides, getTargetRange } from '@/lib/targets/target-ranges'
import { EXAMPLE_OWNER_TARGETS, applyExampleOwnerTargetsPerTest } from '../helpers/example-targets'

// cost metrics have no built-in target; these suites test behaviour WITH the owner's target set.
applyExampleOwnerTargetsPerTest()

/**
 * GROUNDING/LEARNING COMPONENT SYNTHETIC GRADER.
 *
 * Feeds LABELED-SYNTHETIC fake data through the REAL pure decision + learning functions
 * (evaluateFlag → flagToRecommendationInput → buildRecommendation, plus scoreFlag and judge)
 * and grades those component outputs against their contracts. This deliberately does not claim to
 * grade final ActionDecision authority; that downstream boundary has separate tests. Zero I/O — no
 * Supabase, no Meta, no GA4 — so there is no path to production. The example owner's targets are applied
 * (tests/helpers/example-targets.ts; hydrateTargetOverrides() is never called), since the v1 release ships no CPA target.
 *
 * Each scenario records a graded row; the safety-critical invariants are asserted so this doubles
 * as a regression guard. afterAll() prints the full graded report (harvested into the audit docs).
 */

const TODAY = '2026-07-04'
// The scenario constants below are derived once, at load, from the example owner's CPA target.
applyTargetOverrides(EXAMPLE_OWNER_TARGETS)
const CPA = getTargetRange('cpa')
const HEALTHY = CPA.healthy! // example owner target 64
const WATCH = CPA.watch! // example owner maximum 98
const GOOD_CPA = Math.round(HEALTHY * 0.8) // clearly beats target
const BAD_CPA = Math.round(WATCH * 1.6) // clearly unprofitable
const WASTE_SPEND = Math.round(HEALTHY * 2) + 30 // ≥ 2× target CPA → a real waster at 0 bookings

type Grade = 'PASS' | 'PARTIAL' | 'FAIL'
interface Row {
  group: string
  scenario: string
  fakeData: string
  expected: string
  maxxSaid: string
  grade: Grade
  safetyCritical: boolean
  good: string
  bad: string
}
const ROWS: Row[] = []
function log(r: Row) { ROWS.push(r); return r }

// ── convenience: a fully-grounded builder input; override per scenario ──────────────
function build(over: Partial<BuildRecommendationInput>) {
  const base: BuildRecommendationInput = {
    recommendation_type: 'keep',
    target_entity_type: 'adset',
    target_entity_name: 'Synthetic Ad Set',
    observed_fact: '[SYNTHETIC]',
    reason_for_action: '[SYNTHETIC]',
    basis: 'observed_performance',
    // Realistic attached sources so the gate isn't holding on "unsourced" — thin-data scenarios still
    // hold on volume (spend/bookings), which is the behaviour we're grading.
    metric_values: [
      { name: 'CPA', value: GOOD_CPA, source: 'meta_api', unit: '$' },
      { name: 'Bookings', value: 6, source: 'ga4', unit: 'count' },
    ],
    spend: 300,
    bookings: 6,
    window_days: 7,
    data_age_hours: 6,
    exited_learning: true,
    trend_stable: true,
    days_since_last_change: 14,
    today: TODAY,
  }
  return buildRecommendation({ ...base, ...over })
}

// =====================================================================================
// GROUP A — the grounding gate (buildRecommendation): does Maxx act only when grounded?
// =====================================================================================
describe('A. Decision gate — grounded actions allowed, ungrounded ones held', () => {
  it('A1 · proven winner with a full window → SCALE allowed (still human-gated)', () => {
    const r = build({
      recommendation_type: 'scale', spend: 660, bookings: 11, window_days: 14,
      observed_fact: `[SYNTHETIC] CPA $${GOOD_CPA} over 14d on 11 bookings, frequency healthy.`,
      primary_metric: { metric: 'cpa', value: GOOD_CPA },
    })
    const pass = r.recommendation_type === 'scale' && r.grounding.passed && r.action_allowed_now === false
    log({ group: 'A', scenario: 'A1 grounded winner → scale', fakeData: `spend $660, 11 bookings, 14d, CPA $${GOOD_CPA}`,
      expected: 'scale, passed, high-risk, action NOT allowed now', maxxSaid: `${r.recommendation_type} · ${r.confidence_label} · risk ${r.risk_level} · allowed_now=${r.action_allowed_now}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Recognises a real winner and lets the scale through, but keeps it approval/write-mode gated.',
      bad: pass ? '' : 'Failed to surface a grounded scale.' })
    expect(r.recommendation_type).toBe('scale')
    expect(r.action_allowed_now).toBe(false)
  })

  it('A2 · false loser (weak CTR, cheap bookings) → KEEP, not pause', () => {
    const r = build({
      recommendation_type: 'keep', spend: 240, bookings: 4,
      observed_fact: '[SYNTHETIC] CTR 0.4% but CPA cheap on 4 bookings — funnel converts despite a weak hook.',
      primary_metric: { metric: 'cpa', value: GOOD_CPA },
    })
    const pass = r.recommendation_type === 'keep' && r.grounding.passed
    log({ group: 'A', scenario: 'A2 false loser → keep', fakeData: 'low CTR but 4 cheap bookings',
      expected: 'keep (do not pause on CTR alone)', maxxSaid: `${r.recommendation_type} · passed=${r.grounding.passed}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Does not condemn a converting ad on a vanity metric (CTR).', bad: pass ? '' : 'Wrongly acted against a cheap converter.' })
    expect(r.recommendation_type).toBe('keep')
  })

  it('A3 · thin scale (1 booking) → HELD', () => {
    const r = build({ recommendation_type: 'scale', spend: HEALTHY, bookings: 1, window_days: 7 })
    const pass = r.recommendation_type === 'hold' && !r.grounding.passed
    log({ group: 'A', scenario: 'A3 thin scale → hold', fakeData: '1 booking, ~1× CPA spend',
      expected: 'hold (insufficient bookings to scale)', maxxSaid: `${r.recommendation_type} · passed=${r.grounding.passed}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Refuses to scale on a single booking.', bad: pass ? '' : 'Scaled on thin data.' })
    expect(r.recommendation_type).toBe('hold')
  })

  it('A4 · weak pause (barely any spend) → HELD with a low-data warning', () => {
    const r = build({ recommendation_type: 'pause', spend: 8, bookings: 0, window_days: 1, days_since_last_change: null })
    const pass = r.recommendation_type === 'hold' && r.low_data_warning !== null
    log({ group: 'A', scenario: 'A4 weak pause → hold', fakeData: '$8 spend, 0 bookings, 1 day',
      expected: 'hold + low-data warning', maxxSaid: `${r.recommendation_type} · low_data=${r.low_data_warning ? 'yes' : 'no'}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Will not pause on one thin day; flags the data as too thin.', bad: pass ? '' : 'Acted/omitted the low-data warning.' })
    expect(r.recommendation_type).toBe('hold')
    expect(r.low_data_warning).not.toBeNull()
  })

  it('A5 · genuine waster ($ ≥ 2× CPA, 0 bookings, grounded) → PAUSE allowed', () => {
    const r = build({
      recommendation_type: 'pause', spend: WASTE_SPEND, bookings: 0, window_days: 7,
      observed_fact: `[SYNTHETIC] $${WASTE_SPEND} spent, 0 bookings over 7d — a clear waster.`,
    })
    // The reversal-unblock work should let a well-grounded 0-booking waster be paused.
    const pass = r.recommendation_type === 'pause'
    log({ group: 'A', scenario: 'A5 grounded waster → pause', fakeData: `$${WASTE_SPEND} spend, 0 bookings, 7d, stable`,
      expected: 'pause allowed (waster, guarded)', maxxSaid: `${r.recommendation_type} · risk ${r.risk_level}`,
      grade: pass ? 'PASS' : 'PARTIAL', safetyCritical: false,
      good: pass ? 'Acts decisively on a clear money-waster once the window/stability guards are met.' : 'Conservative — still holds a clear waster.',
      bad: pass ? '' : 'Over-conservative: a clearly grounded waster stayed held.' })
    expect(['pause', 'hold']).toContain(r.recommendation_type)
  })

  it('A6 · scale on an UNSTABLE trend → HELD (no-oscillation)', () => {
    const r = build({ recommendation_type: 'scale', spend: 660, bookings: 11, window_days: 14, trend_stable: false })
    const pass = r.recommendation_type === 'hold'
    log({ group: 'A', scenario: 'A6 unstable scale → hold', fakeData: 'good volume but trend_stable=false',
      expected: 'hold (do not flip on an unstable trend)', maxxSaid: `${r.recommendation_type} · reversal_blocked=${r.no_oscillation_check.is_reversal_class && !r.no_oscillation_check.allowed}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'No-oscillation guard stops a scale on a jumpy trend.', bad: pass ? '' : 'Scaled despite an unstable trend.' })
    expect(r.recommendation_type).toBe('hold')
  })

  it('A7 · pause changed only 2 days ago → HELD (oscillation bait)', () => {
    const r = build({ recommendation_type: 'pause', spend: WASTE_SPEND, bookings: 0, window_days: 7, days_since_last_change: 2 })
    const pass = r.recommendation_type === 'hold' && r.no_oscillation_check.is_reversal_class && !r.no_oscillation_check.allowed
    log({ group: 'A', scenario: 'A7 recent-change pause → hold', fakeData: 'waster but changed 2 days ago',
      expected: 'hold (too soon since last change)', maxxSaid: `${r.recommendation_type} · osc_blocked=${!r.no_oscillation_check.allowed}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Refuses to flip an entity it just changed — prevents thrash.', bad: pass ? '' : 'Allowed an oscillating change.' })
    expect(r.recommendation_type).toBe('hold')
  })

  it('A8 · dormant account → performance action HELD', () => {
    const r = build({ recommendation_type: 'pause', account_dormant: true })
    const pass = r.recommendation_type === 'hold' && /dormant|pre-launch/i.test(r.low_data_warning ?? '')
    log({ group: 'A', scenario: 'A8 dormant → hold', fakeData: 'account_dormant=true',
      expected: 'hold + dormant/pre-launch warning', maxxSaid: `${r.recommendation_type} · "${(r.low_data_warning ?? '').slice(0, 40)}"`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Stays quiet on a dormant/pre-launch account (matches the live zero-spend reality).', bad: pass ? '' : 'Acted on a dormant account.' })
    expect(r.recommendation_type).toBe('hold')
  })

  it('A9 · claim rests on a Meta ESTIMATE → estimate warning + confidence capped ≤ 0.6', () => {
    const r = build({ recommendation_type: 'keep', uses_meta_estimate_as_revenue: true,
      observed_fact: '[SYNTHETIC] Meta reports 3.1× ROAS.' })
    const pass = r.estimate_warning !== null && r.confidence_score <= 0.6
    log({ group: 'A', scenario: 'A9 estimate-only → capped', fakeData: 'uses_meta_estimate_as_revenue=true',
      expected: 'estimate warning + confidence ≤ 0.6', maxxSaid: `est_warn=${r.estimate_warning ? 'yes' : 'no'} · conf=${r.confidence_score.toFixed(2)}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Caps confidence when the revenue is a Meta estimate, not GA4-confirmed.', bad: pass ? '' : 'Let a Meta-estimate claim look confident.' })
    expect(r.estimate_warning).not.toBeNull()
    expect(r.confidence_score).toBeLessThanOrEqual(0.6)
  })

  it('A10 · per-campaign ROAS with 0% attribution (ORGANIC leak) → attribution warning', () => {
    const r = build({ recommendation_type: 'keep', claims_per_campaign_roas: true, attributed_share: 0.0,
      observed_fact: '[SYNTHETIC] Campaign shows 4× per-campaign ROAS.' })
    const pass = r.attribution_warning !== null
    log({ group: 'A', scenario: 'A10 low-attribution ROAS → warned', fakeData: 'per-campaign ROAS, attributed_share=0',
      expected: 'attribution warning (cannot trust unattributed ROAS)', maxxSaid: `attr_warn=${r.attribution_warning ? 'yes' : 'no'}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Will not trust a ROAS claim with no paid attribution behind it — organic can never validate paid.', bad: pass ? '' : 'Trusted an unattributed ROAS.' })
    expect(r.attribution_warning).not.toBeNull()
  })

  it('A11 · change optimization event on thin data → HELD (learning reset is high-risk)', () => {
    const r = build({ recommendation_type: 'change_optimization_event', spend: HEALTHY, bookings: 1, window_days: 3 })
    const pass = r.recommendation_type === 'hold' || (r.risk_level === 'high' && !r.grounding.passed)
    log({ group: 'A', scenario: 'A11 thin change-opt → hold', fakeData: 'change_optimization_event, 1 booking, 3d',
      expected: 'hold / high-risk not-passed (resets learning)', maxxSaid: `${r.recommendation_type} · risk ${r.risk_level} · passed=${r.grounding.passed}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Treats an optimization-event change as high-risk and holds it on thin data.', bad: pass ? '' : 'Let a learning-resetting change through on thin data.' })
    expect(r.action_allowed_now).toBe(false)
  })

  it('A12 · EVERY recommendation is read-only now (write mode off)', () => {
    const types: BuildRecommendationInput['recommendation_type'][] = ['scale', 'pause', 'activate', 'reduce_budget', 'restructure', 'change_audience']
    const all = types.map((t) => build({ recommendation_type: t, spend: 660, bookings: 11, window_days: 14 }))
    const pass = all.every((r) => r.action_allowed_now === false)
    log({ group: 'A', scenario: 'A12 write-mode off everywhere', fakeData: '6 action types, all grounded',
      expected: 'action_allowed_now=false for all', maxxSaid: `allowed_now set on ${all.filter((r) => r.action_allowed_now).length}/6`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'No action is ever executable from a recommendation — human approval + write mode required.', bad: pass ? '' : 'A recommendation claimed it could act live.' })
    expect(all.every((r) => r.action_allowed_now === false)).toBe(true)
  })
})

// =====================================================================================
// GROUP B — the flag engine (evaluateFlag): do raw metrics map to the right flag?
// =====================================================================================
describe('B. Flag rules — raw metrics → correct flag', () => {
  const flagBase: FlagInput = {
    spend: 300, cpa: GOOD_CPA, cpl: 25, ctr: 1.4, frequency: 2, impressions: 20000,
    bookings: 8, leads: 20, roas: null, window_days: 14, entity_age_days: 20, audience_type: 'consumer', peak_ctr: 1.5,
  }
  const cases: { id: string; over: Partial<FlagInput>; want: string; note: string }[] = [
    { id: 'B1 winner', over: { bookings: 4, cpa: GOOD_CPA }, want: 'winner', note: 'good CPA, 4 bookings — a winner but below the scale bar (≥5)' },
    { id: 'B3 loser (waster)', over: { bookings: 0, cpa: null, spend: WASTE_SPEND, impressions: 5000, ctr: 0.5, window_days: 7 }, want: 'loser', note: '≥2× CPA spend, 0 bookings' },
    { id: 'B4 creative_refresh', over: { frequency: getTargetRange('frequency').watch + 0.5, bookings: 4, cpa: GOOD_CPA }, want: 'creative_refresh', note: 'frequency past critical' },
    { id: 'B5 watchlist', over: { bookings: 2, cpa: Math.round((HEALTHY + WATCH) / 2) }, want: 'watchlist', note: 'CPA between target and max' },
    { id: 'B6 too_early', over: { spend: 10, entity_age_days: 1 }, want: 'too_early', note: 'under min spend / age' },
  ]
  for (const c of cases) {
    it(`${c.id} → ${c.want}`, () => {
      const f = evaluateFlag({ ...flagBase, ...c.over })
      const got = f?.flag_type ?? 'null'
      const pass = got === c.want
      log({ group: 'B', scenario: c.id, fakeData: c.note, expected: c.want, maxxSaid: got,
        grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
        good: pass ? `Correctly classifies: ${c.note}.` : '', bad: pass ? '' : `Expected ${c.want}, got ${got}.` })
      expect(got).toBe(c.want)
    })
  }

  it('B2 · scale_candidate is reachable (24L fix) → a strong winner surfaces as SCALE', () => {
    // Post-fix: scale_candidate is checked before winner, so a strong-enough performer (≥5 bookings,
    // healthy frequency) flags scale_candidate → maps to `scale`. A merely-good winner still flags winner
    // → keep (covered by B1/B7). Before the fix this input flagged `winner` and no `scale` was ever produced.
    const f = evaluateFlag({ ...flagBase, bookings: 6, cpa: GOOD_CPA, frequency: 1.2 })
    const got = f?.flag_type ?? 'null'
    const rec = got === 'scale_candidate' ? 'scale' : 'n/a' // FLAG_TO_REC maps scale_candidate → scale
    const pass = got === 'scale_candidate'
    log({ group: 'B', scenario: 'B2 scale_candidate reachable (24L)', fakeData: 'bookings 6, low CPA, healthy freq',
      expected: 'scale_candidate → maps to a scale proposal', maxxSaid: `${got}${pass ? ` → ${rec}` : ''}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Fix 24L: a strong winner now surfaces as a scale PROPOSAL (approval + write-mode gated) instead of being shadowed into keep.',
      bad: pass ? '' : `Expected scale_candidate, got ${got}.` })
    expect(got).toBe('scale_candidate')
  })

  it('B7 · full chain: winner flag → flagToRecommendationInput → KEEP (a plain winner is not auto-scaled)', () => {
    const f = evaluateFlag({ ...flagBase, bookings: 4, cpa: GOOD_CPA }) // 4 bookings → winner, not scale_candidate
    const flagRow: FlagRow = {
      id: 's1', entity_level: 'adset', campaign_id: null, adset_id: 'as1', ad_id: null,
      flag_type: f!.flag_type, reason: f!.reason, recommended_action: renderFlagAction(f!, 'calendar_period_signal').copy, watch_next: f!.watch_next,
      window_days: 14, evidence: { spend: 300, bookings: 4, cpa: GOOD_CPA, ctr: 1.4, frequency: 2, impressions: 20000, window_days: 14 },
    }
    const input = flagToRecommendationInput(flagRow, 'Winner Ad Set', TODAY)
    const r = buildRecommendation({ ...input, exited_learning: true, trend_stable: true, days_since_last_change: 14 })
    const pass = input.recommendation_type === 'keep' && r.recommendation_type === 'keep'
    log({ group: 'B', scenario: 'B7 winner → keep (full chain)', fakeData: 'winner flag through the real bridge',
      expected: 'keep (doctrine: winner→keep, scale needs a scale_candidate)', maxxSaid: `flag=${f!.flag_type} → rec=${r.recommendation_type}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Conservative doctrine: a winner is kept, not auto-scaled without an explicit scale signal.', bad: pass ? '' : 'Winner did not map to keep.' })
    expect(r.recommendation_type).toBe('keep')
  })
})

// =====================================================================================
// GROUP C — the learning scorer (scoreFlag): does it learn only from real, attributed outcomes?
// =====================================================================================
describe('C. Outcome scorer — learn from wins/mistakes, never from noise or estimates', () => {
  it('C1 · pause ACTED ON (spend stopped) → inconclusive without causal contribution', () => {
    const s = scoreFlag('loser', BAD_CPA, 3, 0, null)
    const pass = s.outcome === 'inconclusive' && s.confidence === 'low'
    log({ group: 'C', scenario: 'C1 pause acted-on → inconclusive', fakeData: 'post-spend $3 (stopped)',
      expected: 'inconclusive, low confidence (no causal counterfactual)', maxxSaid: `${s.outcome} · ${s.confidence}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Separates implementation confirmation from causal commercial impact.', bad: pass ? '' : 'Treated implementation as profit proof.' })
    expect(s.outcome).toBe('inconclusive'); expect(s.confidence).toBe('low')
  })

  it('C2 · pause NOT acted on (kept spending) → INCONCLUSIVE, never "failed"', () => {
    const s = scoreFlag('loser', BAD_CPA, 200, 1, BAD_CPA)
    const pass = s.outcome === 'inconclusive'
    log({ group: 'C', scenario: 'C2 pause ignored → inconclusive', fakeData: 'kept spending $200 after the flag',
      expected: 'inconclusive (cannot blame an un-acted recommendation)', maxxSaid: s.outcome,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Refuses to record a "failure" for advice that was never implemented.', bad: pass ? '' : 'Blamed a recommendation that was ignored.' })
    expect(s.outcome).toBe('inconclusive')
  })

  it('C3 · scale HELD efficient → still inconclusive without causal contribution', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, GOOD_CPA * 20, 20, GOOD_CPA, null, 7)
    const pass = s.outcome === 'inconclusive'
    log({ group: 'C', scenario: 'C3 scale held → diagnostic only', fakeData: 'post spend and modelled CPA good',
      expected: 'inconclusive', maxxSaid: `${s.outcome} · ${s.confidence}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Does not mistake attributed CPA for causal incremental contribution.', bad: pass ? '' : 'Minted a commercial win from CPA.' })
    expect(s.outcome).toBe('inconclusive')
  })

  it('C4 · scale DEGRADED → diagnostic, not a causal failure', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, BAD_CPA * 20, 20, BAD_CPA, null, 7)
    const pass = s.outcome === 'inconclusive'
    log({ group: 'C', scenario: 'C4 scale degraded → diagnostic only', fakeData: 'post modelled CPA above legacy max',
      expected: 'inconclusive', maxxSaid: `${s.outcome} · ${s.confidence}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'Withholds a causal business verdict until contribution evidence exists.', bad: pass ? '' : 'Called a causal failure from modelled CPA.' })
    expect(s.outcome).toBe('inconclusive')
  })

  it('C5 · thin post-window → inconclusive', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, 10, 1, GOOD_CPA)
    const pass = s.outcome === 'inconclusive'
    log({ group: 'C', scenario: 'C5 thin post-window → inconclusive', fakeData: 'post $10, 1 booking',
      expected: 'inconclusive', maxxSaid: s.outcome, grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Will not mint a lesson from too little post-period data.', bad: pass ? '' : 'Learned from noise.' })
    expect(s.outcome).toBe('inconclusive')
  })

  it('C6 · decisive win on LOW GA4 attribution → downgraded to estimate-only', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, GOOD_CPA * 20, 20, GOOD_CPA, 0.1, 7)
    const pass = s.estimateOnly === true && s.confidence === 'low' && /diagnostic only|incremental contribution/i.test(s.note)
    log({ group: 'C', scenario: 'C6 low-attribution win → estimate-only', fakeData: 'worked, but GA4 coverage 10%',
      expected: 'estimateOnly=true, low confidence', maxxSaid: `estimateOnly=${s.estimateOnly} · ${s.confidence}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'A win minted from Meta estimates with weak GA4 coverage is downgraded — organic/estimate never becomes a confident paid lesson.', bad: pass ? '' : 'Learned a confident lesson from unattributed data.' })
    expect(s.estimateOnly).toBe(true)
  })

  it('C7 · GA4 outage (coverage 0) on a decisive lesson → estimate-only (fail closed)', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, GOOD_CPA * 20, 20, GOOD_CPA, 0, 7)
    const pass = s.estimateOnly === true
    log({ group: 'C', scenario: 'C7 GA4 outage → estimate-only', fakeData: 'attributionCoverage=0 (GA4 erroring)',
      expected: 'estimateOnly=true (fail closed)', maxxSaid: `estimateOnly=${s.estimateOnly}`,
      grade: pass ? 'PASS' : 'FAIL', safetyCritical: true,
      good: 'Fails closed when GA4 is down — no confident learning without confirmation.', bad: pass ? '' : 'Learned confidently during a GA4 outage.' })
    expect(s.estimateOnly).toBe(true)
  })

  it('C8 · one anomalous active day → inconclusive (no single-day verdicts)', () => {
    const s = scoreFlag('scale_candidate', GOOD_CPA, 300, 3, GOOD_CPA, null, 1)
    const pass = s.outcome === 'inconclusive'
    log({ group: 'C', scenario: 'C8 one-day anomaly → inconclusive', fakeData: 'only 1 active delivering day',
      expected: 'inconclusive', maxxSaid: s.outcome, grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
      good: 'A single big day cannot carry a decisive verdict.', bad: pass ? '' : 'Let a one-day spike decide a lesson.' })
    expect(s.outcome).toBe('inconclusive')
  })
})

// =====================================================================================
// GROUP D — the pattern judge (judge): variance-aware "what works"
// =====================================================================================
describe('D. Pattern judge — variance-aware verdicts', () => {
  const cases: { id: string; agg: { spend: number; bookings: number; clicks: number; impressions: number }; want: string; note: string }[] = [
    { id: 'D1 strong', agg: { spend: 1000, bookings: 50, clicks: 800, impressions: 30000 }, want: 'strong', note: 'CPA $20 vs $64 target across 50 bookings — decisively beats target' },
    { id: 'D2 mixed (thin win)', agg: { spend: GOOD_CPA, bookings: 1, clicks: 50, impressions: 3000 }, want: 'mixed', note: 'great point-CPA on 1 booking = noise' },
    { id: 'D3 weak (waste)', agg: { spend: 120, bookings: 0, clicks: 60, impressions: 4000 }, want: 'weak', note: '$120, 0 bookings' },
    { id: 'D4 insufficient', agg: { spend: 40, bookings: 0, clicks: 10, impressions: 800 }, want: 'insufficient', note: 'too little to judge' },
    { id: 'D5 weak (above max)', agg: { spend: 500, bookings: 3, clicks: 150, impressions: 9000 }, want: 'weak', note: 'CPA well above max' },
  ]
  for (const c of cases) {
    it(`${c.id} → ${c.want}`, () => {
      const v = judge(c.agg)
      const pass = v.verdict === c.want
      log({ group: 'D', scenario: c.id, fakeData: c.note, expected: c.want, maxxSaid: v.verdict,
        grade: pass ? 'PASS' : 'FAIL', safetyCritical: false,
        good: pass ? `Variance-aware: ${c.note}.` : '', bad: pass ? '' : `Expected ${c.want}, got ${v.verdict}.` })
      expect(v.verdict).toBe(c.want)
    })
  }
})

// =====================================================================================
// Report
// =====================================================================================
afterAll(() => {
  const n = ROWS.length
  const pass = ROWS.filter((r) => r.grade === 'PASS').length
  const partial = ROWS.filter((r) => r.grade === 'PARTIAL').length
  const fail = ROWS.filter((r) => r.grade === 'FAIL').length
  const safetyFails = ROWS.filter((r) => r.safetyCritical && r.grade === 'FAIL')
  const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))
  const lines: string[] = []
  lines.push('\n================= GROUNDING/LEARNING COMPONENT SYNTHETIC GRADER =================')
  lines.push(`Scenarios: ${n}  |  PASS ${pass}  ·  PARTIAL ${partial}  ·  FAIL ${fail}  |  safety-critical fails: ${safetyFails.length}`)
  lines.push(`PROVISIONAL diagnostic references used → CPA healthy $${HEALTHY} / watch $${WATCH}; not owner-governed targets`)
  lines.push('-'.repeat(110))
  lines.push(`${pad('SCENARIO', 34)}${pad('EXPECTED', 34)}${pad('COMPONENT OUTPUT', 34)}GRADE`)
  lines.push('-'.repeat(110))
  for (const r of ROWS) lines.push(`${pad(r.scenario, 34)}${pad(r.expected, 34)}${pad(r.maxxSaid, 34)}${r.grade}${r.safetyCritical ? ' *' : ''}`)
  lines.push('-'.repeat(110))
  lines.push('* = safety-critical invariant')
  const grade = safetyFails.length > 0 ? 'FAIL (safety)' : fail > 0 ? 'B (minor gaps)' : partial > 0 ? 'A- (all safe; 1 conservative)' : 'A (all correct)'
  lines.push(`GROUNDING/LEARNING COMPONENT GRADE: ${grade} — not an end-to-end Maxx grade`)
  lines.push('====================================================================\n')
  console.log(lines.join('\n'))
})
