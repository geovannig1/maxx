import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { OperatingModeResult } from './operating-mode'
import type { LaunchCohortVerdict } from './launch-cohort'
import { formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Launch-readiness output for pre-launch / low-data mode.
//
// When the account is dormant or below the data bar, the right deliverable is NOT a performance
// diagnosis (there's nothing to diagnose) — it's a readiness checklist. This builds that structured
// output: what to verify, what to plan, what data is needed before any decision, and what NOT to
// change yet. It is deliberately data-light and never makes performance claims.

export interface LaunchReadinessInput {
  mode: OperatingModeResult
  today: string // nyToday()
  /** Optional live signals to make the checklist concrete; all optional. */
  trackingHealthy?: boolean | null // from checkTrackingHealth
  attributedShare?: number | null // from getGa4ConfirmationTelemetryByCampaign
  activeAdSets?: number
  perAdSetDailyBudget?: number | null
  utmCoverage?: number | null // share of active ads with correct UTMs (0..1), from computeUtmCoverage
  /** Cohort-scoped verdict (launch-cohort.ts): launch blockers vs historical cleanup, scoped to the
   *  new cohort actually going live — so old paused/replaced ad sets never read as launch blockers. */
  cohortVerdict?: LaunchCohortVerdict | null
}

export interface LaunchReadinessReport {
  mode_label: string
  headline: string
  tracking_readiness: string[]
  campaign_structure_check: string[]
  audience_test_plan: string[]
  creative_test_plan: string[]
  budget_learning_plan: string[]
  landing_booking_checks: string[]
  data_needed_before_decisions: string[]
  do_not_change_yet: string[]
  /** Cohort-scoped launch blockers (empty when no cohort verdict supplied). */
  launch_blockers: string[]
  /** Old paused/replaced items — informational, never launch blockers. */
  historical_cleanup: string[]
  /** Cohort readiness — null when no cohort verdict was supplied. */
  ready: boolean | null
  next_review_date: string
  markdown: string
}

function addDaysStr(today: string, n: number): string {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function buildLaunchReadinessReport(input: LaunchReadinessInput): LaunchReadinessReport {
  const { mode, today } = input

  const tracking_readiness: string[] = [
    input.trackingHealthy === false
      ? 'FIX: tracking health check is failing — resolve before spending (pixel/CAPI/GA4).'
      : input.trackingHealthy === true
        ? 'Tracking health check passing.'
        : 'Verify the event inventory and delivery health for whichever outcome event the approved CampaignPlan selects; no event is selected yet.',
    input.utmCoverage != null && input.utmCoverage < 1
      ? `OBSERVED: only ${(input.utmCoverage * 100).toFixed(0)}% of active ads carry the legacy readable UTM set. Treat this as a tracking defect, not a launch-setting prescription.`
      : 'Verify the approved CampaignPlan selects a versioned tracking contract with immutable Meta IDs plus readable names; legacy UTM presence alone is insufficient.',
    'Confirm the outcome ledger is syncing (webhook + nightly reconcile), accepted server deliveries are stamped, and the daily GA telemetry fetch succeeds.',
  ]

  const campaign_structure_check: string[] = [
    'BLOCKED: no approved CampaignPlan was evaluated. Do not prescribe an objective, event, page, audience, budget, or CTA from this context-free checklist.',
    'Choose Awareness, Leads, or Sales from the declared business outcome, conversion location, page journey, event volume, follow-up capacity, and economics — never from audience temperature alone.',
    `The account currently has ${input.activeAdSets ?? 'an unknown number of'} active ad set(s). Treat fragmentation and learning as diagnostics until the exact plan and expected event volume are known.`,
  ]

  const audience_test_plan: string[] = [
    `Cold is not automatically Awareness or direct ${OW.one}. Record the intended journey and outcome in an approved CampaignPlan before proposing targeting.`,
    'A strict Warm plan may use verified first-party visitors/engagers and must exclude converters; lookalikes or audience expansion make it mixed/prospecting and require different labelling and copy.',
    'Block every failed or unknown audience. A lookalike requires live delivery status and a verified source above Meta\'s eligibility minimum; 1,000–5,000 high-value customers is a preferred source-quality range, not a universal hard launch threshold.',
    'A prospecting plan must exclude every approved warm pool, including website visitors, engagers, and recent converters. Partial exclusions do not create a clean Cold cohort.',
    `Keep existing customers isolated in reporting. Exclude them from acquisition delivery only when the approved plan is explicitly new-customer acquisition and a separate retention path preserves repeat ${OW.many}.`,
    'Require fresh audience subtype, size, operation status, logical overlap, exclusions, expansion, geo, and provenance before launch readiness can pass.',
  ]

  const creative_test_plan: string[] = [
    'Block video-only launches and require at least three genuinely distinct concepts across at least two placement-compatible formats; cosmetic variants of one studio tour count as one concept.',
    'Require at least one fresh concept and disclose every recycled asset. Re-created ad IDs do not make old media new.',
    'Hook, offer, CTA, claims, and destination must match the approved audience stage and landing-page snapshot; Book Now is not a universal CTA.',
    'Use only owner-approved claims with recorded provenance from the governed business/page context. Unsupported scarcity, capacity, reviews, amenities, price, or availability block the plan.',
  ]

  const budget_learning_plan: string[] = [
    `Meta's ~${REC_THRESHOLDS.LEARNING_EXIT_EVENTS_PER_WEEK} optimization events/ad set/week threshold is a delivery diagnostic, not permission to invent a budget or choose a weaker event.`,
    `Capacity has no owner-declared ceiling. Monitor schedule availability for operations, but never use it to cap the ${OW.one} or revenue objective.`,
    'Record owner spend ceiling, contribution economics, expected event cost/volume, audience size, and number of decision units before proposing a budget.',
    `If the deepest event is structurally too sparse, design and label a truthful lead/consideration bridge. Do not re-label LPV/video traffic as ${OW.one} performance.`,
  ]

  const landing_booking_checks: string[] = [
    'Require an approved landing-page snapshot with URL/hash, purpose, supported funnel stages, offer, CTA, owner-approved claims with provenance, mobile/runtime evidence, and tracking inventory.',
    'An audience test must keep the destination, creative, budget, and optimization settings constant. If Cold and Warm use different destinations, the result is not an audience-only comparison.',
    `For ${withIndefiniteArticle(OW.one)} journey, prove ad → landing page → the outcome source preserves the paid touch and ${OW.one} identity through the actual embedded/cross-domain flow.`,
    'For any browser/server event pair selected by the plan, prove accepted delivery and deduplication on one event_id.',
    'Do not infer paid performance from an unattributed business outcome or from telemetry without the exact first-party join.',
  ]

  const data_needed_before_decisions: string[] = [
    `The approved CampaignPlan must declare its primary metric, maturity lag, minimum sample, review rule, and stop rule. ${OW.One} thresholds do not apply to Awareness or Lead plans.`,
    `Existing global minimums (${formatMoneyAmount(REC_THRESHOLDS.MIN_SPEND_TO_JUDGE)} spend / ${REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL} days) are analysis safeguards only, not launch-setting authority.`,
    `Campaign-tagged event share ≥ ${(REC_THRESHOLDS.MIN_ATTRIBUTED_SHARE * 100).toFixed(0)}% is a telemetry-health check (currently ${input.attributedShare == null ? 'unknown' : (input.attributedShare * 100).toFixed(0) + '%'}); it never unlocks ROAS without complete exact identity, mapping, and authoritative spend.`,
  ]

  const do_not_change_yet: string[] = [
    'Do NOT prescribe or change the objective, optimization event, landing page, audience, CTA, or budget until one approved CampaignPlan evaluates them together.',
    'Do NOT pause or scale based on a day or two of data.',
    'Do NOT trust per-campaign ROAS until attribution coverage is fixed.',
    'Do NOT enable write mode — it stays OFF until proven.',
  ]

  const next_review_date = addDaysStr(today, 7)

  // Cohort-scoped verdict (launch-cohort.ts): blockers come only from the launch cohort; old paused/
  // replaced assets are historical cleanup, never launch blockers.
  const launch_blockers = input.cohortVerdict?.blockers ?? []
  const historical_cleanup = input.cohortVerdict?.historical_cleanup ?? []
  const ready = input.cohortVerdict ? input.cohortVerdict.ready : null
  const cohortNames = input.cohortVerdict?.launch_cohort ?? []

  const headline = `${mode.dataMode === 'pre_launch' ? 'Account is pre-launch / dormant' : 'Account is below the data bar'} — this is a LAUNCH-READINESS plan, not a performance review. ${mode.reason}`

  const section = (title: string, items: string[]) => `### ${title}\n${items.map((i) => `- ${i}`).join('\n')}`
  const verdictLine = input.cohortVerdict
    ? `**Launch verdict** (cohort: ${cohortNames.join(', ') || 'unbound'}): ${ready === true ? '✅ ready' : ready === false ? `⛔ ${launch_blockers.length} confirmed blocker(s)` : '⚠️ UNVERIFIED — CAMPAIGN_PLAN_REQUIRED'}`
    : ''
  const markdown = [
    `## Launch-Readiness Report (${mode.label})`,
    `_${headline}_`,
    verdictLine,
    launch_blockers.length ? section('⛔ Launch blockers (fix before launch)', launch_blockers) : '',
    historical_cleanup.length ? section('Historical cleanup (NOT launch blockers)', historical_cleanup) : '',
    section('Tracking readiness', tracking_readiness),
    section('Campaign structure check', campaign_structure_check),
    section('Audience test plan', audience_test_plan),
    section('Creative test plan', creative_test_plan),
    section('Budget & learning plan', budget_learning_plan),
    section(`Landing page / ${OW.one} flow checks`, landing_booking_checks),
    section('Data needed before decisions', data_needed_before_decisions),
    section('What NOT to change yet', do_not_change_yet),
    `\n**Next review:** ${next_review_date}`,
  ].filter(Boolean).join('\n\n')

  return {
    mode_label: mode.label,
    headline,
    tracking_readiness,
    campaign_structure_check,
    audience_test_plan,
    creative_test_plan,
    budget_learning_plan,
    landing_booking_checks,
    data_needed_before_decisions,
    do_not_change_yet,
    launch_blockers,
    historical_cleanup,
    ready,
    next_review_date,
    markdown,
  }
}
