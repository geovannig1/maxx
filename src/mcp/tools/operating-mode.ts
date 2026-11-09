import { roundMoney } from '@/lib/utils/format-currency'
import { getAdminClient } from '@/lib/supabase/admin'
import { getTargetRange } from '@/lib/targets/target-ranges'
import { hydrateTargetOverrides } from '@/lib/targets/store'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { resolveAccountObjective, type MetaDeliveryObjective } from '@/lib/modes/objective'
import { getGa4ConfirmationTelemetryBySource, getGa4ConfirmationTelemetryByCampaign, isMetaPaidChannel } from '@/lib/ga4/client'
import { buildGa4ReconciliationBlock, exactPaidEvidence } from '@/lib/ga4/booking-reconciliation'
import { getBusinessFactsForWindow } from '@/lib/outcomes/business-facts-reader'
import { getPerCampaignRoas } from '@/lib/analytics/campaign-roas'
import { computeUtmCoverage } from '@/lib/tracking/utm-coverage'
import {
  detectOperatingMode,
  type AuthorityBasis,
  type InteractionCohortPairSignal,
} from '@/lib/modes/operating-mode'
import { readActiveAdsetExitedLearning } from '@/lib/modes/learning-status'
import { buildLaunchReadinessReport } from '@/lib/modes/launch-readiness'
import { resolveLaunchReadiness } from '@/lib/modes/launch-readiness-service'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'
import {
  readLatestPaidCohortPair,
} from '@/lib/attribution/paid-cohort-store'
import type { ActionKind } from '@/lib/authority/action-authority'
import { toInteractionCohortPairSignal } from '@/lib/authority/paid-cohort-direction'
import { proveStructuralContinuity } from '@/lib/modes/structural-continuity'
import {
  buildPragmaticProfitInputFromCohortPair,
  computeActiveAccountDailyBudget,
  readMediaBuyerRecommendationsEnabled,
} from '@/lib/economics/pragmatic-profit-evidence'
import { outcomeWords } from '@/config/outcome-nouns'
import { metaOutcomeEventName } from '@/config/business-config'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()
export { MATERIAL_SETTING_CATEGORIES, proveStructuralContinuity } from '@/lib/modes/structural-continuity'

// MCP tool: tells the agent which OPERATING MODE the account is in right now (pre-launch / low-data /
// active-learning / sufficient) and what it is therefore allowed to claim/do. In low-data mode it also
// returns a structured launch-readiness plan so the agent produces a launch plan, not a fake diagnosis.


function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

export function countCurrentlyActiveDeliveringAds(
  insightRows: Array<{ meta_ad_id?: unknown; spend?: unknown }>,
  adRows: Array<{ ad_id?: unknown; effective_status?: unknown }>,
): number {
  const activeAdIds = new Set(
    adRows
      .filter((row) => row.effective_status === 'ACTIVE' && typeof row.ad_id === 'string')
      .map((row) => row.ad_id as string),
  )
  const deliveringAdIds = new Set(
    insightRows
      .filter((row) => Number(row.spend ?? 0) > 0 && typeof row.meta_ad_id === 'string')
      .map((row) => row.meta_ad_id as string),
  )
  return [...deliveringAdIds].filter((adId) => activeAdIds.has(adId)).length
}

function unavailableOperatingMode(errorCode: string, error: string): object {
  return {
    status: 'unavailable',
    error_code: errorCode,
    error,
    mode: null,
    authority_basis: 'unavailable',
    scale_authority_basis: 'unavailable',
    cut_authority_basis: 'unavailable',
    signals: null,
    launch_verdict: null,
    launch_readiness: null,
    note: 'Operating mode was not evaluated. Unavailable evidence is not a healthy empty, low-data, or pre-launch account.',
  }
}

/**
 * The account's current {@link AuthorityBasis}, for surfaces that must answer to the same authority
 * question without recomputing the whole mode. Fails CLOSED to `calendar_period_signal` — the tier for
 * a money action is identical either way, since a candidate must itself be on the interaction_cohort
 * plane to qualify, so a failure here can never widen authority.
 */
export async function getOperatingModeSignalsBasis(kind: ActionKind = 'observe'): Promise<AuthorityBasis> {
  try {
    const mode = (await getOperatingMode()) as {
      authority_basis?: AuthorityBasis
      scale_authority_basis?: AuthorityBasis
      cut_authority_basis?: AuthorityBasis
    }
    if (kind === 'budget_scale' || kind === 'activate') {
      return mode.scale_authority_basis ?? 'unavailable'
    }
    if (kind === 'budget_cut' || kind === 'pause') {
      return mode.cut_authority_basis ?? 'unavailable'
    }
    return mode.authority_basis ?? 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export async function getOperatingMode(): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return unavailableOperatingMode(
      activeAccountErrorCode(activeAccount.reason),
      activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured; operating mode is unavailable.'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account is configured; operating mode is unavailable.'
          : 'The active ad account could not be resolved; operating mode is unavailable.',
    )
  }
  const activeAcct = activeAccount.account.id

  // The decision window must end on a closed day the account warehouse actually contains. Calendar
  // yesterday can be one or more days ahead of the latest completed sync, while an explicit manual
  // sync can write a partial row for today. Either would make the outcome-source and delivery boundaries
  // disagree, so cap the warehouse read at yesterday and use its newest eligible day.
  const end = await readLatestClosedAccountDeliveryDate(activeAcct, db)
  if (end === null) {
    return unavailableOperatingMode(
      'OPERATING_MODE_DELIVERY_UNAVAILABLE',
      'The latest closed account delivery day could not be read; operating mode is unavailable.',
    )
  }
  const startDate = new Date(`${end}T00:00:00Z`)
  startDate.setUTCDate(startDate.getUTCDate() - 29)
  const start = startDate.toISOString().slice(0, 10)

  // getTargetRange() reads a PROCESS-LOCAL map. A cold MCP/Vercel process evaluated with
  // the built-in defaults even when the owner had persisted an override, and the dashboard's client
  // provider hydrates in useEffect — after server data was computed, so it cannot repair this.
  // Every authoritative entry point must load the saved overrides before reading a target.
  const targetPolicy = await hydrateTargetOverrides()
  let interactionCohorts: InteractionCohortPairSignal | null
  try {
    interactionCohorts = toInteractionCohortPairSignal(await readLatestPaidCohortPair(db, activeAcct, {
      entityLevel: 'account',
      entityId: activeAccount.account.accountId,
    }))
  } catch {
    return unavailableOperatingMode(
      'OPERATING_MODE_COHORT_UNAVAILABLE',
      'The committed paid interaction cohort could not be read; operating mode is unavailable.',
    )
  }

  const mediaBuyerRecommendationsEnabled = await readMediaBuyerRecommendationsEnabled(db, activeAcct)
  let pragmaticProfit: NonNullable<Parameters<typeof detectOperatingMode>[0]['profit']> | null = null
  if (mediaBuyerRecommendationsEnabled && interactionCohorts) {
    const currentAccountDailyBudget = await computeActiveAccountDailyBudget(db, activeAcct)
    pragmaticProfit = buildPragmaticProfitInputFromCohortPair(interactionCohorts, currentAccountDailyBudget)
  }

  let spend30d = 0
  let metaBookings30d = 0
  let lastDelivery: string | null = null
  // These ran BEFORE the active account was resolved and omitted
  // ad_account_id, while the exact paid outcomes below are account-scoped. An inactive, replaced or
  // test account in the same database would therefore contaminate spend, modelled bookings and
  // active-delivery state — inflating the mode's denominator against a correctly scoped numerator.
  // The account is resolved first now, and every read below is scoped to it. A failed read is not a
  // zero-spend/zero-booking account and must never be allowed to manufacture pre-launch mode.
  const scopedInsights = await db
    .from('daily_insights')
    .select('date_start, spend, bookings')
    .eq('ad_account_id', activeAcct)
    .eq('entity_level', 'account')
    .gte('date_start', start)
    .lte('date_start', end)
  if (scopedInsights.error) {
    return unavailableOperatingMode('OPERATING_MODE_DELIVERY_UNAVAILABLE', 'Account delivery evidence could not be read; operating mode is unavailable.')
  }
  const rows = scopedInsights.data
  for (const r of rows ?? []) {
    spend30d += Number(r.spend ?? 0)
    metaBookings30d += Number(r.bookings ?? 0)
    if (Number(r.spend ?? 0) > 0) {
      const d = r.date_start as string
      if (!lastDelivery || d > lastDelivery) lastDelivery = d
    }
  }
  const daysSinceLastDelivery = lastDelivery
    ? Math.round((new Date(end + 'T00:00:00Z').getTime() - new Date(lastDelivery + 'T00:00:00Z').getTime()) / 86_400_000)
    : null

  // This passed GA CONFIRMATION EVENTS as bookings30d, so duplicate, canceled and
  // identity-less events could promote the account from low-data into an active-learning or
  // sufficient-data mode — which is what unlocks performance and budget recommendations. That is a
  // DECISION input, not a label. The mode signal now uses LEDGER value-bearing bookings (business
  // truth), and falls back to Meta's modelled count only when the ledger cannot be read. GA telemetry
  // never feeds it.
  let ga4Available = false
  let ga4PaidConfirmationEvents = 0
  let ga4OrganicBookings = 0
  let attributedShare: number | null = null
  try {
    const ga = await getGa4ConfirmationTelemetryBySource(start, end)
    // CONFIRMATION EVENTS, not bookings — no appointment identity. Surfaced as telemetry only, and
    // NEVER passed to detectOperatingMode.
    if (ga.available) { ga4Available = true; ga4PaidConfirmationEvents = ga.paid.confirmationEvents; ga4OrganicBookings = ga.organic.confirmationEvents }
  } catch { /* GA4 optional */ }
  try {
    const gc = await getGa4ConfirmationTelemetryByCampaign(start, end)
    if (gc.available) attributedShare = gc.attributedShare
  } catch { /* GA4 optional */ }

  let activeAdsDelivering = 0
  try {
    // Account-scoped for the same reason as the totals above: another account's delivering ads must
    // not report as this account's active delivery. Intersect recent spend with the CURRENT active
    // inventory so replaced or paused ads do not inflate this signal. Derive the seven-day window
    // from the same closed-through day as every other decision input; a calendar-relative start can
    // silently shorten the window whenever the warehouse is more than one day behind.
    const activeDeliveryStartDate = new Date(`${end}T00:00:00Z`)
    activeDeliveryStartDate.setUTCDate(activeDeliveryStartDate.getUTCDate() - 6)
    const activeDeliveryStart = activeDeliveryStartDate.toISOString().slice(0, 10)
    const [deliveryResult, activeAdsResult] = await Promise.all([
      db
        .from('daily_insights')
        .select('meta_ad_id, spend')
        .eq('ad_account_id', activeAcct)
        .eq('entity_level', 'ad')
        .gte('date_start', activeDeliveryStart)
        .lte('date_start', end),
      db
        .from('ads')
        .select('ad_id, effective_status')
        .eq('ad_account_id', activeAcct)
        .eq('effective_status', 'ACTIVE'),
    ])
    if (deliveryResult.error) throw new Error(deliveryResult.error.message)
    if (activeAdsResult.error) throw new Error(activeAdsResult.error.message)
    activeAdsDelivering = countCurrentlyActiveDeliveringAds(
      deliveryResult.data ?? [],
      activeAdsResult.data ?? [],
    )
  } catch {
    return unavailableOperatingMode('OPERATING_MODE_DELIVERY_UNAVAILABLE', 'Active delivery evidence could not be read; operating mode is unavailable.')
  }

  // THREE separate signals, never interchangeable:
  //   businessBookings30d  — total ledger volume, CONTEXT ONLY (includes organic/phone/manual)
  //   exactPaidBookings30d — PROVEN paid outcomes; the only thing that may unlock budget authority
  //   metaModelledBookings30d — platform delivery/learning context
  let ledgerValueBearing30d: number | null = null
  let exactPaid30d: number | null = null
  // Per-CAMPAIGN authority needs per-CAMPAIGN completeness and an authoritative denominator — the
  // campaign panel already withholds ROAS without them, and the brain must agree with the panel.
  let accountObjective: MetaDeliveryObjective = 'unknown'   // fail closed until resolved from synced data
  let campaignMappingComplete: boolean | null = null
  let campaignSpendComplete: boolean | null = null
  let authoritativeSpendBasis: boolean | null = null
  let laggedPeriod: NonNullable<Parameters<typeof detectOperatingMode>[0]['laggedPeriod']> | null = null
  let postPeriod: NonNullable<Parameters<typeof detectOperatingMode>[0]['postPeriod']> | null = null
  let structuralContinuity: boolean | null = null
  try {
    const acct = activeAcct
    accountObjective = await resolveAccountObjective(acct)
    ledgerValueBearing30d = (await getBusinessFactsForWindow(acct, start, end)).valueBearingBookings
    const { reconciliation } = await buildGa4ReconciliationBlock(acct, start, end)
    exactPaid30d = exactPaidEvidence(reconciliation, isMetaPaidChannel)?.valueBearingBookings ?? null
    // This assigned 30 from IDENTITY COMPLETENESS, which is a different property from
    // conversion MATURITY. A trailing 30-day window can be identity-complete while yesterday's spend
    // has had one day to convert. Maturity is measured from the window's END: how many days of the
    // window have had the full assumed lag to produce a booking.
    //
    // The lag itself is NOT proven. The previously cited ~7-day figure is appointment-created ->
    // appointment-date, which says nothing about ad-click -> booking. MIN_MATURED_DAYS_FOR_CUT is
    // therefore a declared PROVISIONAL assumption, not a measurement, and is labelled as one.
    // A LAGGED HISTORICAL PERIOD — one input to cut authority, never proof on its own.
    //
    // The LAG stays 14 days (an unmeasured assumption should not be shortened for speed). The
    // PERIOD is 14 days, per the reviewer's recommendation: a rolling 14-day period ending 14 days
    // ago is more responsive than 30 while keeping the same lag. Note the inclusive arithmetic —
    // end−27..end−14 is 14 days, not 15; the previous 44..14 was 31 days, not 30. Anchor
    // both decision slices to the proven warehouse close, never the calendar.
    const LAG = REC_THRESHOLDS.MIN_MATURED_DAYS_FOR_CUT
    const PERIOD = REC_THRESHOLDS.LAGGED_PERIOD_DAYS
    const cutEnd = daysBefore(end, LAG)
    const cutStart = daysBefore(end, LAG + PERIOD - 1)
    const cutRecon = await buildGa4ReconciliationBlock(acct, cutStart, cutEnd)
    const cutExact = exactPaidEvidence(cutRecon.reconciliation, isMetaPaidChannel)
    let cutSpend = 0
    try {
      const { data: cutRows, error: cutErr } = await db
        .from('daily_insights').select('spend')
        .eq('ad_account_id', acct).eq('entity_level', 'account')
        .gte('date_start', cutStart).lte('date_start', cutEnd)
      if (cutErr) throw new Error(cutErr.message)
      cutSpend = (cutRows ?? []).reduce((n, r) => n + Number(r.spend ?? 0), 0)
    } catch {
      return unavailableOperatingMode('OPERATING_MODE_EVIDENCE_UNAVAILABLE', 'Lagged spend evidence could not be read; operating mode is unavailable.')
    }
    const daysSince = (d: string) =>
      Math.max(0, Math.floor((Date.now() - new Date(d + 'T00:00:00Z').getTime()) / 86_400_000))
    laggedPeriod = {
      spend: cutSpend,
      exactPaidBookings: cutExact?.valueBearingBookings ?? null,
      daysSinceEnd: daysSince(cutEnd),
      start: cutStart, end: cutEnd,
    }

    // NON-OVERLAPPING corroboration slice: the day AFTER the lagged period ends, through the end of
    // the reporting window. Corroboration used to come from `start..end` (the trailing 30
    // days), which CONTAINS the lagged period entirely — the same spend and outcomes were counted as
    // both the loss and its confirmation. These dates share none with cutStart..cutEnd.
    const postStart = daysBefore(end, LAG - 1)
    const postEnd = end
    if (postStart <= postEnd) {
      const postRecon = await buildGa4ReconciliationBlock(acct, postStart, postEnd)
      const postExact = exactPaidEvidence(postRecon.reconciliation, isMetaPaidChannel)
      let postSpend = 0
      try {
        const { data: postRows, error: postErr } = await db
          .from('daily_insights').select('spend')
          .eq('ad_account_id', acct).eq('entity_level', 'account')
          .gte('date_start', postStart).lte('date_start', postEnd)
        if (postErr) throw new Error(postErr.message)
        postSpend = (postRows ?? []).reduce((n, r) => n + Number(r.spend ?? 0), 0)
      } catch {
        return unavailableOperatingMode('OPERATING_MODE_EVIDENCE_UNAVAILABLE', 'Corroborating spend evidence could not be read; operating mode is unavailable.')
      }
      postPeriod = {
        spend: postSpend,
        exactPaidBookings: postExact?.valueBearingBookings ?? null,
        daysSinceEnd: daysSince(postEnd),
        start: postStart, end: postEnd,
      }
    }

    // STRUCTURAL CONTINUITY: has the setup materially changed since the historical period BEGAN?
    // A recovered setup must not be cut for its predecessor's performance.
    //
    // A review demolished the previous implementation, which asked ad_setup_decisions for rows and
    // read an empty result as proof of continuity. Three defects, all fatal:
    //   1. `setting_category = 'targeting'` is not in the vocabulary at all (034 defines audience |
    //      geo | age_gender | placements | advantage_plus | retargeting | exclusions). The column
    //      has NO check constraint, so the typo matched zero rows silently and forever.
    //   2. ad_setup_decisions is an INTENT / manual-entry ledger. A change made in Ads Manager and
    //      never written down is invisible to it. Absence of a logged row is not absence of change.
    //   3. The filter started at cutEnd, so a change made DURING the period was ignored — although
    //      that is precisely the case that makes the period a mixture of two configurations.
    //
    // Continuity is now proven from SYNCED META STATE — Meta's own timestamps for when each entity
    // was last modified, plus the ad-set significant-edit marker that resets the learning phase —
    // over cutStart..now, together with executed write-mode actions. Evidence that is missing or
    // stale yields NULL (unknown), never `true`.
    // Both evaluated periods are supplied: the cohort is every ad that spent in EITHER, and the
    // proof runs from the earliest period start through now.
    structuralContinuity = await proveStructuralContinuity(db, acct, [
      { start: cutStart, end: cutEnd },
      ...(postPeriod ? [{ start: postPeriod.start, end: postPeriod.end }] : []),
    ])
    const roas = await getPerCampaignRoas(acct, start, end)
    campaignMappingComplete = roas.campaign_mapping_complete
    // BOTH must hold: an authoritative ACCOUNT row does not prove each CAMPAIGN denominator is
    // whole. Passing only the basis let the brain authorise per-campaign ROAS while the panel
    // correctly reported every ratio unavailable.
    authoritativeSpendBasis = roas.spend_basis === 'account_level_insights'
    campaignSpendComplete = roas.campaign_spend_complete
  } catch {
    return unavailableOperatingMode('OPERATING_MODE_EVIDENCE_UNAVAILABLE', 'Business or attribution evidence could not be read; operating mode is unavailable.')
  }

  const learningRead = await readActiveAdsetExitedLearning(activeAcct)
  if (learningRead.status === 'unavailable') {
    return unavailableOperatingMode('OPERATING_MODE_LEARNING_STATUS_UNAVAILABLE', 'Ad-set learning status could not be read; operating mode is unavailable.')
  }

  const mode = detectOperatingMode({
    postPeriod,
    interactionCohorts,
    spend30d,
    businessBookings30d: ledgerValueBearing30d,
    exactPaidBookings30d: exactPaid30d,
    metaModelledBookings30d: metaBookings30d,
    campaignMappingComplete: campaignMappingComplete,
    campaignSpendComplete: campaignSpendComplete,
    authoritativeSpendBasis: authoritativeSpendBasis,
    laggedPeriod,
    structuralContinuity,
    profit: pragmaticProfit,
    // This is Meta's delivery-objective context only. It never changes Maxx's commercial objective;
    // booking CPA remains diagnostic even when the campaign asks Meta to optimize for conversions.
    // EFFECTIVE targets, read at evaluation time so a Performance-Targets override actually applies.
    targetCpa: getTargetRange('cpa').healthy,
    maxCpa: getTargetRange('cpa').watch,
    targetPolicyStatus: targetPolicy.status,
    objective: accountObjective,
    attributedShare,
    daysSinceLastDelivery,
    activeAdsDelivering,
    anyAdsetExitedLearning: learningRead.exited,
    writeModeEnabled: process.env.WRITE_MODE_ENABLED === 'true',
    mediaBuyerRecommendationsEnabled,
  })

  const lowData = mode.dataMode === 'pre_launch' || mode.dataMode === 'low_data'

  // UTM coverage + launch verdict. In pre-launch/low-data the launch question is COHORT-scoped: the staged
  // ads are PAUSED, so account-wide "active ads" coverage would measure stale old ads. Resolve the cohort
  // (skipping the pixel API — the dedicated get_launch_readiness tool runs the full dormant-aware check).
  let utmCoverage: number | null = null
  let launchVerdict: object | null = null
  let cohortResolved = false
  if (lowData) {
    try {
      const lr = await resolveLaunchReadiness(activeAcct, {
        skipTracking: true,
        skipPlanningContext: true,
      })
      cohortResolved = true
      utmCoverage = lr.utm.coverage
      launchVerdict = {
        ready: lr.verdict.ready, // true | false | null(=unverified)
        evaluated_cohort: lr.verdict.evaluated_cohort,
        confirmed: lr.verdict.confirmed,
        unverified: lr.verdict.unverified,
        launch_blockers: lr.verdict.blockers,
        historical_cleanup: lr.verdict.historical_cleanup,
        before_launch: lr.verdict.before_launch,
        utm_scope: lr.utm.scope,
        note: `Cohort-scoped verdict. Pixel/${EVENT} NOT evaluated here — call get_launch_readiness for the full verdict incl. the dormant-aware pixel check.`,
      }
    } catch { /* fall back to account-wide coverage below */ }
  }
  if (!cohortResolved) {
    try {
      utmCoverage = (await computeUtmCoverage(activeAcct)).coverage
    } catch { /* non-fatal — coverage stays unknown */ }
  }

  const launch = lowData ? buildLaunchReadinessReport({ mode, today: end, attributedShare, utmCoverage }) : null

  return {
    mode,
    // The account's evidence class, surfaced so every other tool answers to the SAME authority
    // question instead of keeping its own opinion.
    authority_basis: mode.authorityBasis,
    scale_authority_basis: mode.scaleAuthorityBasis,
    cut_authority_basis: mode.cutAuthorityBasis,
    signals: {
      window: { start, end },
      meta_spend_30d: roundMoney(spend30d),
      meta_bookings_30d: metaBookings30d,
      ga4_available: ga4Available,
      // Structured key names are part of the contract the model reads. `ga4_paid_bookings_30d`
      // asserted these were bookings; they are confirmation EVENTS with no appointment identity.
      ga4_paid_confirmation_events_30d: ga4PaidConfirmationEvents,
      ga4_organic_confirmation_events_30d: ga4OrganicBookings, // context only — not ad performance
      attributed_share: attributedShare,
      utm_coverage: utmCoverage,
      days_since_last_delivery: daysSinceLastDelivery,
      active_ads_delivering: activeAdsDelivering,
      write_mode_enabled: process.env.WRITE_MODE_ENABLED === 'true',
      media_buyer_recommendations_enabled: mediaBuyerRecommendationsEnabled,
      target_policy: {
        status: targetPolicy.status,
        authority_eligible: targetPolicy.authorityEligible,
        reason_code: targetPolicy.reasonCode,
        reason: targetPolicy.reason,
      },
      paid_interaction_cohort: interactionCohorts,
    },
    launch_verdict: launchVerdict, // cohort-scoped (null unless pre-launch/low-data); full verdict via get_launch_readiness
    launch_readiness: launch
      ? {
          headline: launch.headline,
          tracking_readiness: launch.tracking_readiness,
          campaign_structure_check: launch.campaign_structure_check,
          audience_test_plan: launch.audience_test_plan,
          creative_test_plan: launch.creative_test_plan,
          budget_learning_plan: launch.budget_learning_plan,
          landing_booking_checks: launch.landing_booking_checks,
          data_needed_before_decisions: launch.data_needed_before_decisions,
          do_not_change_yet: launch.do_not_change_yet,
          next_review_date: launch.next_review_date,
        }
      : null,
    note: `Use this mode to decide what you may claim. In pre-launch/low-data, give the launch-readiness plan, not a performance diagnosis. For any "are the ads ready to launch / do the launch ads have UTMs / is the pixel working" question, call get_launch_readiness — it returns the COHORT-scoped, source-labeled verdict (launch_verdict here is a preview without the pixel check). Per-campaign ROAS requires complete exact ${OW.one} identity, complete campaign mapping, an authoritative account-spend basis, and reconciled complete campaign spend; attributed_share alone never unlocks it.`,
  }
}
