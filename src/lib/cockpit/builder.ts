import { classifyWindowSettle } from '@/lib/insights/settle-window'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import {
  assertNoCrossPlaneLineage,
  createMetricClaim,
  createPerformanceCockpitData,
  type MetricClaim,
  type MetricClaimInput,
  type PerformanceCockpitData,
} from './contracts'
import {
  COCKPIT_TIMEZONE,
  comparisonWindowKey,
  type CockpitEvidence,
  type CockpitRange,
  type LoadPerformanceCockpitOptions,
  type MetaDeliveryEvidence,
} from './evidence'
import { comparableWindows, cockpitTrendsEnabled, inclusiveDays } from './comparison-window'
import { metaOutcomeEventName } from '@/config/business-config'

const TIMEZONE = COCKPIT_TIMEZONE
const CONTRACT_POLICY = 'performance-cockpit-v3'

export type {
  CockpitEvidence,
  CockpitRange,
  LoadPerformanceCockpitOptions,
  MetaDeliveryEvidence,
  PartialTodayEvidence,
} from './evidence'

// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

function localDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant))
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function freshness(observedAt: string | null, asOf: string): MetricClaimInput['freshness'] {
  if (!observedAt) return { state: 'unknown', observedAt: null, maxAgeHours: REC_THRESHOLDS.MAX_DATA_AGE_HOURS }
  const ageHours = (Date.parse(asOf) - Date.parse(observedAt)) / 3_600_000
  return {
    state: Number.isFinite(ageHours) && ageHours <= REC_THRESHOLDS.MAX_DATA_AGE_HOURS ? 'fresh' : 'stale',
    observedAt,
    maxAgeHours: REC_THRESHOLDS.MAX_DATA_AGE_HOURS,
  }
}

/**
 * A claim id must identify exactly one claim.
 *
 * Exported because it cannot be fired through `assemblePerformanceCockpitData`: every cockpit claim
 * carries a distinct `metricKey` over one range, so no legitimate input collides and no test could
 * reach the throw. A guard nobody has watched fail is a guard nobody knows works — this one gets
 * watched directly, and a separate call-site assertion keeps it wired in.
 */
export function assertUniqueClaimIds(claims: ReadonlyArray<{ claimId: string }>): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const claim of claims) {
    if (seen.has(claim.claimId)) duplicates.add(claim.claimId)
    seen.add(claim.claimId)
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Cockpit built ${duplicates.size} duplicate claim id(s): ${[...duplicates].sort().join(', ')}. `
      + 'A claim id must identify exactly one claim — widen claimId() to include the entity.',
    )
  }
}

/**
 * A claim id must identify the claim's OWN window, not the window that was requested.
 *
 * These are the same today, which is why the divergence was invisible: `commonClaim` accepts a
 * `window` override and no caller passes one (the partial-today claims build their ids by hand). The
 * moment a prior-period claim exists — the same metric over a different window — deriving the id from
 * `input.range` gives BOTH claims the same id, `Object.fromEntries` silently keeps the last, and a
 * brief citing the dropped one fails to resolve for a reason no reader can diagnose.
 *
 * `assertUniqueClaimIds` would catch it loudly rather than silently. This makes it not happen.
 */
function claimId(metricKey: string, window: { start: string, end: string }): string {
  return `${metricKey}:${window.start}:${window.end}`
}

function commonClaim(input: CockpitEvidence, args: {
  metricKey: string
  label: string
  value: number | string | null
  unit: MetricClaimInput['unit']
  formula: string | null
  system: MetricClaimInput['source']['system']
  role: MetricClaimInput['source']['role']
  head: string | null
  plane: MetricClaimInput['source']['evidencePlane']
  attributionScope: MetricClaimInput['attributionScope']
  availability: MetricClaimInput['availability']
  coverage: MetricClaimInput['coverage']
  synchronizedAt: string | null
  authority: MetricClaimInput['authority']['state']
  measurementKind: MetricClaimInput['measurementKind']
  maturity?: MetricClaimInput['maturity']
  inputClaimIds?: string[]
  window?: MetricClaimInput['window']
  comparison?: MetricClaimInput['comparison']
}): MetricClaim {
  const today = localDate(input.asOf)
  const settle = classifyWindowSettle({ from: input.range.start, to: input.range.end, today })
  return createMetricClaim({
    claimId: claimId(args.metricKey, args.window ?? input.range),
    metricKey: args.metricKey,
    label: args.label,
    value: args.value,
    unit: args.unit,
    formula: args.formula,
    definitionVersion: 1,
    source: {
      system: args.system,
      role: args.role,
      head: args.head,
      evidencePlane: args.plane,
    },
    entity: {
      level: args.plane === 'outcome_business' ? 'business' : 'account',
      id: args.plane === 'outcome_business' ? input.account.id : input.account.metaAccountId,
    },
    attributionScope: args.attributionScope,
    window: args.window ?? input.range,
    // `none` for a point value, which is every claim but a trend. A trend is the one claim that IS a
    // comparison, and it must carry the window it was taken against in the STRUCTURED field — the
    // first version stated it only in `source.head`, as prose, while `comparison.window` stayed null.
    // The whole doctrine of this contract is that a statement lives in a field a reader can check,
    // and `MetricClaimSchema` enforces that method and window agree.
    comparison: args.comparison ?? { method: 'none', window: null },
    asOf: input.asOf,
    availability: args.availability,
    coverage: args.coverage,
    maturity: args.maturity ?? {
      state: settle.state,
      matureThrough: settle.settled_through,
    },
    freshness: freshness(args.synchronizedAt, input.asOf),
    setupFingerprint: null,
    authority: { state: args.authority, policyVersion: CONTRACT_POLICY },
    measurementKind: args.measurementKind,
    inputClaimIds: args.inputClaimIds ?? [],
  })
}

function sourceCoverage(source: MetaDeliveryEvidence): MetricClaimInput['coverage'] {
  if (source.expectedDays === 0) return { state: 'unknown', numerator: null, denominator: null }
  return {
    state: source.coveredDays === source.expectedDays ? 'complete' : 'partial',
    numerator: source.coveredDays,
    denominator: source.expectedDays,
  }
}

function metaDeliverySourceHead(base: string, input: CockpitEvidence): string {
  return input.delivery.synchronizedAt
    ? `${base}; delivery generation ${input.range.start}..${input.range.end} at ${input.delivery.synchronizedAt}`
    : base
}

/**
 * Every delivery-derived claim for ONE window, from ONE reading of the evidence.
 *
 * Extracted so a prior period can be built by the SAME code rather than a second copy of twelve
 * formulas. `commonClaim` already takes the window from `input.range`, so the caller substitutes the
 * evidence — `{ ...input, range: priorWindow, delivery: priorDelivery }` — and every availability
 * rule, blocker code, coverage rule and formula applies identically by construction. A hand-written
 * prior-period calculation would be twelve opportunities for the two sides of a comparison to be
 * computed differently, which is the one defect a trend cannot survive.
 *
 * Pure extraction: the body below is the original statements, moved. Verified by diffing the fully
 * assembled cockpit before and after — byte-identical.
 */
function buildDeliveryClaims(input: CockpitEvidence) {
  const deliveryCoverage = sourceCoverage(input.delivery)
  // The day count the reader actually observed.
  //
  // CORRECTING THE RECORD, because the commit that introduced this asserted a bug that does not
  // exist. It claimed the previous form rendered `20/20 · complete` on a 19-of-20-day window. It
  // could not: `spendAvailable` is false if ANY expected date is missing a row
  // (`source-readers.ts` pushes `meta_account_spend_day_missing:<date>` per absent day), so at 19 of
  // 20 the old code took its `deliveryCoverage` branch and rendered `partial`. The reviewer who
  // reported it proved it by handing a `{ coveredDays: 19, spendAvailable: true }` object straight
  // to this builder — a state `readMetaDelivery` cannot emit — and I repeated the conclusion as
  // measured fact without checking reachability.
  //
  // Kept anyway, and honestly labelled: `spendAvailable === true` implies every day is present, so
  // this reports the same value the old form did while deriving it from what was counted rather than
  // restating a flag. It is not a fix for a live defect and the trend's coverage guard remains
  // unreachable for `meta.spend` — see the note in `trendClaim`.
  const spendCoverage: MetricClaimInput['coverage'] = input.delivery.expectedDays === 0
    ? { state: 'unknown', numerator: null, denominator: null }
    : {
        state: input.delivery.spendCoveredDays === input.delivery.expectedDays ? 'complete' : 'partial',
        numerator: input.delivery.spendCoveredDays,
        denominator: input.delivery.expectedDays,
      }
  const spendClaim = commonClaim(input, {
    metricKey: 'meta.spend', label: 'Meta spend', value: input.delivery.spendAvailable ? input.delivery.spend : null,
    unit: 'money', formula: 'sum(authoritative account-level Meta spend)', system: 'meta',
    role: 'delivery_truth', head: metaDeliverySourceHead('daily_insights.account', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: input.delivery.spendAvailable && input.delivery.spend !== null
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_spend_unavailable']) },
    coverage: spendCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'measured',
    maturity: { state: 'settled', matureThrough: input.range.end },
  })
  const pacingClaim = commonClaim(input, {
    metricKey: 'meta.spend_pacing', label: 'Spend pacing', value: null,
    unit: 'percent',
    formula: 'selected-window spend / effective budget schedule for the same window × 100',
    system: 'meta', role: 'delivery_truth', head: 'budget history not yet proven for selected window',
    plane: 'meta_delivery', attributionScope: 'none',
    availability: { state: 'unavailable', blockerCodes: ['historical_budget_continuity_unproven'] },
    coverage: { state: 'unknown', numerator: null, denominator: null },
    synchronizedAt: input.delivery.synchronizedAt, authority: 'context', measurementKind: 'derived',
    inputClaimIds: [],
    maturity: { state: 'settled', matureThrough: input.range.end },
  })
  const resultsClaim = commonClaim(input, {
    metricKey: 'meta.appointment_confirmed_results', label: 'Meta Results',
    value: input.delivery.resultsAvailable ? input.delivery.results : null,
    unit: 'count', formula: `sum(canonical Meta ${EVENT} Results)`, system: 'meta',
    role: 'delivery_truth', head: metaDeliverySourceHead('daily_insights.campaign.bookings reconciled to account spend', input), plane: 'meta_delivery',
    attributionScope: 'meta_platform_modelled',
    availability: input.delivery.resultsAvailable && input.delivery.results !== null
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_results_unavailable']) },
    coverage: deliveryCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'modelled',
  })
  const costAvailable = spendClaim.availability.state === 'available'
    && resultsClaim.availability.state === 'available'
    && typeof resultsClaim.value === 'number' && resultsClaim.value > 0
  const costClaim = commonClaim(input, {
    metricKey: 'meta.cost_per_result', label: 'Meta cost per Result',
    value: costAvailable ? Number(spendClaim.value) / Number(resultsClaim.value) : null,
    unit: 'money', formula: 'Meta spend / canonical Meta Results', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.campaign.bookings + daily_insights.account.spend', input),
    plane: 'meta_delivery', attributionScope: 'meta_platform_modelled',
    availability: costAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: [
          resultsClaim.availability.state === 'available' && resultsClaim.value === 0
            ? 'meta_results_zero' : 'meta_cost_per_result_inputs_unavailable',
        ] },
    coverage: deliveryCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'derived',
    inputClaimIds: [spendClaim.claimId, resultsClaim.claimId],
  })

  const completeMetaCoverage: MetricClaimInput['coverage'] = input.delivery.spendAvailable
    ? { state: 'complete', numerator: input.delivery.expectedDays, denominator: input.delivery.expectedDays }
    : deliveryCoverage
  const purchaseValueAvailable = input.delivery.purchaseAvailable && input.delivery.purchaseValue !== null
  const purchaseValueClaim = commonClaim(input, {
    metricKey: 'meta.purchase_value', label: 'Meta purchase value', value: purchaseValueAvailable ? input.delivery.purchaseValue : null,
    unit: 'money', formula: 'sum(exact canonical Meta purchase action value)', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.action_values[purchase]', input), plane: 'meta_delivery',
    attributionScope: 'meta_platform_modelled', availability: purchaseValueAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_purchase_value_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'modelled',
  })
  const purchaseRoasAvailable = spendClaim.availability.state === 'available' && purchaseValueAvailable
    && typeof spendClaim.value === 'number' && spendClaim.value > 0
  const purchaseRoasClaim = commonClaim(input, {
    metricKey: 'meta.purchase_roas', label: 'Meta Purchase ROAS',
    value: purchaseRoasAvailable ? Number(purchaseValueClaim.value) / Number(spendClaim.value) : null,
    unit: 'ratio', formula: 'canonical Meta purchase action value / identical-window Meta spend', system: 'meta',
    role: 'delivery_truth', head: metaDeliverySourceHead('daily_insights.account.action_values[purchase] + spend', input),
    plane: 'meta_delivery', attributionScope: 'meta_platform_modelled', availability: purchaseRoasAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_purchase_roas_inputs_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'derived', inputClaimIds: purchaseRoasAvailable
      ? [spendClaim.claimId, purchaseValueClaim.claimId] : [],
  })
  const linkCtrAvailable = input.delivery.linkCtrAvailable && input.delivery.linkClicks !== null
    && input.delivery.impressions !== null && input.delivery.impressions > 0
  const linkClicksClaim = commonClaim(input, {
    metricKey: 'meta.link_clicks', label: 'Meta link clicks', value: linkCtrAvailable ? input.delivery.linkClicks : null,
    unit: 'count', formula: 'sum(canonical Meta link clicks)', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.link_clicks', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: linkCtrAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_link_clicks_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'measured',
  })
  const impressionsAvailable = input.delivery.impressions !== null && input.delivery.impressions > 0
    && input.delivery.cpmAvailable
  const impressionsClaim = commonClaim(input, {
    metricKey: 'meta.impressions', label: 'Meta impressions', value: impressionsAvailable ? input.delivery.impressions : null,
    unit: 'count', formula: 'sum(authoritative account-level Meta impressions)', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.impressions', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: impressionsAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_impressions_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'measured',
  })
  const linkCtrClaim = commonClaim(input, {
    metricKey: 'meta.link_ctr', label: 'Meta link CTR', value: linkCtrAvailable
      ? input.delivery.linkClicks! / input.delivery.impressions! * 100 : null,
    unit: 'percent', formula: 'canonical Meta link clicks / Meta impressions × 100', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.link_clicks + impressions', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: linkCtrAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_link_ctr_inputs_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'derived',
    inputClaimIds: linkCtrAvailable ? [linkClicksClaim.claimId, impressionsClaim.claimId] : [],
  })
  const cpmAvailable = input.delivery.cpmAvailable && input.delivery.impressions !== null
    && input.delivery.impressions > 0 && spendClaim.availability.state === 'available'
  const cpmClaim = commonClaim(input, {
    metricKey: 'meta.cpm', label: 'Meta CPM', value: cpmAvailable
      ? Number(spendClaim.value) / input.delivery.impressions! * 1000 : null,
    unit: 'money', formula: 'Meta spend / Meta impressions × 1,000', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.spend + impressions', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: cpmAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_cpm_inputs_unavailable']) },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'derived',
    inputClaimIds: cpmAvailable ? [spendClaim.claimId, impressionsClaim.claimId] : [],
  })
  const frequencyAvailable = input.delivery.frequencyAvailable && input.delivery.nativeFrequency !== null
  const frequencyClaim = commonClaim(input, {
    metricKey: 'meta.native_frequency', label: 'Meta frequency', value: frequencyAvailable ? input.delivery.nativeFrequency : null,
    unit: 'ratio', formula: 'native Meta all-days selected-period frequency', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('Meta all-days account insight', input), plane: 'meta_delivery', attributionScope: 'none',
    availability: frequencyAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_native_frequency_unavailable']) },
    coverage: frequencyAvailable ? completeMetaCoverage : { state: 'unknown', numerator: null, denominator: null },
    synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'measured',
  })
  /**
   * REACH, which the reader has been fetching and discarding.
   *
   * `source-readers` pulls `nativeReach` from the same native all-days rollup that supplies
   * frequency, and `evidence.ts` marked it optional "while no cockpit claim consumes it". Nothing
   * ever did. So the page showed frequency 1.6x with no denominator beside it, and a reader could
   * not tell a small pool hit often from a large pool hit twice — which is the fatigue question at
   * this spend, and the one number a media buyer said was most actionable and missing.
   *
   * Same availability gate as frequency, because it is the same rollup: if the native period read
   * failed, neither number exists.
   */
  const reachAvailable = frequencyAvailable && typeof input.delivery.nativeReach === 'number'
  const reachClaim = commonClaim(input, {
    metricKey: 'meta.native_reach', label: 'Meta reach', value: reachAvailable ? input.delivery.nativeReach! : null,
    unit: 'count', formula: 'native Meta all-days selected-period reach', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('Meta all-days account insight', input), plane: 'meta_delivery',
    attributionScope: 'none',
    availability: reachAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted([...input.delivery.blockerCodes, 'meta_native_reach_unavailable']) },
    coverage: reachAvailable ? completeMetaCoverage : { state: 'unknown', numerator: null, denominator: null },
    synchronizedAt: input.delivery.synchronizedAt, authority: 'authoritative', measurementKind: 'measured',
  })

  /**
   * OPTIMIZATION EVENTS PER WEEK, against Meta's published learning-exit threshold.
   *
   * `LEARNING_EXIT_EVENTS_PER_WEEK` is 50 and a small account may run well under ten. That single ratio is why
   * every conversion trend on this page is noise, and it was computed elsewhere in the codebase and
   * never shown here. Stating it turns the refusals from a shrug into an explanation.
   *
   * Derived from the Results claim over the window's own length, so it moves with the selected range
   * rather than assuming a week.
   */
  const windowDays = inclusiveDays(input.range.start, input.range.end)
  const optimizationRateAvailable = resultsClaim.availability.state === 'available'
    && typeof resultsClaim.value === 'number' && windowDays > 0
  const optimizationRateClaim = commonClaim(input, {
    metricKey: 'meta.optimization_events_per_week', label: 'Optimization events / week',
    value: optimizationRateAvailable ? (Number(resultsClaim.value) / windowDays) * 7 : null,
    unit: 'count', formula: 'canonical Meta Results ÷ days in window × 7', system: 'meta',
    role: 'delivery_truth', head: metaDeliverySourceHead('daily_insights.campaign.bookings', input),
    plane: 'meta_delivery', attributionScope: 'meta_platform_modelled',
    availability: optimizationRateAvailable ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['meta_optimization_rate_inputs_unavailable'] },
    coverage: deliveryCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'context', measurementKind: 'derived',
    inputClaimIds: optimizationRateAvailable ? [resultsClaim.claimId] : [],
  })

  const leadCostEvidenceAvailable = input.delivery.leadAvailable && input.delivery.leads !== null
  const costPerLeadAvailable = leadCostEvidenceAvailable && spendClaim.availability.state === 'available'
    && input.delivery.leads! > 0
  const costPerLeadClaim = leadCostEvidenceAvailable ? commonClaim(input, {
    metricKey: 'meta.cost_per_lead', label: 'Meta cost per Lead', value: costPerLeadAvailable
      ? Number(spendClaim.value) / input.delivery.leads! : null,
    unit: 'money', formula: 'Meta spend / exact canonical Meta lead action count', system: 'meta', role: 'delivery_truth',
    head: metaDeliverySourceHead('daily_insights.account.actions[lead] + spend', input), plane: 'meta_delivery',
    attributionScope: 'meta_platform_modelled', availability: costPerLeadAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['meta_lead_zero_or_spend_unavailable'] },
    coverage: completeMetaCoverage, synchronizedAt: input.delivery.synchronizedAt,
    authority: 'authoritative', measurementKind: 'derived', inputClaimIds: costPerLeadAvailable ? [spendClaim.claimId] : [],
  }) : null

  return {
    spendClaim, pacingClaim, resultsClaim, costClaim, purchaseValueClaim, purchaseRoasClaim,
    linkClicksClaim, impressionsClaim, linkCtrClaim, cpmClaim, frequencyClaim, costPerLeadClaim,
    reachClaim, optimizationRateClaim,
  }
}


/** The twelve delivery claims as a lookup, so a metric can be found by key rather than by field name. */
function deliveryClaimsByMetric(built: ReturnType<typeof buildDeliveryClaims>): Map<string, MetricClaim> {
  const list = [
    built.spendClaim, built.pacingClaim, built.resultsClaim, built.costClaim, built.purchaseValueClaim,
    built.purchaseRoasClaim, built.linkClicksClaim, built.impressionsClaim, built.linkCtrClaim,
    built.cpmClaim, built.frequencyClaim, built.costPerLeadClaim,
    built.reachClaim, built.optimizationRateClaim,
  ].filter((claim): claim is MetricClaim => claim !== null)
  return new Map(list.map((claim) => [claim.metricKey, claim]))
}

/**
 * Why a trend is refused, in the reader's terms. Every one of these is a REFUSAL, never a zero.
 *
 * "No change" and "we could not tell" are different statements, and a percent that silently means the
 * second is the whole class of defect this system exists to prevent.
 */
const TREND_BLOCKERS = {
  uncomparable: 'trend_window_uncomparable',
  windowUnread: 'trend_prior_window_unavailable',
  sideUnavailable: 'trend_side_unavailable',
  coverage: 'trend_window_coverage_incomplete',
  priorZero: 'trend_prior_period_zero',
  nonNumeric: 'trend_value_not_numeric',
  sampleTooSmall: 'trend_sample_too_small',
  // A MEMBER, not a bare literal at the call site. `blocker-labels-trend.test.ts` harvests codes from
  // this object precisely so the list cannot go stale — and this one was written inline in
  // `buildTrendClaims`, so the harvester enumerated seven codes and missed the eighth. The one code
  // the mechanism could not see was the one whose label nothing pinned.
  comparisonAbsent: 'trend_comparison_evidence_absent',
  // DISTINCT from `windowUnread`. One code covered three different situations and stated only one of
  // them: a window that genuinely could not be read, a window that read fine but has no figure for
  // THIS metric (cost-per-Lead in a period with no leads), and the CURRENT side being absent — where
  // "the earlier period could not be read" is simply false. Same class of defect as
  // `trend_prior_period_zero` reading as its own opposite.
  metricAbsent: 'trend_metric_absent_in_window',
} as const

/**
 * Metrics whose trend is only meaningful with enough EVENTS behind it.
 *
 * Every other blocker in this file is about data plumbing — an unread window, an incomplete one, a
 * zero denominator. None of them asks the question that actually invalidates a trend on a small
 * account: how many conversions are in the box.
 *
 * For example, weekly Meta Results over seven consecutive weeks with spend flat every week could
 * read 3, 8, 2, 5, 9, 4, 7. Week over week that is +167%, −75%, +150%, +80%, −56%, +75% — on an
 * account where nothing changed. A percent change computed from those
 * counts is not a small signal, it is noise rendered with server provenance and a settled window.
 *
 * The floor is the repository's own: `MIN_BOOKINGS_PERF_CLAIM` is 4 with a documented Poisson
 * relative-standard-error rationale (1/sqrt(n): four events is a 50%-RSE directional floor), and
 * `audience-performance.ts` already refuses to compare two groups below 3 results. That doctrine was
 * written for this exact question and the trend path was the one place not applying it.
 *
 * Count-shaped and count-DERIVED metrics both qualify: a cost-per-result built on 2 bookings inherits
 * the 2, and hiding that behind a division does not add information.
 *
 * Deliberately NOT applied to spend, impressions, link clicks, CTR or CPM. Those have real n here —
 * tens of thousands of impressions, hundreds of clicks — and their trends are sound.
 */
export const EVENT_BACKED_METRICS: ReadonlyMap<string, (source: MetaDeliveryEvidence) => number | null> = new Map([
  ['meta.appointment_confirmed_results', (source) => source.results],
  ['meta.cost_per_result', (source) => source.results],
  // The COUNT of purchases, never the value. An earlier version read `purchaseValue` here, so $3,000
  // of purchase value cleared a floor that means "four events" — money laundering a small sample into
  // a confident percentage, which is the exact defect this floor exists to stop.
  ['meta.purchase_value', (source) => source.purchaseCount],
  ['meta.purchase_roas', (source) => source.purchaseCount],
  ['meta.cost_per_lead', (source) => source.leads],
  // `results ÷ windowDays × 7`. Both windows are equal length by construction, so its percent change is
  // ARITHMETICALLY IDENTICAL to the Results trend — which is refused as `trend_sample_too_small`.
  // Shipped without this entry, one cockpit refused 2→40 Results and published the same 2→40 as
  // +1900% two rows down, in the same drawer, citable by the governed chat. A division by 14 and a
  // multiplication by 7 do not add events.
  ['meta.optimization_events_per_week', (source) => source.results],
])

/**
 * Every metric that gets a trend must have DECIDED whether the event floor applies to it.
 *
 * `EVENT_BACKED_METRICS` is an opt-IN map, so a metric added to `deliveryClaimsByMetric` silently
 * gets a trend with no floor — which is how the optimization rate shipped able to publish a
 * percentage the Results claim beside it had just refused. Membership tests cannot catch that: they
 * enumerate the metrics someone remembered. This is the totality property — union over the emitted
 * `*_change` claims, so a metric added later must be classified or the suite fails.
 *
 * Exported for `cockpit-trend-claims.test.ts`.
 */
export const FLOOR_EXEMPT_METRICS: ReadonlySet<string> = new Set([
  'meta.spend', 'meta.spend_pacing', 'meta.link_clicks', 'meta.impressions',
  'meta.link_ctr', 'meta.cpm', 'meta.native_frequency',
  // Reach is a natively de-duplicated PEOPLE count in the tens of thousands here, not an event
  // count — its n is never the thing that invalidates the comparison. Each window is deduplicated
  // within itself, which is how Meta reports it, so period-over-period reach is a like-for-like read.
  'meta.native_reach',
])

/**
 * One metric's change against its own equal-length prior period.
 *
 * PERCENT CHANGE, for every metric including the rate-shaped ones. A media buyer says "CTR up 12%"
 * and means relative change, so one rule reads correctly across counts, money and rates rather than
 * a percentage-point special case nobody expects. `formula` states it on every claim.
 *
 * THE COVERAGE CHECK BELOW IS UNREACHABLE, and saying so is more useful than the two wrong things
 * this docstring has claimed before it.
 *
 * It reads `side.availability.state === 'available' && side.coverage.state !== 'complete'`. No
 * delivery claim can satisfy both. `spendAvailable` requires every expected date to have a row, so
 * an available spend claim always has complete coverage. `coveredDays` is
 * `spendAvailable && resultsAvailable ? expectedDays : 0`, so a partial `deliveryCoverage` implies
 * `!resultsAvailable`, which makes the Results and cost-per-Result claims unavailable. The remaining
 * eight take `completeMetaCoverage`, which is complete whenever spend is available.
 *
 * So it is defence-in-depth against a future reader that reports a genuine per-day count, not a live
 * guard. What actually keeps a partial window out of production is `spendAvailable` itself, in
 * another file, plus caller-side range clamps this module does not enforce.
 *
 * Two earlier versions of this comment claimed otherwise — first that coverage "fails closed by
 * construction", then that it had been made "real". Both were written without checking whether the
 * branch can execute.
 */
function trendClaim(
  input: CockpitEvidence,
  args: {
    current: MetricClaim | null
    prior: MetricClaim | null
    window: CockpitRange
    priorWindow: CockpitRange | null
    metricKey: string
    label: string
    extraBlockers?: string[]
    /**
     * Loader-level detail naming WHICH window failed. Logged, never rendered: these are internal
     * identifiers, and `blockerLabel` has no mapping for them, so anything that reaches
     * `blockerCodes` reaches the owner as raw text.
     */
    diagnosticCodes?: string[]
    /** Events behind each side, for metrics whose trend needs a sample. null = not event-backed. */
    events?: { current: number | null, prior: number | null } | null
    /**
     * Whether each window was BUILT at all, which is a different fact from whether this metric has a
     * claim in it. Without it the two collapse into one blocker that states only the first.
     */
    sidesRead?: { current: boolean, prior: boolean }
  },
): MetricClaim {
  const { current, prior, window, priorWindow } = args
  const blockers = [...(args.extraBlockers ?? [])]
  // Surfaced for support and logs; deliberately NOT merged into `blockers`, which is owner-facing.
  if (args.diagnosticCodes?.length) {
    console.warn(`[Cockpit] ${args.metricKey}_change: ${args.diagnosticCodes.join(', ')}`)
  }

  if (priorWindow === null) blockers.push(TREND_BLOCKERS.uncomparable)
  if (current === null || prior === null) {
    // Which of the two facts is actually true here.
    const windowMissing = (current === null && args.sidesRead?.current === false)
      || (prior === null && args.sidesRead?.prior === false)
    blockers.push(windowMissing ? TREND_BLOCKERS.windowUnread : TREND_BLOCKERS.metricAbsent)
  }

  // A side that could not be measured takes its OWN blockers with it, so the reader learns why the
  // trend is missing rather than only that it is.
  for (const side of [current, prior]) {
    if (side && side.availability.state !== 'available') {
      blockers.push(TREND_BLOCKERS.sideUnavailable, ...side.availability.blockerCodes)
    }
  }
  for (const side of [current, prior]) {
    if (side && side.availability.state === 'available' && side.coverage.state !== 'complete') {
      blockers.push(TREND_BLOCKERS.coverage)
    }
  }

  const currentValue = typeof current?.value === 'number' ? current.value : null
  const priorValue = typeof prior?.value === 'number' ? prior.value : null
  if (blockers.length === 0 && (currentValue === null || priorValue === null)) {
    blockers.push(TREND_BLOCKERS.nonNumeric)
  }
  // Division by zero is not a 100% rise, and it is not a fall. It is a period with no denominator.
  if (blockers.length === 0 && priorValue === 0) blockers.push(TREND_BLOCKERS.priorZero)

  // ENOUGH EVENTS TO SAY ANYTHING. See EVENT_BACKED_METRICS: on a small account, weekly Results of
  // 3, 8, 2, 5, 9, 4, 7 at flat spend produce swings of +167% to −75% with nothing changed. Both
  // sides must clear the floor — a large current period against a prior of 1 is the same defect.
  if (blockers.length === 0 && args.events) {
    const { current: currentEvents, prior: priorEvents } = args.events
    const floor = REC_THRESHOLDS.MIN_BOOKINGS_PERF_CLAIM
    if (currentEvents === null || priorEvents === null
        || currentEvents < floor || priorEvents < floor) {
      blockers.push(TREND_BLOCKERS.sampleTooSmall)
    }
  }

  const available = blockers.length === 0
  const value = available && currentValue !== null && priorValue !== null
    ? ((currentValue - priorValue) / Math.abs(priorValue)) * 100
    : null

  const basis = current ?? prior
  return commonClaim(input, {
    metricKey: `${args.metricKey}_change`,
    label: `${args.label} vs prior period`,
    value: available && value !== null && Number.isFinite(value) ? value : null,
    unit: 'percent',
    formula: '(current window - equal-length prior window) / |prior window| x 100',
    system: 'meta',
    role: basis?.source.role ?? 'delivery_truth',
    head: priorWindow
      ? `${window.start}..${window.end} against ${priorWindow.start}..${priorWindow.end}`
      : 'no comparable prior window',
    plane: 'meta_delivery',
    // The trend describes the SAME population as the metric it is derived from. Inheriting rather
    // than hardcoding keeps a modelled metric's trend from claiming to be measured.
    attributionScope: basis?.attributionScope ?? 'none',
    availability: available
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted(blockers) },
    // A percent claim must carry complete coverage to be available at all (MetricClaimSchema), and
    // the two windows are only comparable when both were complete - so `complete` here is the
    // conclusion of the checks above, not an assumption.
    coverage: available
      ? { state: 'complete', numerator: 2, denominator: 2 }
      : { state: 'unknown', numerator: null, denominator: null },
    synchronizedAt: input.delivery.synchronizedAt,
    // Context, not authoritative: a trend is a reading of two governed numbers, and the numbers
    // themselves remain the authority.
    authority: 'context',
    measurementKind: 'derived',
    // CITED WHENEVER BOTH SIDES RESOLVED, not only when the percentage survived.
    //
    // A refused trend still has two real numbers behind it, and those numbers are what a media buyer
    // actually reads: "17 vs 13 bookings" carries everything the percentage does, with none of the
    // false precision, and it works where a percentage cannot — 0 to 3 at flat spend is the most
    // decision-relevant thing this account produced all summer, and it rendered as an absence.
    // Keeping the lineage is what lets the surface print the counts instead of a shrug.
    inputClaimIds: current && prior ? [current.claimId, prior.claimId] : [],
    window,
    comparison: priorWindow === null
      ? { method: 'none', window: null }
      : { method: 'prior_equal_period', window: priorWindow },
    maturity: current?.maturity ?? { state: 'not_applicable', matureThrough: null },
  })
}

/**
 * Every metric's trend, each over ITS OWN comparable window.
 *
 * The twelve metrics do not share a comparable period. `meta.spend` is stamped `settled` and compares
 * over the whole request; classifier-governed claims compare only the settled part. So the pair is
 * derived per claim from the claim's own maturity, and the delivery reading for each window is LOOKED
 * UP rather than assumed — a window the loader could not read leaves the trend unavailable with a
 * blocker naming it, never computed from a window that happened to be read.
 *
 * The prior-period claims are emitted into the claim set, not just consumed. `assertNoCrossPlaneLineage`
 * requires every `inputClaimIds` entry to resolve, and a trend whose inputs cannot be inspected is a
 * derivation nobody can check — the shape of a forged reference.
 */
function buildTrendClaims(input: CockpitEvidence, requested: Map<string, MetricClaim>): {
  trends: MetricClaim[]
  support: MetricClaim[]
  sharedPriorWindow: CockpitRange | null
} {
  const requestedKey = comparisonWindowKey(input.range)
  const built = new Map<string, Map<string, MetricClaim>>()
  const support = new Map<string, MetricClaim>()

  /** The twelve claims for one window, built by the SAME code that built the requested window. */
  const claimsForWindow = (window: CockpitRange): Map<string, MetricClaim> | null => {
    const key = comparisonWindowKey(window)
    if (key === requestedKey) return requested
    const cached = built.get(key)
    if (cached) return cached
    const delivery = input.comparison?.deliveryByWindow[key]
    if (!delivery) return null
    const claims = deliveryClaimsByMetric(buildDeliveryClaims({ ...input, range: window, delivery }))
    built.set(key, claims)
    for (const claim of claims.values()) support.set(claim.claimId, claim)
    return claims
  }

  // OFF IS THE PRE-TREND SURFACE. Emitting twelve unavailable `*_change` claims would put a permanent
  // "No prior-period comparison" line under every metric — worse than either on or before.
  if (!cockpitTrendsEnabled()) return { trends: [], support: [], sharedPriorWindow: null }

  const trends: MetricClaim[] = []
  const priorWindows = new Map<string, CockpitRange>()
  for (const [metricKey, claim] of requested) {
    const pair = comparableWindows(input.range, claim.maturity)
    const currentClaims = pair ? claimsForWindow(pair.current) : null
    const priorClaims = pair ? claimsForWindow(pair.prior) : null
    if (pair) priorWindows.set(comparisonWindowKey(pair.prior), pair.prior)
    // The COUNT behind this metric on each side, read from that window's own DELIVERY EVIDENCE — not
    // from a claim value, which for a derived metric is a ratio that hides its own n, and which for
    // purchase value is money rather than events.
    const eventsOf = EVENT_BACKED_METRICS.get(metricKey)
    const eventCount = (window: CockpitRange | undefined): number | null => {
      if (!eventsOf || !window) return null
      const key = comparisonWindowKey(window)
      const source = key === requestedKey ? input.delivery : input.comparison?.deliveryByWindow[key]
      return source ? eventsOf(source) : null
    }
    trends.push(trendClaim(input, {
      current: currentClaims?.get(metricKey) ?? null,
      prior: priorClaims?.get(metricKey) ?? null,
      sidesRead: { current: currentClaims !== null, prior: priorClaims !== null },
      window: pair?.current ?? input.range,
      priorWindow: pair?.prior ?? null,
      metricKey,
      label: claim.label,
      // The loader's codes are DIAGNOSTIC, and they do not go in front of the owner.
      //
      // Forwarding them verbatim reintroduced the exact defect the labelling commit had just removed:
      // `sorted()` is alphabetical, `cockpit_…` beats `trend_…`, and both renderers show
      // `blockerLabel(blockerCodes[0])` — so the raw internal code OUTRANKED the owner-English label
      // meant to supplement it, and the cell read
      //   "No prior-period comparison · cockpit trend window read failed:2026-07-12:2026-07-31".
      //
      // The owner-facing reason is `trend_prior_window_unavailable`, already labelled. The loader's
      // detail belongs in `diagnosticCodes`, which nothing renders — it is for a log and a support
      // question, not a metric cell.
      extraBlockers: input.comparison ? [] : [TREND_BLOCKERS.comparisonAbsent],
      diagnosticCodes: input.comparison && !(currentClaims && priorClaims)
        ? input.comparison.blockerCodes
        : [],
      events: eventsOf ? { current: eventCount(pair?.current), prior: eventCount(pair?.prior) } : null,
    }))
  }

  // Only claims actually cited need to be in the set; the rest of a prior window's twelve would be
  // unreferenced noise in the cockpit and in the chat's claim supply.
  //
  // TRANSITIVELY CLOSED, and that is not a nicety. A derived claim cites its OWN inputs in its OWN
  // window — `meta.cost_per_result:A..B` lists `meta.spend:A..B` — so keeping only the claims a trend
  // names drops those inputs and `assertNoCrossPlaneLineage` throws: "lists input ..., which is not
  // in the claim set". Found by execution, not by review, and only in the settling case, because when
  // the comparable window equals the requested one those inputs resolve against the requested claims
  // and nothing is missing.
  const cited = new Set<string>()
  const pending = trends.flatMap((trend) => trend.inputClaimIds)
  while (pending.length > 0) {
    const id = pending.pop()!
    if (cited.has(id)) continue
    cited.add(id)
    // Only follow lineage into claims this function built. An id already in the requested set
    // resolves there, and the requested claims are always emitted.
    const claim = support.get(id)
    if (claim) pending.push(...claim.inputClaimIds)
  }
  return {
    trends,
    support: [...support.values()].filter((claim) => cited.has(claim.claimId)),
    // A single cockpit-level prior window is only TRUE when every trend shares one, which happens
    // when the whole request is settled and both maturities collapse to the same pair. Otherwise null,
    // and each trend carries its own — stating one window for differing trends would be a caption
    // that contradicts the rows beneath it.
    sharedPriorWindow: priorWindows.size === 1 ? [...priorWindows.values()][0] : null,
  }
}

/** Pure assembly layer. It cannot fetch or silently widen the requested date window. */
/**
 * Ledger G. One `sourceHealth` row per evidence plane the page can actually speak to.
 *
 * Meta delivery is unconditional — this is a Meta cockpit, and a page that cannot say how its own
 * primary plane is doing is not shippable. Every other plane is emitted ONLY when `input.planeHealth`
 * carries a real read for it. An absent reader produces NO ROW, never a synthesized `unavailable`:
 * "we never asked" and "we asked and it is down" are different facts, and rendering the first as the
 * second is the same error as reading an empty result as absence.
 *
 * `consumedByToday` is derived from the assembled claim set, not asserted by the caller, so it cannot
 * drift from what the page actually rendered.
 */
function buildSourceHealth(
  input: CockpitEvidence,
  metaStale: boolean,
  claims: readonly MetricClaim[],
): PerformanceCockpitData['sourceHealth'] {
  const planesOnPage = new Set(claims.map((claim) => claim.source.evidencePlane))
  const rows: PerformanceCockpitData['sourceHealth'] = [{
    plane: 'meta_delivery',
    state: input.delivery.spendAvailable && input.delivery.resultsAvailable
      ? metaStale ? 'stale' : 'available'
      : input.delivery.spendAvailable ? 'partial' : 'unavailable',
    synchronizedAt: input.delivery.synchronizedAt,
    blockerCodes: sorted(input.delivery.blockerCodes),
    consumedByToday: planesOnPage.has('meta_delivery'),
  }]
  // The builder names NO non-Meta plane. See `PlaneHealthEvidence.plane` for why that is load-bearing
  // rather than stylistic.
  for (const health of input.planeHealth ?? []) {
    rows.push({
      plane: health.plane,
      state: health.state,
      synchronizedAt: health.synchronizedAt,
      blockerCodes: sorted(health.blockerCodes),
      consumedByToday: planesOnPage.has(health.plane),
    })
  }
  return rows
}

export function assemblePerformanceCockpitData(input: CockpitEvidence): PerformanceCockpitData {
  const today = localDate(input.asOf)
  const settle = classifyWindowSettle({ from: input.range.start, to: input.range.end, today })
  const {
    spendClaim, pacingClaim, resultsClaim, costClaim, purchaseValueClaim, purchaseRoasClaim,
    linkClicksClaim, impressionsClaim, linkCtrClaim, cpmClaim, frequencyClaim, costPerLeadClaim,
    reachClaim, optimizationRateClaim,
  } = buildDeliveryClaims(input)

  const partialTodayAvailable = input.partialToday.available && input.partialToday.spend !== null
  const partialTodayClaim = createMetricClaim({
    claimId: `meta.partial_today_spend:${input.partialToday.date}`,
    metricKey: 'meta.partial_today_spend', label: 'Today so far spend',
    value: partialTodayAvailable ? input.partialToday.spend : null, unit: 'money',
    formula: 'current partial account-day Meta spend', definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: input.account.metaAccountId }, attributionScope: 'none',
    window: { start: input.partialToday.date, end: input.partialToday.date, basis: 'partial_today', timezone: TIMEZONE },
    comparison: { method: 'none', window: null }, asOf: input.asOf,
    availability: partialTodayAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: sorted(input.partialToday.blockerCodes.length > 0
          ? input.partialToday.blockerCodes : ['partial_today_unavailable']) },
    coverage: { state: 'not_applicable', numerator: null, denominator: null },
    maturity: { state: 'partial', matureThrough: null },
    freshness: freshness(input.partialToday.synchronizedAt, input.asOf), setupFingerprint: null,
    authority: { state: 'context', policyVersion: CONTRACT_POLICY }, measurementKind: 'measured',
    inputClaimIds: [],
  })
  /**
   * The daily budget, as a NUMBER the owner can read.
   *
   * It was already read (`readDailyBudget`, CBO/ABO-safe) and used only as the denominator of a
   * percentage. So the page said "87.0% of current daily budget" and never said what the budget is —
   * and "should I scale" is a decision made against the dollar figure, not against its ratio. Every
   * other number on this surface is a governed claim with an evidence row; this one was arithmetic
   * that happened inside another claim's formula.
   *
   * `context`, not `authoritative`: it is the CURRENT effective budget, a live setting rather than a
   * closed-period measurement, and it is `operational` for the same reason — it describes how the
   * account is configured, not what Meta delivered.
   */
  const dailyBudgetAvailable = input.partialToday.dailyBudget !== null && input.partialToday.dailyBudget > 0
  const dailyBudgetClaim = createMetricClaim({
    claimId: `meta.current_daily_budget:${input.partialToday.date}`,
    metricKey: 'meta.current_daily_budget', label: 'Current daily budget',
    value: dailyBudgetAvailable ? input.partialToday.dailyBudget : null,
    unit: 'money', formula: 'sum of active ad-set budgets, CBO parents counted once',
    definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'current effective daily budget', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: input.account.metaAccountId }, attributionScope: 'none',
    window: { start: input.partialToday.date, end: input.partialToday.date, basis: 'partial_today', timezone: TIMEZONE },
    comparison: { method: 'none', window: null }, asOf: input.asOf,
    availability: dailyBudgetAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['meta_daily_budget_unavailable'] },
    coverage: { state: 'not_applicable', numerator: null, denominator: null },
    maturity: { state: 'settled', matureThrough: input.partialToday.date },
    freshness: freshness(input.partialToday.synchronizedAt, input.asOf), setupFingerprint: null,
    authority: { state: 'context', policyVersion: CONTRACT_POLICY }, measurementKind: 'operational',
    inputClaimIds: [],
  })

  const todayPacingAvailable = partialTodayAvailable
    && input.partialToday.dailyBudget !== null && input.partialToday.dailyBudget > 0
  const partialTodayPacingClaim = createMetricClaim({
    claimId: `meta.partial_today_budget_pacing:${input.partialToday.date}`,
    metricKey: 'meta.partial_today_budget_pacing', label: 'Today budget pace',
    value: todayPacingAvailable
      ? input.partialToday.spend! / input.partialToday.dailyBudget! * 100 : null,
    unit: 'percent', formula: 'today-so-far Meta spend / current effective daily budget × 100',
    definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'daily_insights.account + current effective budget', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: input.account.metaAccountId }, attributionScope: 'none',
    window: { start: input.partialToday.date, end: input.partialToday.date, basis: 'partial_today', timezone: TIMEZONE },
    comparison: { method: 'none', window: null }, asOf: input.asOf,
    availability: todayPacingAvailable
      ? { state: 'available', blockerCodes: [] }
      : { state: 'unavailable', blockerCodes: ['partial_today_budget_pacing_unavailable'] },
    // Coverage is complete for the two pacing inputs; maturity independently remains partial because
    // today's spend is still accruing. These axes must not be conflated.
    coverage: todayPacingAvailable
      ? { state: 'complete', numerator: 2, denominator: 2 }
      : { state: 'unknown', numerator: null, denominator: null },
    maturity: { state: 'partial', matureThrough: null },
    freshness: freshness(input.partialToday.synchronizedAt, input.asOf), setupFingerprint: null,
    authority: { state: 'context', policyVersion: CONTRACT_POLICY }, measurementKind: 'derived',
    // BOTH inputs. The pace is spend ÷ budget, and it cited only the spend — so the drawer showed
    // where the numerator came from and left the denominator, the number the reader most wants to
    // check, with no row at all.
    inputClaimIds: todayPacingAvailable ? [partialTodayClaim.claimId, dailyBudgetClaim.claimId] : [],
  })

  const requestedByMetric = deliveryClaimsByMetric({
    spendClaim, pacingClaim, resultsClaim, costClaim, purchaseValueClaim, purchaseRoasClaim,
    linkClicksClaim, impressionsClaim, linkCtrClaim, cpmClaim, frequencyClaim, costPerLeadClaim,
    reachClaim, optimizationRateClaim,
  })
  const trend = buildTrendClaims(input, requestedByMetric)

  const claims = [...trend.trends, ...trend.support,
    reachClaim, optimizationRateClaim,
    spendClaim, pacingClaim, resultsClaim, costClaim, purchaseValueClaim,
    purchaseRoasClaim, linkClicksClaim, impressionsClaim, linkCtrClaim, cpmClaim, frequencyClaim,
    ...(costPerLeadClaim ? [costPerLeadClaim] : []),
    partialTodayClaim, partialTodayPacingClaim, dailyBudgetClaim]
  // A claim id must IDENTIFY a claim. `claimId()` is `metricKey:start:end` — it carries no entity,
  // so the moment adset- or ad-level claims exist (which `brief-expectations.ts` records as the
  // reason two eval gates are permanently unreachable) `meta.spend:A:B` at account level and the
  // same metric at adset level become the same string.
  //
  // The failure is silent: `Object.fromEntries` below keeps the LAST of any duplicate pair and drops
  // the other with no error, so a claim vanishes before `assertNoCrossPlaneLineage` ever sees it, and
  // a brief citing the dropped id fails to resolve — withholding a correct answer for a reason no
  // reader could diagnose. (An earlier version of this comment also claimed a duplicate could render
  // "adset spend under the account's label". It could not: `claimLine` renders `claim.label` from the
  // RESOLVED claim, so the label would be the surviving claim's own. The drop is the whole harm.)
  //
  // Assert instead of widening the id format. The format is NOT persisted lineage — recommendation
  // claims mint their own `metric_claim:${randomUUID()}` (`metric-claim-binding.ts:94`) — so changing
  // it is possible, but it is speculative while only account-level claims exist. This fails loudly
  // at construction the moment that stops being true, which is when the correct new format is
  // actually knowable.
  assertUniqueClaimIds(claims)
  const claimMap = Object.fromEntries(claims.map((claim) => [claim.claimId, claim]))
  // Enforced here because this is the only point that holds every claim at once; the schema sees
  // lineage ids but not the planes behind them.
  assertNoCrossPlaneLineage(claimMap)
  const metaFreshness = freshness(input.delivery.synchronizedAt, input.asOf)

  return createPerformanceCockpitData({
    contractVersion: 4,
    account: input.account,
    controls: { range: input.range },
    clocks: {
      deliveryClosedThrough: input.delivery.spendAvailable ? input.range.end : null,
      conversionMatureThrough: settle.settled_through,
      synchronizedAt: input.synchronizedAt,
    },
    claims: claimMap,
    paidPerformance: {
      spendClaimId: spendClaim.claimId,
      pacingClaimId: pacingClaim.claimId,
      resultsClaimId: resultsClaim.claimId,
      costPerResultClaimId: costClaim.claimId,
      purchaseRoasClaimId: purchaseRoasClaim.claimId,
      linkCtrClaimId: linkCtrClaim.claimId,
      cpmClaimId: cpmClaim.claimId,
      frequencyClaimId: frequencyClaim.claimId,
      costPerLeadClaimId: costPerLeadClaim?.claimId ?? null,
      reachClaimId: reachClaim.claimId,
      optimizationRateClaimId: optimizationRateClaim.claimId,
    },
    partialToday: {
      date: today,
      state: partialTodayAvailable ? 'partial' : 'unavailable',
      claimIds: [partialTodayClaim.claimId, partialTodayPacingClaim.claimId, dailyBudgetClaim.claimId],
    },
    comparison: {
      // `not_requested` only when the caller supplied no comparison evidence at all — an older caller
      // that predates trends. Otherwise the trends exist and say for themselves whether each is
      // available, which is a per-metric fact this single field cannot carry.
      state: !cockpitTrendsEnabled() || input.comparison === undefined
        ? 'not_requested'
        : trend.trends.some((claim) => claim.availability.state === 'available') ? 'available' : 'unavailable',
      window: trend.sharedPriorWindow,
      claimIds: trend.trends.map((claim) => claim.claimId),
    },
    sourceHealth: buildSourceHealth(input, metaFreshness.state === 'stale', claims),
    decisionIds: [...new Set(input.decisionIds)],
    primaryDecisionId: input.primaryDecisionId,
    primaryDecision: input.primaryDecision,
  })
}

/** Server loader entry point kept stable for pages and API consumers. */
export async function loadPerformanceCockpitData(
  options: LoadPerformanceCockpitOptions,
): Promise<PerformanceCockpitData> {
  const { loadPerformanceCockpitDataImpl } = await import('./loader')
  return loadPerformanceCockpitDataImpl(options)
}
