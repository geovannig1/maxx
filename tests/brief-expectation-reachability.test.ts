import { describe, expect, it } from 'vitest'
import { BRIEF_EXPECTATIONS } from '@/lib/eval/brief-expectations'
import { scoreBrief } from '@/lib/eval/brief-rubric'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-questions'
import { brief, citation, fixtureClaims } from './fixtures/brief-defects'

/**
 * Every golden question must have SOME admissible brief, scored against the REAL expectations.
 *
 * The rubric tests score fixtures against a fixture expectation, and that is how three defects shipped
 * in one morning. `RECONCILIATION_EXPECTATION` was written correct — declaring every plane — while the
 * shipped `BRIEF_EXPECTATIONS` entries were not, so the regression test passed against configuration
 * that was still broken. Measured on the real q1 at the time: a brief citing Meta spend AND an Acuity
 * booking count scored 0.83 and was INADMISSIBLE, while a Meta-only brief scored 1.00 and passed.
 * Silence outranked the correct answer — the exact defect the fix claimed to have removed.
 *
 * Worse, q2 required `meta_delivery: ['adset']` and q3 `['ad']`, but `commonClaim` hardcodes
 * entity.level to 'account' for every non-Acuity plane and `get_performance_cockpit` exposes no level
 * parameter. Those questions had NO admissible brief in either direction: cite anything and G4 fails,
 * cite nothing and G1 fails. The acceptance gate was permanently red and nothing said so, because
 * `eval:golden` runs in neither CI nor the local gate — it needs a live API key.
 *
 * So this file scores the shipped expectations, in the unit suite, with no network. A question that
 * cannot be answered is a question that measures nothing.
 */

const META_ACCOUNT = citation({ metric_key: 'meta.spend' })
const META_ADSET = citation({ metric_key: 'meta.adset.learning_state', level: 'adset' })
const META_AD = citation({ metric_key: 'meta.ad.delivery_sub_status', level: 'ad' })
const ACUITY_APPOINTMENTS = citation({
  metric_key: 'appointments', plane: 'outcome_business', system: 'outcomes',
  role: 'business_truth', lane: 'measured', level: 'business',
})
const GA4_STATUS = citation({
  metric_key: 'ga4.confirmation_telemetry_status', plane: 'ga4_telemetry', system: 'ga4',
  role: 'measurement_qa', lane: 'telemetry',
})
const CAPI_STATUS = citation({
  metric_key: 'capi.dataset_quality', plane: 'capi_delivery', system: 'capi',
  role: 'delivery_transport', lane: 'telemetry',
})
const DECISION_STATUS = citation({
  metric_key: 'decision.scale_authority', plane: 'decision', system: 'maxx',
  role: 'decision_context', lane: 'operational',
})
const PAID_CPA = citation({
  metric_key: 'paid.cpa', plane: 'paid_association', system: 'first_party_attribution',
  role: 'association_truth', lane: 'associated_noncausal', availability: 'unavailable',
})
const PAID_ROAS = citation({
  metric_key: 'paid.roas', plane: 'paid_association', system: 'first_party_attribution',
  role: 'association_truth', lane: 'associated_noncausal', availability: 'unavailable',
})

/** The deterministic server packet each shipped scenario can now produce. */
function bestPossibleBrief(id: string) {
  if (id === 'q1-flagship-diagnosis') {
    return brief(
      [META_ACCOUNT, META_ADSET, ACUITY_APPOINTMENTS, GA4_STATUS, CAPI_STATUS, DECISION_STATUS],
      [PAID_CPA, PAID_ROAS],
    )
  }
  if (id === 'q2-adset-optimized') return brief([META_ADSET, DECISION_STATUS])
  if (id === 'q3-creative-quality') return brief([META_AD, DECISION_STATUS])
  return brief([META_ACCOUNT, ACUITY_APPOINTMENTS, DECISION_STATUS], [PAID_CPA, PAID_ROAS])
}

/** What a refusal looks like: cite nothing, declare nothing. */
const silentBrief = brief([])

describe('every shipped expectation admits at least one brief', () => {
  it.each(GOLDEN_QUESTIONS.map((q) => [q.id] as const))('%s has an admissible brief', (id) => {
    const scored = scoreBrief(BRIEF_EXPECTATIONS[id], bestPossibleBrief(id), fixtureClaims())
    expect(scored.failedGates).toEqual([])
    expect(scored.admissible).toBe(true)
  })

  it.each(GOLDEN_QUESTIONS.map((q) => [q.id] as const))('%s does not reward silence', (id) => {
    // The ranking that matters. An empty brief must never score at or above a real one.
    const answered = scoreBrief(BRIEF_EXPECTATIONS[id], bestPossibleBrief(id), fixtureClaims())
    const silent = scoreBrief(BRIEF_EXPECTATIONS[id], silentBrief, fixtureClaims())
    expect(silent.admissible).toBe(false)
    expect(answered.score).toBeGreaterThan(silent.score)
  })
})

describe('the server-owned evidence packet is admissible', () => {
  it.each(GOLDEN_QUESTIONS.map((q) => [q.id] as const))(
    '%s admits its complete required packet',
    (id) => {
      const scored = scoreBrief(BRIEF_EXPECTATIONS[id], bestPossibleBrief(id), fixtureClaims())
      expect(scored.failedGates).toEqual([])
    },
  )
})
