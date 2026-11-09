import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_SCOPES, MEASUREMENT_KINDS, MetricClaimSchema, assertNoCrossPlaneLineage,
  type MetricClaim,
} from '@/lib/cockpit/contracts'

/**
 * TOTALITY. Every (measurementKind × attributionScope × crosses-planes) cell must have a declared,
 * intended outcome — and the cells are enumerated FROM THE CONTRACT, not from a list someone wrote.
 *
 * This exists because of a repeated failure with one mechanism: a guard gets tested against the inputs
 * its author imagined, and ships blind to the rest of the population. `assertNoCrossPlaneLineage` was
 * written and validated against `derived`, the label an honest caller uses. Relabelling the identical
 * blended claim `associated_noncausal` or `causal_estimate` constructed $22.50/booking — paid-only
 * spend over an all-source denominator, `attributionScope: 'none'` preserved on the output — and
 * passed. The honest label was blocked and the dishonest ones were not. The test suite was green,
 * including a case deliberately broken to "prove" the guard fired.
 *
 * Breaking a guard the way you already imagined proves it catches what you imagined. It says nothing
 * about the 96 cells you did not enumerate. So the cells are derived from ATTRIBUTION_SCOPES and
 * MEASUREMENT_KINDS rather than hand-listed.
 *
 * What that buys, stated precisely because the looser claim was checked and was false: adding an enum
 * member does not fail this suite. It grows the cell count and the new member is exercised against
 * every other value, classified by the `shouldThrow` RULE, which defaults it to non-exempt and
 * therefore fail-closed. The guarantee is exhaustive exercise plus a fail-closed default — not an
 * automatic tripwire on vocabulary changes.
 */

const base = {
  claimId: 'meta.spend:2026-04-04:2026-04-23', metricKey: 'meta.spend', label: 'Meta spend',
  value: 585, unit: 'money', formula: null, definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'h', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: 'a' }, attributionScope: 'none',
  window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null }, asOf: '2026-04-24T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 20, denominator: 20 },
  maturity: { state: 'settled', matureThrough: '2026-04-23' },
  freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'sf', authority: { state: 'context', policyVersion: 'v1' },
  measurementKind: 'measured', inputClaimIds: [],
}
const c = (o: Record<string, unknown>): MetricClaim => MetricClaimSchema.parse({ ...base, ...o })

const SPEND = c({})
const SAME_PLANE_INPUT = c({
  claimId: 'meta.results:2026-04-04:2026-04-23', metricKey: 'meta.appointment_confirmed_results',
  label: 'Meta Results', value: 15, unit: 'count', attributionScope: 'meta_platform_modelled',
})
const OTHER_PLANE_INPUT = c({
  claimId: 'outcomes.bookings:2026-04-04:2026-04-23', metricKey: 'outcomes.value_bearing_bookings',
  label: 'Bookings', value: 26, unit: 'count', attributionScope: 'all_sources',
  source: { system: 'outcomes', role: 'business_truth', head: 'l', evidencePlane: 'outcome_business' },
  entity: { level: 'business', id: 'b' },
})

/** Kinds the guard exempts from the same-plane rule, and the one scope such a crossing may declare. */
const CROSS_PLANE_EXEMPT = new Set(['causal_estimate', 'associated_noncausal'])
const HONEST_CROSSING_SCOPE = 'causal_estimate'

/**
 * The intended outcome for every cell, stated as a rule rather than a lookup table, so the rule is
 * reviewable. A table of 98 booleans would be just as unfalsifiable as testing one case.
 */
function shouldThrow(kind: string, scope: string, crosses: boolean): boolean {
  if (!crosses) return false
  if (!CROSS_PLANE_EXEMPT.has(kind)) return true
  return scope !== HONEST_CROSSING_SCOPE
}

function evaluate(kind: string, scope: string, crosses: boolean): boolean {
  const input = crosses ? OTHER_PLANE_INPUT : SAME_PLANE_INPUT
  const subject = c({
    claimId: `subject.${kind}.${scope}.${crosses}:2026-04-04:2026-04-23`,
    metricKey: 'subject.metric', label: 'Subject', value: 1, unit: 'count',
    measurementKind: kind, attributionScope: scope,
    inputClaimIds: [SPEND.claimId, input.claimId],
  })
  const set = Object.fromEntries([SPEND, input, subject].map((x) => [x.claimId, x]))
  try {
    assertNoCrossPlaneLineage(set)
    return false
  } catch {
    return true
  }
}

const CELLS = MEASUREMENT_KINDS.flatMap((kind) =>
  ATTRIBUTION_SCOPES.flatMap((scope) =>
    [true, false].map((crosses) => ({ kind, scope, crosses })),
  ),
)

describe('assertNoCrossPlaneLineage is total over the claim vocabulary', () => {
  it('enumerates the whole population, not a sample', () => {
    expect(CELLS.length).toBe(MEASUREMENT_KINDS.length * ATTRIBUTION_SCOPES.length * 2)
    expect(CELLS.length).toBeGreaterThan(90)
  })

  it.each(CELLS.map((cell) => [`${cell.kind} / ${cell.scope} / crosses=${cell.crosses}`, cell] as const))(
    '%s',
    (_name, cell) => {
      expect(evaluate(cell.kind, cell.scope, cell.crosses)).toBe(
        shouldThrow(cell.kind, cell.scope, cell.crosses),
      )
    },
  )

  it('every cross-plane cell that is NOT an honest declared estimate throws', () => {
    // The property the guard exists for, asserted over the population rather than an example.
    const escapes = CELLS
      .filter((cell) => cell.crosses)
      .filter((cell) => !(CROSS_PLANE_EXEMPT.has(cell.kind) && cell.scope === HONEST_CROSSING_SCOPE))
      .filter((cell) => !evaluate(cell.kind, cell.scope, cell.crosses))
      .map((cell) => `${cell.kind}/${cell.scope}`)
    expect(escapes).toEqual([])
  })

  it('no same-plane cell is ever rejected', () => {
    // The opposite failure. A guard that rejects everything also shows a clean suite.
    const falsePositives = CELLS
      .filter((cell) => !cell.crosses)
      .filter((cell) => evaluate(cell.kind, cell.scope, cell.crosses))
      .map((cell) => `${cell.kind}/${cell.scope}`)
    expect(falsePositives).toEqual([])
  })
})
