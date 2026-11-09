import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_SCOPES, ATTRIBUTION_SCOPE_DESCRIPTIONS, MetricClaimSchema, PAID_DELIVERY_PLANES,
  type MetricClaim,
} from '@/lib/cockpit/contracts'
import { parseAnswerBrief, renderAnswerBrief } from '@/lib/maxx/answer-brief'

/**
 * How attribution reads on a rendered evidence line.
 *
 * `claimLine` rendered `attributionScope` into a field labelled `caveat:`, and `meta.spend` carries
 * `'none'` — so the line said `caveat: none`, i.e. "no caveats", on the metric a reader is most likely
 * to divide by something. The same composite also repeated `maturity`, which the line already carried,
 * and buried `freshness`, which appeared nowhere else.
 *
 * The adjacency it enables is the failure no lineage guard can see, because NO ARITHMETIC OCCURS:
 * $585 of spend on one line, an all-source booking count on the next, and the reader computes a
 * "$22.50 paid CPA" describing nothing.
 */

const base = {
  claimId: 'meta.spend:2026-04-04:2026-04-23', metricKey: 'meta.spend', label: 'Meta spend',
  value: 585, unit: 'money', formula: null, definitionVersion: 1,
  source: { system: 'meta', role: 'delivery_truth', head: 'h', evidencePlane: 'meta_delivery' },
  entity: { level: 'account', id: 'act_1' }, attributionScope: 'none',
  window: { start: '2026-04-04', end: '2026-04-23', basis: 'closed_account_days', timezone: 'America/New_York' },
  comparison: { method: 'none', window: null }, asOf: '2026-04-24T12:00:00.000Z',
  availability: { state: 'available', blockerCodes: [] },
  coverage: { state: 'complete', numerator: 20, denominator: 20 },
  maturity: { state: 'settled', matureThrough: '2026-04-23' },
  freshness: { state: 'fresh', observedAt: '2026-04-24T12:00:00.000Z', maxAgeHours: 24 },
  setupFingerprint: 'sf', authority: { state: 'context', policyVersion: 'v1' },
  measurementKind: 'measured', inputClaimIds: [],
}
const claim = (over: Record<string, unknown> = {}): MetricClaim =>
  MetricClaimSchema.parse({ ...base, ...over })

const SPEND = claim()
const META_RESULTS = claim({
  claimId: 'meta.results:2026-04-04:2026-04-23', metricKey: 'meta.appointment_confirmed_results',
  label: 'Meta Results', value: 15, unit: 'count', attributionScope: 'meta_platform_modelled',
})
const ACUITY_BOOKINGS = claim({
  claimId: 'outcomes.bookings:2026-04-04:2026-04-23', metricKey: 'outcomes.value_bearing_bookings',
  label: 'Value-bearing bookings', value: 26, unit: 'count', attributionScope: 'all_sources',
  source: { system: 'outcomes', role: 'business_truth', head: 'ledger', evidencePlane: 'outcome_business' },
  entity: { level: 'business', id: 'biz_1' },
})
const UNAVAILABLE = claim({
  claimId: 'paid.cpa:2026-04-04:2026-04-23', metricKey: 'paid.exact_cpa', label: 'Exact paid CPA',
  value: null, unit: 'money', attributionScope: 'meta_click_associated_noncausal',
  source: { system: 'first_party_attribution', role: 'association_truth', head: 'h', evidencePlane: 'paid_association' },
  availability: { state: 'unavailable', blockerCodes: ['paid_manifest_missing'] },
  authority: { state: 'blocked', policyVersion: 'v1' },
})

function render(observed: MetricClaim[], unavailable: MetricClaim[] = []): string {
  const brief = parseAnswerBrief(JSON.stringify({
    summary: 'governed_claims',
    observations: observed.length ? [{ claim_ids: observed.map((c) => c.claimId) }] : [],
    action_decision_ids: [],
    unavailable_claim_ids: unavailable.map((c) => c.claimId),
    next_check: null,
  }))
  return renderAnswerBrief(brief, [...observed, ...unavailable])
}

describe('the evidence line says what each field holds', () => {
  it('never renders "caveat: none" on an unattributed delivery metric', () => {
    const line = render([SPEND])
    expect(line).not.toContain('caveat:')
    expect(line).toContain('attribution: not attributed')
  })

  it('gives freshness its own field instead of burying it', () => {
    expect(render([SPEND])).toContain('freshness: fresh')
    expect(render([SPEND])).not.toContain('observed at:')
  })

  it.each([
    'meta.ad.delivery_sub_status',
    'meta.adset.delivery_sub_status',
    'capi.dataset_quality',
  ])('keeps the source observation instant visible for %s', (metricKey) => {
    const tracked = claim({
      claimId: `${metricKey}:2026-04-24`,
      metricKey,
      label: 'Tracking status',
      value: 'available',
      unit: 'state',
    })
    expect(render([tracked])).toContain('observed at: 2026-04-24T12:00:00.000Z')
  })

  it('states maturity exactly once', () => {
    // The composite repeated a value the line already carried.
    const line = render([SPEND])
    expect([...line.matchAll(/maturity:/g)]).toHaveLength(1)
  })

  it('labels an unavailable claim as blocked, not caveated', () => {
    const line = render([], [UNAVAILABLE])
    expect(line).toContain('blocked by: paid_manifest_missing')
    expect(line).not.toContain('caveat:')
  })

  it.each(ATTRIBUTION_SCOPES)('renders %s as a description, never the raw token', (scope) => {
    // Totality over the enum, not the two values that happen to exist in the supply today.
    const description = ATTRIBUTION_SCOPE_DESCRIPTIONS[scope]
    expect(description).toBeTruthy()
    expect(description).not.toBe(scope)
    const line = render([claim({ attributionScope: scope })])
    expect(line).toContain(`attribution: ${description}`)
  })
})

const EVIDENCE_PLANES = [
  'meta_delivery', 'outcome_business', 'paid_association', 'ga4_telemetry', 'capi_delivery', 'decision',
] as const

describe('the notice classifier is total over the evidence planes', () => {
  it('covers every plane the claim contract defines', () => {
    // Enumerated, not sampled. The previous classifier keyed on attributionScope and was exercised on
    // 2 of 7 scopes; `ga4_session_classified` was a live false negative nobody had looked at.
    const planeSchema = MetricClaimSchema.parse({ ...base }).source.evidencePlane
    expect(EVIDENCE_PLANES).toContain(planeSchema)
    expect(EVIDENCE_PLANES.length).toBe(6)
  })

  it.each(EVIDENCE_PLANES)('an outcome_business claim beside a %s claim', (plane) => {
    const other = claim({
      claimId: `other.${plane}:2026-04-04:2026-04-23`, metricKey: `other.${plane}`, label: 'Other',
      value: 3, unit: 'count',
      source: { system: 'meta', role: 'delivery_truth', head: 'h', evidencePlane: plane },
      entity: plane === 'outcome_business' ? { level: 'business', id: 'b' } : { level: 'account', id: 'a' },
    })
    const fired = render([other, ACUITY_BOOKINGS]).includes('count different populations')
    // The rule, stated so it is reviewable rather than a table of booleans: a paid-delivery
    // population beside a business population, and nothing else.
    expect(fired).toBe(PAID_DELIVERY_PLANES.has(plane))
  })
})

describe('the non-comparability notice', () => {
  it('appears when an all-source count is rendered beside a paid-only figure', () => {
    const line = render([SPEND, ACUITY_BOOKINGS])
    expect(line).toContain('count different populations')
    expect(line).toMatch(/neither a share nor a cost per unit/)
  })

  it('still renders BOTH lines — reconciliation is the answer, not the offence', () => {
    // The first design forbade the adjacency. That forbids q1, whose whole task is reconciling Meta
    // with Acuity. Make it legible, not illegal.
    const line = render([SPEND, ACUITY_BOOKINGS])
    expect(line).toContain('**Meta spend — ')
    expect(line).toContain('**Value-bearing bookings — 26**')
  })

  it('stays silent when every claim is paid-only, however many scopes are mixed', () => {
    // Ordinary scope mixing is not the hazard. meta.cost_per_result divides `none` spend by
    // `meta_platform_modelled` results inside its own blessed lineage; a notice on every mixed brief
    // would be noise, and noise is ignored.
    const line = render([SPEND, META_RESULTS])
    expect(line).not.toContain('count different populations')
  })

  it('stays silent when only the all-source claim is present', () => {
    expect(render([ACUITY_BOOKINGS])).not.toContain('count different populations')
  })

  it('fires on a count-vs-count pair, where the misreading is a SHARE not a cost', () => {
    // "Meta reports 15 results, the business booked 26" invites "58% of bookings came from ads". No
    // currency is involved, and an earlier draft that required a usd numerator missed it entirely.
    expect(render([META_RESULTS, ACUITY_BOOKINGS])).toContain('count different populations')
  })

  it('fires when the paid claim is on the paid_association plane, not just meta_delivery', () => {
    // Keyed on population (plane), so every paid-delivery plane counts.
    const paidAssoc = claim({
      claimId: 'paid.touch:2026-04-04:2026-04-23', metricKey: 'paid.verified_touch_bookings',
      label: 'Verified paid-touch bookings', value: 7, unit: 'count',
      attributionScope: 'meta_click_associated_noncausal',
      source: { system: 'first_party_attribution', role: 'association_truth', head: 'h', evidencePlane: 'paid_association' },
    })
    expect(render([paidAssoc, ACUITY_BOOKINGS])).toContain('count different populations')
  })
})
