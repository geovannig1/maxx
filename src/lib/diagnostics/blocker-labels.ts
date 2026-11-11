import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// Owner-facing labels for the internal blocker codes that gate paid-cohort and creative-assignment
// evidence. The codes are API contract values (validated by z.enum, carried in MCP payloads and stored
// rows) and stay exactly as they are — this module is ADDITIVE. It exists because the codes were being
// rendered directly to the owner, who was reading `assignment_history_missing, incomplete_touch_identity`
// on his dashboard.
//
// Same shape as src/lib/conversions/labels.ts: a record plus a lookup with a normalising fallback, so an
// unmapped code degrades to readable words rather than disappearing or throwing.

/** Paid-cohort blockers — see PAID_COHORT_BLOCKER_CODES in lib/attribution/paid-cohort-reader.ts. */
const PAID_COHORT_LABELS: Record<string, string> = {
  activation_missing: 'paid measurement was never switched on',
  pre_activation_window: 'this period predates paid measurement being switched on',
  maturity_lag_not_met: 'too recent to judge — the results window has not closed yet',
  invalid_timezone: 'the account timezone could not be read',
  invalid_source_boundary: 'the measurement window boundary is invalid',
  stale_insight_source: 'the Meta delivery data behind this is out of date',
  // Plane-health codes (Ledger G). Without these the owner sees the raw token via the
  // `replaceAll('_', ' ')` fallback — e.g. "Outcome ledger window not covered:2026-08-01..2026-08-31
  // outside 1900-01-01..2026-08-30" — on /truth, the page whose whole subject is trustworthiness.
  outcome_ledger_window_not_covered: `the ${OW.one} ledger has not been reconciled through the end of this date range`,
  outcome_ledger_health_stale: `the ${OW.one} ledger has not been reconciled recently`,
  outcome_ledger_health_missing: `the ${OW.one} ledger has never been reconciled for this account`,
  outcome_ledger_health_invalid: `the ${OW.one} ledger health record is unreadable`,
  outcome_ledger_health_truncated: `the last ${OW.one} sync did not finish`,
  outcome_ledger_health_truncation_unknown: `we cannot tell whether the last ${OW.one} sync finished`,
  outcome_ledger_health_window_unknown: `we cannot tell which dates the ${OW.one} ledger covers`,
  outcome_ledger_health_invalid_future_timestamp: `the ${OW.one} ledger reports a sync time in the future`,
  outcome_ledger_request_window_invalid: 'the requested date range starts after it ends',
  outcome_booking_date_coverage_unproven: `we cannot prove which dates the ${OW.one} ledger covers`,
  ga4_telemetry_unavailable: 'GA4 did not answer on the last check',
  ga4_telemetry_health_stale: 'GA4 has not been checked recently',
  ga4_telemetry_health_invalid: 'the GA4 health record is unreadable',
  ga4_telemetry_health_incomplete: 'the GA4 check did not record a result',
  ga4_telemetry_health_invalid_future_timestamp: 'the GA4 health record reports a check time in the future',
  plane_health_read_failed: 'we could not read source health from the database',
  appointment_source_unavailable: `the ${OW.one} ledger could not be read`,
  stale_appointment_state: `${OW.one} states are out of date`,
  missing_account_insight_days: 'some days of Meta delivery data are missing',
  duplicate_account_insights: 'Meta returned duplicate account-level rows',
  duplicate_ad_insights: 'Meta returned duplicate ad-level rows',
  invalid_insight_metrics: 'Meta returned delivery figures that failed validation',
  spend_reconciliation_failed: 'spend did not reconcile across sources',
  incomplete_insight_identity: 'some delivery rows cannot be tied to a specific ad',
  landing_page_views_unavailable: 'Meta did not report landing-page views',
  capture_coverage_mismatch: 'fewer paid clicks were captured on the site than Meta reported',
  source_cannot_carry_token: 'an enabled outcome source (such as a CSV import) cannot link results to ad clicks',
  paid_completeness_manifest_unavailable: 'no proof exists that every paid click was evaluated',
  paid_completeness_manifest_mismatch: 'the completeness proof disagrees with what was captured',
  paid_capture_source_incomplete: 'the click-capture source is incomplete',
  paid_linker_source_incomplete: `the click-to-${OW.one} linker is incomplete`,
  incomplete_touch_identity: 'some captured clicks cannot be tied to a specific ad',
  invalid_touch_time: 'a captured click has an invalid timestamp',
  duplicate_touch_id: 'the same click was captured more than once',
  orphan_link_touch: `${withIndefiniteArticle(OW.one)} links to a click that was never captured`,
  link_touch_mismatch: `${withIndefiniteArticle(OW.one)} and its linked click disagree`,
  appointment_state_missing: `${withIndefiniteArticle(OW.one)} has no recorded state`,
  invalid_appointment_value: `${withIndefiniteArticle(OW.one)} has an invalid value`,
  invalid_appointment_revenue: `${withIndefiniteArticle(OW.one)} has invalid revenue`,
}

/** Creative-assignment blockers — see CreativeAssignmentBlocker in lib/creative/assignment-stability.ts. */
const CREATIVE_ASSIGNMENT_LABELS: Record<string, string> = {
  assignment_history_missing: 'no record of which creative this ad was running',
  assignment_identity_missing: 'the creative on this ad cannot be identified',
  assignment_changed: 'the creative on this ad changed during the period',
  ad_mutation_ambiguous: 'this ad was edited in a way that cannot be interpreted',
  assignment_evidence_invalid: 'the creative-assignment record failed validation',
}

/** Codes injected downstream that belong to neither typed union (blocker_codes is string[] there). */
const UNTYPED_LABELS: Record<string, string> = {
  paid_unit_metric_unavailable: 'a required per-ad figure is unavailable',
  unit_not_present: 'this ad is not in the measured set',
  versioned_vision_missing: 'this creative has not been analysed yet',
  campaign_plan_not_implemented: 'an approved campaign plan does not exist yet',
  experiment_registry_not_implemented: 'experiment tracking is not built yet',
  meta_object_creation_not_implemented: 'creating objects in Meta is not built yet',
}

/**
 * Prior-period trend blockers — see TREND_BLOCKERS in lib/cockpit/builder.ts.
 *
 * These shipped unmapped, so the cockpit rendered `trend window coverage incomplete` under a metric
 * cell — the exact thing this module's header says it exists to prevent.
 *
 * `trend_prior_period_zero` was the worst: read as English, "trend prior period zero" says the trend
 * was zero, i.e. FLAT. It means the opposite — there was no baseline to measure against. A label that
 * states the reverse of the fact is worse than the raw code, because the raw code at least looks like
 * something to ask about.
 *
 * Written as what the OWNER needs to know, not as what the code checked.
 */
const TREND_LABELS: Record<string, string> = {
  trend_window_uncomparable:
    'no complete earlier period to compare — Meta is still restating the most recent days',
  trend_prior_window_unavailable: 'the earlier period could not be read',
  trend_side_unavailable: 'one of the two periods has no figure to compare',
  trend_window_coverage_incomplete: 'one of the two periods is missing days of data',
  trend_prior_period_zero: 'nothing to compare against — the earlier period had none',
  trend_value_not_numeric: 'one of the two figures is not a number that can be compared',
  trend_comparison_evidence_absent: 'comparison data was not loaded for this view',
  // UNIT-NEUTRAL, deliberately. `EVENT_BACKED_METRICS` gates purchase value and ROAS on PURCHASE
  // COUNT and cost-per-Lead on LEADS, not on bookings — so "too few bookings" was false under three
  // of the five cells it guards, and an account that never records `leads` makes it false every
  // day. Same class of defect as `trend_prior_period_zero` reading as its own opposite: a
  // label that states something other than the fact.
  trend_sample_too_small: 'too few of these events in the two periods for a percentage to mean anything',
  trend_metric_absent_in_window: 'this metric has no figure in one of the two periods',
  cockpit_trend_read_threw: 'the comparison data could not be loaded',
}

/**
 * Cockpit cell blockers — why one metric on the dashboard has no figure.
 *
 * These are NOT trend codes; they are the point-value refusals a cell shows in place of a number.
 * All three shipped as bare literals in `builder.ts` with no label, so the owner read
 * `meta optimization rate inputs unavailable` — the exact raw-code leak this file exists to prevent.
 * `blocker-labels-trend.test.ts` harvests every blocker literal in `builder.ts`, not one object, so
 * a code added without a label fails the suite rather than reaching the dashboard.
 */
const COCKPIT_CELL_LABELS: Record<string, string> = {
  meta_spend_unavailable: 'Meta did not return spend for this period',
  meta_results_unavailable: `Meta did not return ${OW.many} for this period`,
  meta_results_zero: `no ${OW.many} in this period, so there is no cost per ${OW.one} to show`,
  meta_cost_per_result_inputs_unavailable: `needs both spend and ${OW.many}, and one of them is missing`,
  meta_purchase_value_unavailable: 'Meta did not return purchase value for this period',
  meta_purchase_roas_inputs_unavailable: 'needs both purchase value and spend, and one of them is missing',
  meta_link_clicks_unavailable: 'Meta did not return link clicks for this period',
  meta_impressions_unavailable: 'Meta did not return impressions for this period',
  meta_link_ctr_inputs_unavailable: 'needs both clicks and impressions, and one of them is missing',
  meta_cpm_inputs_unavailable: 'needs both spend and impressions, and one of them is missing',
  meta_native_frequency_unavailable: 'Meta did not return frequency for this period',
  meta_native_reach_unavailable: 'Meta did not return reach for this period',
  meta_optimization_rate_inputs_unavailable: `no ${OW.many} figure to turn into a weekly rate`,
  meta_lead_zero_or_spend_unavailable: 'no leads in this period, or spend is missing',
  historical_budget_continuity_unproven: 'we cannot prove the daily budget held steady across this period',
  partial_today_budget_pacing_unavailable: "today's spend or the daily budget is missing, so pace cannot be shown",

  // ── The READER's codes ──────────────────────────────────────────────────────────────────────
  // These come out of `source-readers.ts` and `loader.ts` into `delivery.blockerCodes`, which the
  // builder spreads into each claim — so they render to the owner exactly like the builder's own.
  // The harvester originally read one OBJECT, then one FILE; the population spans three, and
  // widening it to all three found THIRTY more codes that had been reaching the dashboard raw.
  meta_delivery_read_failed: 'the Meta delivery figures could not be read',
  meta_sync_generation_read_failed: 'the record of the last Meta sync could not be read',
  meta_sync_generation_not_successful: 'the last Meta sync for this period did not finish',
  meta_sync_generation_window_uncovered: 'the last Meta sync did not cover all of this period',
  meta_account_spend_day_missing: 'Meta returned no spend row for one or more days',
  meta_account_spend_day_incomplete: 'a day of Meta spend came back incomplete',
  // The capped forms. `boundedDayCodes` enumerates the first few dates and then states the total, so
  // a wide window reports "and this many more" instead of one code per day.
  meta_account_spend_day_missing_count: 'days in this period with no Meta spend row at all',
  meta_account_spend_day_incomplete_count: 'days in this period whose Meta spend came back incomplete',
  meta_account_spend_window_invalid: 'the spend rows do not line up with the period requested',
  meta_account_spend_unavailable_for_result_reconciliation: `spend is missing, so ${OW.many} cannot be reconciled against it`,
  meta_campaign_results_read_failed: `the campaign ${OW.one} figures could not be read`,
  meta_campaign_results_page_limit_exceeded: 'Meta returned more campaign rows than can be read safely',
  meta_campaign_result_duplicate: 'Meta returned the same campaign row more than once',
  meta_campaign_result_incomplete: 'a campaign row came back missing figures',
  meta_campaign_result_identity_invalid: 'a campaign row cannot be tied to a known campaign',
  meta_campaign_spend_reconciliation_failed: 'campaign spend does not add up to the account total',
  meta_impressions_missing: 'Meta did not return impressions for this period',
  meta_link_clicks_missing: 'Meta did not return link clicks for this period',
  meta_purchase_canonical_action_missing: 'Meta reported no purchase action for this period',
  meta_purchase_canonical_pair_invalid: 'the purchase count and value disagree with each other',
  meta_lead_canonical_action_invalid: 'the Lead action Meta returned failed validation',
  meta_native_period_frequency_missing: 'Meta did not return frequency for this period',
  meta_native_period_all_days_query_failed: 'the whole-period Meta figures could not be read',
  meta_native_period_all_days_platform_unavailable: "the ad account's platform could not be read",
  meta_native_period_all_days_freshness_unavailable: 'we cannot tell how recent the whole-period figures are',
  meta_native_period_all_days_account_scope_invalid: 'the whole-period figures came back for the wrong account',
  meta_native_period_all_days_coverage_invalid: 'the whole-period figures do not cover the days requested',
  meta_native_period_all_days_window_mismatch: 'the whole-period figures cover a different period',
  partial_today_read_failed: "today's spend so far could not be read",
  partial_today_not_yet_available: 'Meta has not reported any spend for today yet',
  partial_today_duplicate_rows: 'Meta returned more than one row for today',
  partial_today_row_invalid: "today's spend row failed validation",
  paid_cohort_unavailable: 'the paid measurement cohort is not available for this period',
  meta_daily_budget_unavailable: 'no active ad-set budget could be read for this account',
}

const BLOCKER_LABELS: Record<string, string> = {
  ...PAID_COHORT_LABELS,
  ...CREATIVE_ASSIGNMENT_LABELS,
  ...UNTYPED_LABELS,
  ...TREND_LABELS,
  ...COCKPIT_CELL_LABELS,
}

/** Meta outcome-plane blockers. These are structured rather than enumerable: the code carries the
 *  reporting level and, for most reasons, the date it applies to —
 *  `meta_outcome_<level>_<reason>[:YYYY-MM-DD]`. They reach the owner through the decision-gate panel,
 *  where the level and date are the whole point ("which day is missing money, at which level"), so they
 *  are parsed rather than matched against a flat table. */
const META_OUTCOME_LEVELS: Record<string, string> = {
  campaign: 'campaign',
  adset: 'ad set',
  ad: 'ad',
}

const META_OUTCOME_REASONS: Record<string, string> = {
  value_unavailable: `Meta reported ${withIndefiniteArticle(OW.one)} but no ${OW.one} value`,
  value_mismatch: `${OW.one} value disagrees between reporting levels`,
  leads_mismatch: 'lead counts disagree between reporting levels',
  bookings_mismatch: `${OW.one} counts disagree between reporting levels`,
  click_bookings_mismatch: `click-attributed ${OW.many} disagree between reporting levels`,
  view_bookings_mismatch: `view-attributed ${OW.many} disagree between reporting levels`,
  attribution_split_unavailable: `Meta reported ${OW.many} without the click/view breakdown`,
  payload_invalid: 'Meta returned figures that failed validation',
  source_unavailable: 'Meta returned nothing at this reporting level',
  account_rollup_failed: 'account totals could not be reconciled from campaign rows',
  appointment_results_unavailable: `campaign rows omit the ${OW.many} the lower levels report`,
  leads_unavailable: 'campaign rows omit the leads the lower levels report',
}

function metaOutcomeLabel(code: string): string | null {
  const [body, date] = code.split(':')
  if (!body.startsWith('meta_outcome_')) return null
  const rest = body.slice('meta_outcome_'.length)
  const level = Object.keys(META_OUTCOME_LEVELS).find((l) => rest.startsWith(`${l}_`))
  if (!level) return null
  const reason = META_OUTCOME_REASONS[rest.slice(level.length + 1)]
  if (!reason) return null
  return `${reason} (${META_OUTCOME_LEVELS[level]} level${date ? `, ${date}` : ''})`
}

/** Human label for one blocker code. Unmapped codes degrade to spaced words, never to a bare token. */
export function blockerLabel(code: string): string {
  const exact = BLOCKER_LABELS[code] ?? metaOutcomeLabel(code)
  if (exact !== undefined && exact !== null) return exact
  // A CODE MAY CARRY A DATE. `source-readers.ts` emits `meta_account_spend_day_missing:2026-08-04`,
  // one per missing day, and an exact-match table never sees it — so the owner read the raw code
  // with a timestamp welded on. Look the family up and keep the date as a readable suffix.
  const separator = code.indexOf(':')
  if (separator > 0) {
    const family = BLOCKER_LABELS[code.slice(0, separator)]
    if (family) return `${family} (${code.slice(separator + 1)})`
  }
  return code.replaceAll('_', ' ')
}

/** Sentence-cased, comma-joined labels for a list of codes. Empty list returns null so callers can
 *  distinguish "no blockers" from "blockers we could not name". */
export function blockerLabels(codes: readonly string[]): string | null {
  if (codes.length === 0) return null
  const joined = codes.map(blockerLabel).join('; ')
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** The paid cohort a direction was computed over. `recent_scale` / `matured_cut` are internal names. */
export function cohortKindLabel(kind: string): string {
  if (kind === 'recent_scale') return 'Recent paid cohort'
  if (kind === 'matured_cut') return 'Matured paid cohort'
  return kind.replaceAll('_', ' ')
}

/**
 * `measurementKind` in the owner's words.
 *
 * The cockpit rendered `Meta · ${claim.measurementKind}` under every available cell, printing the raw
 * contract axis — `measured`, `derived` — to the one person who reads this page. It survived every
 * review because it is a hand-written template rather than a code passing through a table, which is
 * exactly the gap this file closes for blockers.
 *
 * TOTAL over `MEASUREMENT_KINDS`, enforced by `blocker-labels-trend.test.ts`. A kind added to the
 * contract without a label fails the suite instead of reaching the dashboard as an enum.
 */
const MEASUREMENT_KIND_LABELS: Record<string, string> = {
  measured: 'Straight from Meta Ads Manager',
  modelled: "Meta's own estimate, not a counted fact",
  derived: 'Calculated here from Meta figures',
  operational: 'From how this system is configured',
  telemetry: 'From this system’s own logs',
  associated_noncausal: 'Observed alongside — not shown to be the cause',
  causal_estimate: 'Estimated cause, from a controlled comparison',
}

export function measurementKindLabel(kind: string): string {
  return MEASUREMENT_KIND_LABELS[kind] ?? kind.replaceAll('_', ' ')
}
