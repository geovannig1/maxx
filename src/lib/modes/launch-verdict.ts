import type { LaunchCohortVerdict } from './launch-cohort'
import type { AdUtmHealth } from '@/lib/tracking/utm-coverage'
import type { GovernedPlanningContext } from '@/lib/planning-context/resolver'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// The single structured launch-readiness verdict (audit stabilization). PURE: it synthesizes already-
// computed facts (cohort assessment + cohort-scoped UTM verdicts + tracking status) into the mandated
// answer shape, and NEVER states a confident claim it can't prove — anything unprovable lands in
// `unverified`, and `ready` is null (not false) when the only thing stopping it is unverified evidence.

export interface LaunchReadinessVerdict {
  evaluated_cohort: string[]
  source_of_truth: string[]
  confirmed: string[]
  unverified: string[]
  blockers: string[] // true, confirmed launch blockers only
  historical_cleanup: string[] // old/replaced — never blockers
  before_launch: string[] // should-fix, non-blocking
  after_launch: string[]
  ready: boolean | null // true = go; false = a confirmed blocker; null = can't confirm (unverified)
}

export interface TrackingSummary {
  status: 'healthy' | 'warning' | 'critical' | 'unverified'
  dormant: boolean
  issues: string[]
}

export function buildLaunchVerdict(input: {
  cohort: LaunchCohortVerdict
  utmAds: AdUtmHealth[] // the launch cohort's ads only (already scoped)
  utmCoverageScope: string
  tracking?: TrackingSummary | null
  planningContext?: GovernedPlanningContext | null
}): LaunchReadinessVerdict {
  const { cohort, utmAds, tracking, planningContext } = input
  const confirmed: string[] = []
  const unverified: string[] = []
  const blockers: string[] = []
  const before_launch: string[] = []
  const after_launch: string[] = []

  // ── Page-aware CampaignPlan ──────────────────────────────────────────────────────────────────
  // The legacy gate below can prove only that an existing Meta cohort has a conversion goal, UTMs,
  // and a firing event. It cannot prove that the audience, offer, page, CTA, creative, objective,
  // economics, and measurement form a coherent campaign. No approved plan therefore means
  // UNVERIFIED, never ready=true.
  unverified.push('CAMPAIGN_PLAN_REQUIRED — no immutable, account-scoped CampaignPlan revision was loaded. Business context, audience stage, page purpose, offer, CTA, creative concepts, economics, measurement, and exact cohort binding remain unverified.')

  if (!planningContext) {
    unverified.push('CAMPAIGN_CONTEXT_NOT_EVALUATED — governed business and exact landing-page context were not loaded by this caller.')
  } else if (!planningContext.context_available_for_campaign_plan) {
    unverified.push(`CAMPAIGN_CONTEXT_REQUIRED — governed planning context is blocked: ${planningContext.blocker_codes.join(', ') || 'unspecified_context_failure'}. No campaign settings may be proposed.`)
  } else {
    confirmed.push(`Approved business context ${planningContext.business_context.version_id} (approval ${planningContext.business_context.approval_id}) is available for CampaignPlan input.`)
    confirmed.push(`Approved landing-page snapshot ${planningContext.landing_page.snapshot_id} for ${planningContext.landing_page.canonical_url} is available for CampaignPlan input.`)
  }

  // ── Optimization event (from the cohort assessment) ──
  unverified.push(...cohort.unverified)
  blockers.push(...cohort.blockers)

  // ── UTMs (from the cohort-scoped coverage — the effective destination, not one field) ──
  const missing = utmAds.filter((a) => a.verdict === 'missing')
  const misconfigured = utmAds.filter((a) => a.verdict === 'misconfigured')
  const unread = utmAds.filter((a) => a.verdict === 'unverified')
  const correct = utmAds.filter((a) => a.verdict === 'correct')
  if (correct.length) confirmed.push(`Observed readable UTMs on ${correct.length} ad(s) — GA can classify campaign-session telemetry as paid Meta. This does not prove the future plan's ID-inclusive tracking contract.`)
  if (misconfigured.length) {
    // Present but not fully canonical (e.g. hardcoded utm_campaign). If utm_source/utm_medium are set,
    // Channel classification may work while campaign naming is degraded. Neither is paid-outcome proof.
    confirmed.push(`Observed readable source/medium UTMs on ${misconfigured.length} ad(s) — paid-channel telemetry can populate, but campaign naming is degraded.`)
    unverified.push(`The approved CampaignPlan has not selected an ID-inclusive tracking contract, so the observed non-canonical UTM defects are diagnostic only: ${misconfigured[0].defects[0]?.detail ?? 'non-canonical params'}`)
  }
  if (unread.length) unverified.push(`UTMs could not be read from the sync for ${unread.length} launch ad(s) — re-sync or verify in Ads Manager. NOT evidence they're missing.`)
  if (missing.length) unverified.push(`${missing.length} observed ad(s) carry no readable UTMs. This is a tracking defect, but the exact parameters must come from the approved CampaignPlan and versioned ID-inclusive tracking contract.`)

  // ── AppointmentConfirmed / pixel ──
  if (tracking) {
    if (tracking.dormant || tracking.status === 'unverified') {
      unverified.push('AppointmentConfirmed: UNVERIFIED — the account is dormant or delivery health could not be proven from durable evidence. Re-check after traffic resumes.')
      after_launch.push('Re-verify AppointmentConfirmed fires once ads deliver — the dormancy check cannot confirm it pre-launch.')
    } else if (tracking.status === 'critical') {
      before_launch.push(`Observed AppointmentConfirmed delivery-health issue: ${tracking.issues[0] ?? 'no events despite active delivery'}. Its launch relevance is unverified until the CampaignPlan selects that event.`)
    } else if (tracking.status === 'healthy') {
      confirmed.push('AppointmentConfirmed firing (active delivery with events).')
    }
  } else {
    unverified.push('AppointmentConfirmed status was not evaluated in this call — treat as unverified.')
  }

  after_launch.push('Confirm GA4 session-campaign telemetry and appointment_id identity are both flowing. Campaign-tagged event share alone never unlocks paid ROAS; the complete exact ledger join and authoritative spend are also required.')

  const source_of_truth = [
    'Meta creative spec (synced): optimization goal + the effective destination UTMs, including the video CTA link.',
    `Outcome ledger = business ${OW.many}/booked value; GA4 = session-channel confirmation telemetry; Meta pixel/CAPI counts = modelled attribution and delivery signal.`,
    `UTM coverage scope: ${input.utmCoverageScope}.`,
    planningContext
      ? `Governed business/page context: ${planningContext.status}; ${planningContext.blocker_codes.join(', ') || 'approved inputs loaded'}.`
      : 'Governed business/page context: not evaluated.',
    'Campaign plan lineage: not evaluated; caller-provided plan summaries are not accepted as provenance.',
  ]

  // ready: a confirmed blocker ⇒ false; otherwise unprovable evidence ⇒ null; all clear ⇒ true.
  const ready: boolean | null = blockers.length > 0 ? false : unverified.length > 0 ? null : true

  return {
    evaluated_cohort: cohort.launch_cohort,
    source_of_truth,
    confirmed,
    unverified,
    blockers,
    historical_cleanup: cohort.historical_cleanup,
    before_launch,
    after_launch,
    ready,
  }
}
