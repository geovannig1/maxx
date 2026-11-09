import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo, nyEndOfDayMs, nyToday } from '@/lib/utils/date-utils'
import { deriveFirstDelivery, type DeliveryDay } from '@/lib/insights/first-delivery'
import { classifyOptimizationSignal, type OptimizationSignalResult } from '@/lib/diagnostics/optimization-signal'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import type { DatasetStatsResult } from '@/lib/platforms/types'
import { getGa4ConfirmationTelemetryBySource } from '@/lib/ga4/client'
import { getMetricStatus, type MetricKey, type MetricStatus } from '@/lib/targets/target-ranges'
import { deriveExitedLearning } from '@/lib/recommendations/trend'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { championVerdict, type ChampionComparison } from '@/lib/economics/champion'
import {
  retargetingShareOfSpend,
  auctionOverlapInference,
  spendConcentration,
  type BudgetControl,
  type RetargetingShareResult,
  type OverlapInference,
  type SpendConcentrationResult,
} from '@/lib/diagnostics/structure'
import {
  resolveAudience,
  TARGETING_STALE_HOURS,
  type AudienceRef,
  type AudienceResolution,
} from '@/lib/audience/resolver'
import { buildAdsetDeliverySignals, type AdsetDeliverySignals } from '@/lib/diagnostics/delivery'
import { classifyWindowSettle, type WindowSettle } from '@/lib/insights/settle-window'
import {
  normalizePersistedDeliverySubStatus,
  type DeliverySubStatusEvidence,
} from '@/lib/platforms/meta/delivery-sub-status'
import { formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'

// THE COMPLETE PICTURE — the deterministic ad-performance diagnosis Maxx never assembled. Answers the
// owner's real question ("is the launch stalled because of the learning phase, or something structural?")
// by combining, from real data:
//   • the TRUE days-delivering (first spend, not creation date),
//   • delivery-health bands (CTR/CPC/CPM/frequency via the central target ranges),
//   • the OPTIMIZATION-SIGNAL test (does the conversion event fire enough to ever exit learning?),
//   • Meta's synced learning_stage,
//   • the ad-attributed funnel + the site-wide event ladder.
// It separates "too early to judge RESULTS" (a time fact) from "structurally starved of signal" (a
// setup observation). It does NOT choose an objective, event, budget, audience or page. Those choices
// require an approved CampaignPlan and the shared ActionAuthority pipeline.
//
// GA's confirmation telemetry reader measures this named event. This is a SOURCE label, not a default
// for OFFSITE_CONVERSIONS: the configured event must be read from the ad set's promoted_object.
const GA_CONFIRMATION_EVENT = 'AppointmentConfirmed'

export type LaunchPerformanceVerdict = 'too_early' | 'still_learning' | 'structurally_starved' | 'healthy'

/** Per-ad-set slice the pure builder needs (already aggregated over the window). */
export interface AdsetDiagnosticInput {
  /** Exact Meta ad-set id when observed by the gatherer. */
  id?: string
  name: string
  /** Event read from promoted_object for an offsite-conversion goal, or the literal non-conversion
   *  goal. Null means the configured event could not be observed; it is never defaulted. */
  optimizationEvent: string | null
  optimizationGoal: string | null
  learningStage: string | null
  /** Meta's learning counter (attribution-scoped; resets on significant edits). Null when not synced. */
  learningConversions: number | null
  /** ISO timestamp of the last significant edit (the counter resets from this moment). */
  lastSigEditTs: string | null
  /** Synced Meta targeting spec — the basis for the narrow-audience inference AND for the resolved
   *  audience composition. */
  targeting: Record<string, unknown> | null
  /** When the targeting snapshot was taken. NULL => treated as stale; conclusions freeze. */
  targetingSyncedAt?: string | null
  /** What Meta ACTUALLY relaxed (adsets.targeting_optimization_types). Outranks the configured spec. */
  targetingRelaxation?: Array<{ key: string; value: number }> | null
  deliverySubStatus?: DeliverySubStatusEvidence
  /** Optional delivery_estimate MAU bounds (labeled; never Ads Manager's audience-size bucket). */
  mauBounds?: { lower: number; upper: number } | null
  dailyBudget: number | null
  /** Inclusive lower bound of the spend rows supplied in `days`. */
  dataWindowStart?: string | null
  days: DeliveryDay[]
  spend: number
  impressions: number
  reach: number
  clicks: number
  linkClicks: number
  bookings: number
}

export interface LaunchPerformanceBuildInput {
  today: string
  /** Reporting bounds for attribution-settle labeling. Omitted only by legacy pure callers. */
  window?: { from: string; to: string }
  /** Budget owner for the evaluated cohort. Unknown when the optional campaign-budget read fails. */
  budgetControl?: BudgetControl
  /** Meta account id and account-scoped audience inventory used to resolve targeting by facts. */
  metaAccountId?: string
  audiencesById?: Record<string, AudienceRef>
  audienceInventory?: AudienceInventoryReadHealth
  adsets: AdsetDiagnosticInput[]
  eventVolume: DatasetStatsResult
  /** Site-wide weekly firing rate of GA's named AppointmentConfirmed telemetry event. It may be used
   *  only when promoted_object independently shows that exact configured event. */
  conversionEventPerWeek?: number
  writeModeEnabled: boolean
}

export type AudienceInventoryReadHealth =
  | {
      read_available: true
      schema: 'rich' | 'baseline' | 'provided'
      row_count: number
      reason_code: null
      reason: null
    }
  | {
      read_available: false
      schema: null
      row_count: null
      reason_code: 'custom_audiences_read_failed' | 'custom_audience_snapshot_unavailable' | 'audience_inventory_not_evaluated'
      reason: string
    }

interface MetricSummary {
  key: MetricKey
  value: number | null
  status: MetricStatus
}

export type OptimizationCompatibilityReasonCode =
  | 'campaign_plan_not_evaluated'
  | 'optimization_event_unresolved'
  | 'mixed_optimization_events'

export interface OptimizationCompatibility {
  /** Compatibility is intentionally UNKNOWN until a CampaignPlan declares the intended outcome. */
  status: 'unknown'
  reason_code: OptimizationCompatibilityReasonCode
  observed_goals: string[]
  observed_events: string[]
  reason: string
}

export interface LaunchDiagnosticObservation {
  code: 'delivery_window' | 'optimization_signal' | 'learning_state' | 'plan_compatibility'
  evidence_plane: 'structural' | 'ga_telemetry' | 'meta_modelled'
  statement: string
  action_authority_tier: 'diagnostic_only'
}

export interface LaunchPerformanceDiagnosis {
  verdict: LaunchPerformanceVerdict
  headline: string
  /** Plain-English read that separates DATA from INFERENCE. */
  read: string
  launch: {
    first_spend_date: string | null
    days_delivering: number
    in_learning_window: boolean
    /** False while within the learning window / below min spend — RESULTS are not yet a fair basis. */
    results_judgeable: boolean
  }
  /** Whether the requested reporting window may still restate. Null only for legacy pure callers. */
  window_settle: WindowSettle | null
  delivery_health: {
    spend: number
    impressions: number
    metrics: MetricSummary[]
    healthy: boolean
  }
  conversions: {
    meta_modelled_bookings: number
    meta_modelled_cost_per_result: number | null
    evidence_plane: 'meta_modelled'
  }
  optimization_signal:
    | ({ event: string; available: true; source: 'ga4' | 'pixel_stats' } & OptimizationSignalResult)
    | {
        event: string | null
        available: false
        reason_code: 'no_delivery' | 'optimization_event_unresolved' | 'mixed_optimization_events' | 'event_volume_unavailable'
        reason: string
      }
  optimization_compatibility: OptimizationCompatibility
  learning: {
    any_exited: boolean
    stages: { name: string; stage: string | null; exited: boolean | null }[]
  }
  /** Per-ad-set delivery narration (learning counter + results-to-exit, narrow-audience inference,
   *  budget-overshoot stats) — the layer Meta's chat leads with, honestly labeled. Never average these. */
  adsets_detail: AdsetDeliverySignals[]
  /** Read health is separate from the resolved rows: zero rows can be a valid empty inventory,
   *  while a failed read freezes audience conclusions. Diagnostic only. */
  audience_inventory: AudienceInventoryReadHealth
  audiences: Array<{ adset_id?: string; adset_name: string; resolution: AudienceResolution }>
  funnel: {
    impressions: number
    link_clicks: number
    meta_modelled_bookings: number
    site_wide_event_ladder: { event: string; per_week: number }[]
  }
  /** Meta-modelled current-period comparator vs Meta-modelled history. Diagnostic only. */
  champion_comparison: ChampionComparison
  structure: {
    retargeting_share: RetargetingShareResult
    spend_concentration: SpendConcentrationResult
    auction_overlap: OverlapInference
  }
  /** Observations are the only forward-looking output from this surface. They never prescribe a
   *  setting. Any proposed action must be created separately and resolved by ActionAuthority. */
  observations: LaunchDiagnosticObservation[]
  /** Deliberately empty compatibility field for MCP clients that previously consumed `levers`. */
  prescriptions: []
  action_authority: {
    tier: 'diagnostic_only'
    reason_code: 'diagnostic_observations_only'
  }
  caveats: string[]
}

const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p

const uniqueSorted = (values: Array<string | null | undefined>) =>
  [...new Set(values.map((v) => v?.trim()).filter((v): v is string => !!v))].sort()

function optimizationCompatibility(adsets: AdsetDiagnosticInput[]): OptimizationCompatibility {
  const observedGoals = uniqueSorted(adsets.map((a) => a.optimizationGoal))
  const observedEvents = uniqueSorted(adsets.map((a) => a.optimizationEvent))
  const hasUnresolvedEvent = adsets.some((a) => !a.optimizationEvent?.trim())

  if (hasUnresolvedEvent) {
    return {
      status: 'unknown',
      reason_code: 'optimization_event_unresolved',
      observed_goals: observedGoals,
      observed_events: observedEvents,
      reason: 'Optimization compatibility is UNKNOWN because at least one active ad set has no observed event in promoted_object; no event is inferred from its optimization goal.',
    }
  }
  if (observedEvents.length > 1) {
    return {
      status: 'unknown',
      reason_code: 'mixed_optimization_events',
      observed_goals: observedGoals,
      observed_events: observedEvents,
      reason: `Optimization compatibility is UNKNOWN because the active cohort has multiple observed events (${observedEvents.join(', ')}).`,
    }
  }
  return {
    status: 'unknown',
    reason_code: 'campaign_plan_not_evaluated',
    observed_goals: observedGoals,
    observed_events: observedEvents,
    reason: 'Optimization compatibility with the intended business outcome is UNKNOWN because no approved CampaignPlan was evaluated.',
  }
}

function observation(
  code: LaunchDiagnosticObservation['code'],
  evidencePlane: LaunchDiagnosticObservation['evidence_plane'],
  statement: string,
): LaunchDiagnosticObservation {
  return {
    code,
    evidence_plane: evidencePlane,
    statement,
    action_authority_tier: 'diagnostic_only',
  }
}

function neutralSignalDetail(event: string, signal: OptimizationSignalResult): string {
  return `Observed ${event} volume is ~${Math.round(signal.actualPerWeek)}/week site-wide versus ` +
    `~${signal.perAdsetThreshold}/week per active ad set and ~${signal.needPerWeek}/week across ` +
    `${signal.activeAdsetsOnEvent} active ad set(s); signal classification=${signal.verdict}.`
}

function diagnosticChampion(raw: ChampionComparison): ChampionComparison {
  const ratio = raw.ratio == null ? 'unavailable' : round(raw.ratio, 3).toString()
  return {
    ...raw,
    detail: `Meta-modelled platform comparator classification=${raw.verdict}; ratio=${ratio}. ` +
      'This is a historical platform-modelled comparison, not paid-outcome authority.',
  }
}

function diagnosticStructure(
  slices: Parameters<typeof retargetingShareOfSpend>[0],
  names: string[],
  budgetControl: BudgetControl,
): LaunchPerformanceDiagnosis['structure'] {
  const retargeting = retargetingShareOfSpend(slices)
  const concentration = spendConcentration(slices, budgetControl)
  const overlap = auctionOverlapInference(names)
  const share = retargeting.share == null ? 'unavailable' : `${round(retargeting.share * 100, 1)}%`
  return {
    retargeting_share: {
      ...retargeting,
      detail: `Observed retargeting-share classification=${retargeting.band}; share=${share}; ` +
        `total_spend=${formatMoneyAmount(roundMoney(retargeting.total_spend))}; classified_retargeting_spend=${formatMoneyAmount(roundMoney(retargeting.warm_spend))}.` +
        (retargeting.band === 'no_data' ? ' The share is unavailable because audience composition is mixed or unresolved.' : ''),
    },
    spend_concentration: concentration,
    auction_overlap: {
      ...overlap,
      detail: `Auction-overlap classification=${overlap.risk}; this remains an ASSUMPTION because the account-level auction diagnostic is unavailable.`,
      owner_check: 'No governed follow-up is emitted by this diagnostic surface.',
    },
  }
}

/** PURE: assemble the diagnosis from already-fetched inputs. Fully unit-testable. */
export function buildLaunchPerformance(input: LaunchPerformanceBuildInput): LaunchPerformanceDiagnosis {
  const { today, adsets, eventVolume, writeModeEnabled } = input
  const windowSettle = input.window
    ? classifyWindowSettle({ ...input.window, today })
    : null
  const caveats: string[] = []
  if (!writeModeEnabled) caveats.push('Write mode is OFF. This diagnostic surface cannot execute changes.')
  const audienceInventory: AudienceInventoryReadHealth = input.audienceInventory
    ?? (input.audiencesById !== undefined
      ? {
          read_available: true,
          schema: 'provided',
          row_count: Object.keys(input.audiencesById).length,
          reason_code: null,
          reason: null,
        }
      : {
          read_available: false,
          schema: null,
          row_count: null,
          reason_code: 'audience_inventory_not_evaluated',
          reason: 'Custom-audience inventory was not evaluated for this diagnosis.',
        })
  if (!audienceInventory.read_available) {
    caveats.push(
      `Custom-audience inventory is UNAVAILABLE (${audienceInventory.reason}). ` +
      'Audience composition remains diagnostic-only and material audience or budget conclusions are frozen.',
    )
  }

  // ── Aggregates ──
  const agg = adsets.reduce(
    (a, s) => ({
      spend: a.spend + s.spend,
      impressions: a.impressions + s.impressions,
      reach: a.reach + s.reach,
      clicks: a.clicks + s.clicks,
      linkClicks: a.linkClicks + s.linkClicks,
      bookings: a.bookings + s.bookings,
    }),
    { spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, bookings: 0 },
  )
  const allDays: DeliveryDay[] = adsets.flatMap((s) => s.days)
  const fd = deriveFirstDelivery(allDays, today)
  const compatibility = optimizationCompatibility(adsets)

  // `today` is an account-timezone date, so it must be converted with that date's offset. The old
  // `${today}T23:59:59Z` labelled an NY date as UTC and therefore sat 4-5h early; from 20:00 ET until
  // midnight it fell BEHIND real time, so a just-synced audience measured as a NEGATIVE age and
  // resolveAudience froze it as 'stale or invalid'. The clock was wrong, not the data.
  const audienceNowMs = nyEndOfDayMs(today)
  const audiences = adsets.map((adset) => ({
    ...(adset.id ? { adset_id: adset.id } : {}),
    adset_name: adset.name,
    resolution: resolveAudience({
      adsetName: adset.name,
      targeting: adset.targeting,
      targetingSyncedAt: adset.targetingSyncedAt ?? null,
      accountId: input.metaAccountId ?? '__unresolved_account__',
      audiencesById: input.audiencesById,
    }, audienceNowMs),
  }))

  // Per-ad-set delivery narration (pure; labeling rules live in delivery.ts).
  const adsetsDetail: AdsetDeliverySignals[] = adsets.map((s) =>
    buildAdsetDeliverySignals({
      ...(s.id ? { id: s.id } : {}),
      name: s.name,
      learningStage: s.learningStage,
      learningConversions: s.learningConversions,
      lastSigEditTs: s.lastSigEditTs,
      dailyBudget: s.dailyBudget,
      dataWindowStart: s.dataWindowStart ?? null,
      days: s.days,
      targeting: s.targeting,
      targetingRelaxation: s.targetingRelaxation ?? null,
      deliverySubStatus: s.deliverySubStatus,
      mauBounds: s.mauBounds ?? null,
    }),
  )

  // ── No delivery guard ──
  if (adsets.length === 0 || fd.firstSpendDate === null || agg.spend <= 0) {
    return {
      verdict: 'too_early',
      headline: 'No active ad set has delivered yet — nothing to diagnose.',
      read: 'No active launch ad set has spent yet, so there is no delivery to judge. Re-check once the ads are spending.',
      launch: { first_spend_date: fd.firstSpendDate, days_delivering: fd.daysDelivering, in_learning_window: fd.inLearningWindow, results_judgeable: false },
      window_settle: windowSettle,
      delivery_health: { spend: roundMoney(agg.spend), impressions: agg.impressions, metrics: [], healthy: false },
      conversions: {
        meta_modelled_bookings: agg.bookings,
        meta_modelled_cost_per_result: null,
        evidence_plane: 'meta_modelled',
      },
      optimization_signal: { event: null, available: false, reason_code: 'no_delivery', reason: 'No delivery yet.' },
      optimization_compatibility: compatibility,
      learning: { any_exited: false, stages: adsets.map((s) => ({ name: s.name, stage: s.learningStage, exited: deriveExitedLearning(s.learningStage) })) },
      adsets_detail: adsetsDetail,
      audience_inventory: audienceInventory,
      audiences,
      funnel: { impressions: 0, link_clicks: 0, meta_modelled_bookings: 0, site_wide_event_ladder: [] },
      champion_comparison: diagnosticChampion(championVerdict(null, 0)),
      structure: diagnosticStructure([], [], input.budgetControl ?? 'unknown'),
      observations: [
        observation('delivery_window', 'structural', 'No active ad set delivered spend in the evaluated window.'),
        observation('plan_compatibility', 'structural', compatibility.reason),
      ],
      prescriptions: [],
      action_authority: { tier: 'diagnostic_only', reason_code: 'diagnostic_observations_only' },
      caveats,
    }
  }

  // ── Delivery health (bands from the central target ranges) ──
  const ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : null
  const cpc = agg.clicks > 0 ? agg.spend / agg.clicks : null
  const cpm = agg.impressions > 0 ? (agg.spend / agg.impressions) * 1000 : null
  const frequency = agg.reach > 0 ? agg.impressions / agg.reach : null
  const evalCtx = { spend: agg.spend, clicks: agg.clicks, impressions: agg.impressions, bookings: agg.bookings, windowDays: fd.daysDelivering }
  const metricPairs: [MetricKey, number | null][] = [['ctr', ctr], ['cpc', cpc], ['cpm', cpm], ['frequency', frequency]]
  // CPC and CPM are money (the account currency's minor unit); CTR and frequency keep two decimals.
  const metrics: MetricSummary[] = metricPairs.map(([key, value]) => ({ key, value: value === null ? null : key === 'cpc' || key === 'cpm' ? roundMoney(value) : round(value), status: getMetricStatus(key, value, evalCtx).status }))
  // A cost metric with no owner target (no_target) is unjudged, not a delivery problem.
  const deliveryHealthy = metrics.every((m) => m.status === 'excellent' || m.status === 'healthy' || m.status === 'needs_data' || m.status === 'no_target' || m.status === 'unknown')

  // ── Optimization signal (the structural test) ──
  const convEvents = adsets.map((s) => s.optimizationEvent?.trim() || null)
  const uniqueEvents = [...new Set(convEvents.filter((e): e is string => !!e))]
  const allEventsResolved = convEvents.length > 0 && convEvents.every((e): e is string => !!e)
  const primaryEvent = allEventsResolved && uniqueEvents.length === 1 ? uniqueEvents[0] : null
  const activeAdsetsOnEvent = primaryEvent
    ? adsets.filter((s) => s.optimizationEvent?.trim() === primaryEvent).length
    : 0

  let signal: LaunchPerformanceDiagnosis['optimization_signal']
  if (!allEventsResolved) {
    signal = {
      event: null,
      available: false,
      reason_code: 'optimization_event_unresolved',
      reason: 'At least one active ad set has no observed optimization event in promoted_object.',
    }
  } else if (uniqueEvents.length !== 1) {
    signal = {
      event: null,
      available: false,
      reason_code: 'mixed_optimization_events',
      reason: `The active ad sets use multiple observed optimization events (${uniqueEvents.join(', ')}), so one cohort rate would be invalid.`,
    }
  } else {
    // GA confirmation telemetry is event-specific. It may only supply the rate when the OBSERVED
    // configured event is the same named event; it is never substituted for another event.
    const gaRate = primaryEvent === GA_CONFIRMATION_EVENT ? input.conversionEventPerWeek : undefined
    const pixelRate = eventVolume.available && primaryEvent ? requireCapability(getAdPlatform('meta'), 'datasetDiagnostics').eventPerWeek(eventVolume, primaryEvent) : null
    const rate = gaRate ?? pixelRate
    const source: 'ga4' | 'pixel_stats' | null = gaRate != null ? 'ga4' : pixelRate != null ? 'pixel_stats' : null
    if (rate != null && source && primaryEvent) {
      const classified = classifyOptimizationSignal({ eventPerWeek: rate, activeAdsetsOnEvent })
      signal = {
        event: primaryEvent,
        available: true,
        source,
        ...classified,
        detail: neutralSignalDetail(primaryEvent, classified),
      }
      if (source === 'pixel_stats') caveats.push('Conversion-event rate is from the pixel stats edge, whose ~28-day retention makes a longer window incomplete. The exact rate is a floor.')
    } else {
      signal = {
        event: primaryEvent,
        available: false,
        reason_code: 'event_volume_unavailable',
        reason: eventVolume.reason ?? `Site-wide ${primaryEvent ?? 'optimization-event'} volume unavailable.`,
      }
      caveats.push(`Optimization-signal sufficiency is UNVERIFIED because the site-wide ${primaryEvent ?? 'optimization-event'} rate was unavailable (${eventVolume.reason ?? 'unknown'}).`)
    }
  }

  // ── Learning ──
  const stages = adsets.map((s) => ({ name: s.name, stage: s.learningStage, exited: deriveExitedLearning(s.learningStage) }))
  const anyExited = stages.some((s) => s.exited === true)

  // ── Funnel: ad-attributed steps + site-wide event ladder (incl. the standard-event parity pair) ──
  // Standard Meta funnel events plus whatever event the ad sets optimize for. A site's own custom
  // events are not named here: they vary per install, and only the optimized one has a role.
  const ladderOrder = ['PageView', 'InitiateCheckout', 'Schedule', 'Purchase']
  if (primaryEvent) ladderOrder.push(primaryEvent)
  const site_wide_event_ladder = eventVolume.available
    ? eventVolume.events.filter((e) => ladderOrder.includes(e.event)).map((e) => ({ event: e.event, per_week: round(e.perWeek, 1) }))
    : []
  if (site_wide_event_ladder.length) caveats.push('Site-wide event ladder is best-effort (the pixel stats edge retains only ~28 days, so a longer window is INCOMPLETE) — read it as directional funnel shape, not exact rates.')

  // ── Verdict ──
  const structural = signal.available && signal.verdict === 'structurally_starved'
  const tooEarly = fd.daysDelivering < REC_THRESHOLDS.MIN_WINDOW_DAYS_REVERSAL || agg.spend < REC_THRESHOLDS.MIN_SPEND_TO_JUDGE
  const resultsJudgeable = !tooEarly && !fd.inLearningWindow

  let verdict: LaunchPerformanceVerdict
  if (structural) verdict = 'structurally_starved'
  else if (tooEarly) verdict = 'too_early'
  else if (!anyExited) verdict = 'still_learning'
  else verdict = 'healthy'

  // ── Platform-modelled historical comparison (diagnostic; never action authority) ──
  // Both sides use Meta attribution. That preserves a like-for-like platform signal, but neither side
  // is a paid interaction cohort, so the rendered detail explicitly withholds money authority.
  const cohortCpa = agg.bookings > 0 ? agg.spend / agg.bookings : null
  const champion = diagnosticChampion(championVerdict(cohortCpa, agg.bookings))

  // ── Structure checks (steelman: retargeting share + overlap inference) ──
  const audienceSlices = adsets.map((s, index) => ({
    name: s.name,
    audience_type: null,
    spend: s.spend,
    composition: audiences[index]?.resolution.composition ?? 'unknown',
  }))
  const structure = diagnosticStructure(
    audienceSlices,
    adsets.map((s) => s.name),
    input.budgetControl ?? 'unknown',
  )

  // ── Read (data vs inference) ──
  const daysTxt = `${fd.daysDelivering} day${fd.daysDelivering === 1 ? '' : 's'} delivering (since ${fd.firstSpendDate})`
  const deliveryTxt = deliveryHealthy ? 'front-end delivery is healthy (people are clicking)' : 'front-end delivery has issues'
  const read = buildRead({ verdict, daysTxt, deliveryTxt, signal, resultsJudgeable, inWindow: fd.inLearningWindow, compatibility })
  const headline = buildHeadline(verdict, fd.daysDelivering)
  const observations: LaunchDiagnosticObservation[] = [
    observation('delivery_window', 'structural', `${daysTxt}; ${deliveryTxt}; ${formatMoneyAmount(roundMoney(agg.spend))} spent across ${agg.impressions} impressions.`),
    observation(
      'optimization_signal',
      signal.available ? (signal.source === 'ga4' ? 'ga_telemetry' : 'structural') : 'structural',
      signal.available ? signal.detail : `Optimization-signal rate unavailable: ${signal.reason}`,
    ),
    observation(
      'learning_state',
      'meta_modelled',
      `${stages.filter((s) => s.exited === true).length} of ${stages.length} active ad sets have an observed SUCCESS learning stage.`,
    ),
    observation('plan_compatibility', 'structural', compatibility.reason),
  ]

  return {
    verdict,
    headline,
    read,
    launch: { first_spend_date: fd.firstSpendDate, days_delivering: fd.daysDelivering, in_learning_window: fd.inLearningWindow, results_judgeable: resultsJudgeable },
    window_settle: windowSettle,
    delivery_health: { spend: roundMoney(agg.spend), impressions: agg.impressions, metrics, healthy: deliveryHealthy },
    conversions: {
      meta_modelled_bookings: agg.bookings,
      meta_modelled_cost_per_result: agg.bookings > 0 ? roundMoney(agg.spend / agg.bookings) : null,
      evidence_plane: 'meta_modelled',
    },
    optimization_signal: signal,
    optimization_compatibility: compatibility,
    learning: { any_exited: anyExited, stages },
    adsets_detail: adsetsDetail,
    audience_inventory: audienceInventory,
    audiences,
    funnel: {
      impressions: agg.impressions,
      link_clicks: agg.linkClicks,
      meta_modelled_bookings: agg.bookings,
      site_wide_event_ladder,
    },
    champion_comparison: champion,
    structure,
    observations,
    prescriptions: [],
    action_authority: { tier: 'diagnostic_only', reason_code: 'diagnostic_observations_only' },
    caveats,
  }
}

function buildHeadline(verdict: LaunchPerformanceVerdict, days: number): string {
  switch (verdict) {
    case 'structurally_starved': return `Structurally starved of conversion signal — not just the learning phase (day ${days}).`
    case 'too_early': return `Too early to judge — only ${days} day${days === 1 ? '' : 's'} of delivery.`
    case 'still_learning': return `Still in the learning phase (day ${days}); delivery observation available.`
    case 'healthy': return 'Observed learning stage is complete and delivery is active.'
  }
}

function buildRead(a: {
  verdict: LaunchPerformanceVerdict
  daysTxt: string
  deliveryTxt: string
  signal: LaunchPerformanceDiagnosis['optimization_signal']
  resultsJudgeable: boolean
  inWindow: boolean
  compatibility: OptimizationCompatibility
}): string {
  const early = a.inWindow || !a.resultsJudgeable
    ? `On results it is too early to judge — ${a.daysTxt}, ${a.deliveryTxt}.`
    : `${a.daysTxt}; ${a.deliveryTxt}.`
  if (a.verdict === 'structurally_starved' && a.signal.available) {
    return `${early} DATA: ${a.signal.detail} INFERENCE: observed event volume is below the learning threshold. ${a.compatibility.reason} This is a diagnostic observation; no setting prescription is emitted.`
  }
  if (a.verdict === 'too_early') return `${early} The timing state is diagnostic only and does not authorise a setting action.`
  if (a.verdict === 'still_learning') return `${early} The observed learning state is diagnostic only. ${a.compatibility.reason}`
  return `${early} The observed learning stage is complete. ${a.compatibility.reason}`
}

// ── Impure gatherer: pull the cohort + event volume, then build ──────────────────────────────────

/** Read the configured optimization event. A conversion goal without a promoted event is UNKNOWN. */
export function resolveObservedOptimizationEvent(
  optimizationGoal: string | null,
  promotedObject: Record<string, unknown> | null,
): string | null {
  if (!optimizationGoal) return null
  const normalizedGoal = optimizationGoal.trim().toUpperCase()
  if (['OFFSITE_CONVERSIONS', 'OFFSITE_CONVERSION', 'CONVERSIONS', 'VALUE'].includes(normalizedGoal)) {
    const raw = promotedObject?.custom_event_str ?? promotedObject?.custom_event_type
    const event = typeof raw === 'string' ? raw.trim() : ''
    return event && event.toUpperCase() !== 'OTHER' ? event : null
  }
  return optimizationGoal.trim()
}

interface AdsetRow {
  id: string
  campaign_id: string
  adset_id: string | null
  adset_name: string | null
  optimization_goal: string | null
  promoted_object: Record<string, unknown> | null
  learning_stage: string | null
  learning_conversions: number | null
  last_sig_edit_ts: string | null
  targeting: Record<string, unknown> | null
  targeting_last_synced_at: string | null
  /** What Meta ACTUALLY relaxed (`adsets.targeting_optimization_types`). Null = Meta reported nothing. */
  targeting_optimization_types: Array<{ key: string; value: number }> | null
  delivery_sub_status: unknown
  delivery_sub_status_read_available: unknown
  delivery_sub_status_synced_at: unknown
  daily_budget: number | null
  lifetime_budget: number | null
}
type SupabaseErrorLike = { code?: string | null; message?: string | null }
interface CampaignBudgetRow {
  id: string
  daily_budget: number | null
  lifetime_budget: number | null
}
interface InsightRow {
  adset_id: string | null
  date_start: string
  spend: number | null
  impressions: number | null
  reach: number | null
  clicks: number | null
  link_clicks: number | null
  bookings: number | null
}

interface CustomAudienceRow {
  audience_id: string
  name: string | null
  subtype: string | null
  meta_account_id: string | null
  source_audience_id?: string | null
  source_audience_name?: string | null
  approximate_count_lower_bound?: number | null
  approximate_count_upper_bound?: number | null
  retention_days?: number | null
  operation_status?: unknown
  delivery_status?: unknown
  last_synced_at?: string | null
}

interface CustomAudienceInventorySnapshot {
  complete?: unknown
  completed_at?: unknown
  meta_account_id?: unknown
  row_count?: unknown
}

export type LaunchPerformanceUnavailableSource =
  | 'admin_client'
  | 'ad_accounts'
  | 'adsets'
  | 'daily_insights'
  | 'dataset_stats'
  | 'gatherer'

/** Stable, machine-readable failure for a required diagnosis input. MCP section wrappers convert
 * this rejection into `{ available:false, reason }`; it must never be replaced with empty rows. */
export class LaunchPerformanceUnavailableError extends Error {
  readonly code = 'LAUNCH_PERFORMANCE_UNAVAILABLE' as const

  constructor(readonly source: LaunchPerformanceUnavailableSource) {
    super(`Launch performance unavailable: required ${source} read failed.`)
    this.name = 'LaunchPerformanceUnavailableError'
  }
}

function isMissingDeliverySubStatusColumns(error: SupabaseErrorLike | null): boolean {
  if (!error) return false
  const message = error.message ?? ''
  return /delivery_sub_status/i.test(message)
    && (
      error.code === '42703'
      || /does not exist|not exist|unknown column|undefined column/i.test(message)
    )
}

async function fetchActiveAdsets(
  db: ReturnType<typeof getAdminClient>,
  accountId: string,
): Promise<(AdsetRow & { effective_status: string | null })[]> {
  const withDeliveryColumns =
    'id, campaign_id, adset_id, adset_name, optimization_goal, promoted_object, learning_stage, learning_conversions, last_sig_edit_ts, targeting, targeting_last_synced_at, targeting_optimization_types, delivery_sub_status, delivery_sub_status_read_available, delivery_sub_status_synced_at, daily_budget, lifetime_budget, effective_status'
  const baselineColumns =
    'id, campaign_id, adset_id, adset_name, optimization_goal, promoted_object, learning_stage, learning_conversions, last_sig_edit_ts, targeting, targeting_last_synced_at, targeting_optimization_types, daily_budget, lifetime_budget, effective_status'

  const read = (columns: string) => db
    .from('adsets')
    .select(columns)
    .eq('ad_account_id', accountId)
    .eq('effective_status', 'ACTIVE')

  const rich = await read(withDeliveryColumns)
  if (!rich.error) return (rich.data ?? []) as unknown as (AdsetRow & { effective_status: string | null })[]
  if (!isMissingDeliverySubStatusColumns(rich.error)) {
    throw new LaunchPerformanceUnavailableError('adsets')
  }

  const baseline = await read(baselineColumns)
  if (baseline.error) throw new LaunchPerformanceUnavailableError('adsets')
  return ((baseline.data ?? []) as unknown as (Omit<AdsetRow, 'delivery_sub_status' | 'delivery_sub_status_read_available' | 'delivery_sub_status_synced_at'> & { effective_status: string | null })[])
    .map((row) => ({
      ...row,
      delivery_sub_status: null,
      delivery_sub_status_read_available: false,
      delivery_sub_status_synced_at: null,
    }))
}

async function fetchAudienceInventory(
  db: ReturnType<typeof getAdminClient>,
  adAccountDbId: string,
  metaAccountId: string | null,
): Promise<{ rows: Record<string, AudienceRef>; read: AudienceInventoryReadHealth }> {
  const richColumns =
    'audience_id, name, subtype, meta_account_id, source_audience_id, source_audience_name, approximate_count_lower_bound, approximate_count_upper_bound, retention_days, operation_status, delivery_status, last_synced_at'
  const baselineColumns =
    'audience_id, name, subtype, meta_account_id, source_audience_id, source_audience_name, last_synced_at'

  let rows: CustomAudienceRow[] | null = null
  let schema: 'rich' | 'baseline' | null = null
  try {
    const rich = await db.from('custom_audiences').select(richColumns).eq('ad_account_id', adAccountDbId)
    if (!rich.error) {
      rows = (rich.data ?? []) as CustomAudienceRow[]
      schema = 'rich'
    }
  } catch { /* try the baseline schema below */ }

  if (rows === null) {
    try {
      const baseline = await db.from('custom_audiences').select(baselineColumns).eq('ad_account_id', adAccountDbId)
      if (!baseline.error) {
        rows = (baseline.data ?? []) as CustomAudienceRow[]
        schema = 'baseline'
      }
    } catch { /* return explicit unavailable health below */ }
  }

  if (rows === null || schema === null) {
    return {
      rows: {},
      read: {
        read_available: false,
        schema: null,
        row_count: null,
        reason_code: 'custom_audiences_read_failed',
        reason: 'Both rich and baseline custom-audience inventory reads failed.',
      },
    }
  }


  let snapshot: CustomAudienceInventorySnapshot | null = null
  try {
    const health = await db
      .from('app_settings')
      .select('value')
      .eq('ad_account_id', adAccountDbId)
      .eq('key', 'custom_audience_inventory_health')
      .maybeSingle()
    if (health.error) throw health.error
    const parsed = typeof health.data?.value === 'string'
      ? JSON.parse(health.data.value) as unknown
      : health.data?.value
    snapshot = parsed && typeof parsed === 'object'
      ? parsed as CustomAudienceInventorySnapshot
      : null
  } catch { /* explicit unavailable result below */ }

  const completedAt = typeof snapshot?.completed_at === 'string' ? snapshot.completed_at : null
  const completedMs = completedAt ? Date.parse(completedAt) : Number.NaN
  const rowCount = Number(snapshot?.row_count)
  const snapshotAgeHours = (Date.now() - completedMs) / 3_600_000
  const rowsMatchHead = Number.isSafeInteger(rowCount) && rowCount === rows.length
  const accountMatchesHead = metaAccountId === null || snapshot?.meta_account_id === metaAccountId
  const rowsMatchTimestamp = rows.every((row) => (
    typeof row.last_synced_at === 'string'
    && Date.parse(row.last_synced_at) === completedMs
  ))
  if (snapshot?.complete !== true
      || !Number.isFinite(completedMs)
      || snapshotAgeHours < 0
      || snapshotAgeHours > TARGETING_STALE_HOURS
      || !rowsMatchHead
      || !accountMatchesHead
      || !rowsMatchTimestamp) {
    return {
      rows: {},
      read: {
        read_available: false,
        schema: null,
        row_count: null,
        reason_code: 'custom_audience_snapshot_unavailable',
        reason: 'The custom-audience rows do not match one recent, complete, account-scoped inventory snapshot.',
      },
    }
  }

  const inventory: Record<string, AudienceRef> = {}
  for (const row of rows) {
    inventory[row.audience_id] = {
      id: row.audience_id,
      name: row.name,
      subtype: row.subtype,
      accountId: row.meta_account_id,
      sourceAudienceId: row.source_audience_id ?? null,
      sourceAudienceName: row.source_audience_name ?? null,
      approximateCountLowerBound: row.approximate_count_lower_bound ?? null,
      approximateCountUpperBound: row.approximate_count_upper_bound ?? null,
      retentionDays: row.retention_days ?? null,
      operationStatus: row.operation_status ?? null,
      deliveryStatus: row.delivery_status ?? null,
      lastSyncedAt: row.last_synced_at ?? null,
    }
  }
  return {
    rows: inventory,
    read: {
      read_available: true,
      schema,
      row_count: rows.length,
      reason_code: null,
      reason: null,
    },
  }
}

async function fetchRequiredDatasetStats(adAccountDbId: string): Promise<DatasetStatsResult> {
  try {
    return await requireCapability(getAdPlatform('meta'), 'datasetDiagnostics').fetchEventVolume({ adAccountDbId })
  } catch {
    throw new LaunchPerformanceUnavailableError('dataset_stats')
  }
}

function liveEnrichmentDisabled(): DatasetStatsResult {
  return {
    available: false,
    reason: 'Live Meta enrichment is disabled for this owner surface.',
    datasetId: null,
    windowDays: 0,
    events: [],
  }
}

/**
 * IMPURE: gather the active launch cohort's delivery + the site-wide event volume, then build the
 * diagnosis. Read-only. A successful empty read is a real no-delivery diagnosis. A required-source
 * failure throws LaunchPerformanceUnavailableError so callers can preserve the section as unavailable.
 */
export async function diagnoseLaunchPerformance(opts?: {
  adAccountDbId?: string
  /** Meta account id for cross-account audience ownership checks. */
  metaAccountId?: string
  windowDays?: number
  /** Explicit persisted-report bounds. When absent, preserve the rolling live-dashboard window. */
  window?: { from: string; to: string }
  /** Owner pages surface warehouse evidence only and must not add live Meta or GA4 calls. */
  includeLiveEnrichment?: boolean
}): Promise<LaunchPerformanceDiagnosis> {
  const today = nyToday()
  const since = opts?.window?.from ?? nyDaysAgo(opts?.windowDays ?? 30)
  const until = opts?.window?.to ?? today
  const includeLiveEnrichment = opts?.includeLiveEnrichment !== false
  const writeModeEnabled = process.env.WRITE_MODE_ENABLED === 'true'
  const empty: LaunchPerformanceBuildInput = {
    today,
    window: { from: since, to: until },
    budgetControl: 'unknown',
    adsets: [],
    eventVolume: { available: false, reason: null, datasetId: null, windowDays: 0, events: [] },
    writeModeEnabled,
  }

  try {
    let db: ReturnType<typeof getAdminClient>
    try {
      db = getAdminClient()
    } catch {
      throw new LaunchPerformanceUnavailableError('admin_client')
    }
    let accountId = opts?.adAccountDbId ?? null
    let metaAccountId = opts?.metaAccountId ?? null
    if (!accountId) {
      const { data: acct, error: accountError } = await db
        .from('ad_accounts')
        .select('id, account_id')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
      if (accountError) throw new LaunchPerformanceUnavailableError('ad_accounts')
      accountId = (acct?.id as string | undefined) ?? null
      metaAccountId = (acct?.account_id as string | undefined) ?? metaAccountId
    } else if (!metaAccountId) {
      try {
        const { data: acct } = await db
          .from('ad_accounts')
          .select('account_id')
          .eq('id', accountId)
          .maybeSingle()
        metaAccountId = (acct?.account_id as string | undefined) ?? null
      } catch { /* optional for legacy pure/dashboard callers; unresolved ownership freezes */ }
    }
    if (!accountId) return buildLaunchPerformance(empty)

    // Active ad sets (delivery truth) for this account. Delivery sub-status is optional enrichment:
    // older production schemas can lack those columns, but that must not block the core diagnosis.
    const adsetRows = await fetchActiveAdsets(db, accountId)
    if (adsetRows.length === 0) {
      const eventVolume = includeLiveEnrichment
        ? await fetchRequiredDatasetStats(accountId)
        : liveEnrichmentDisabled()
      return buildLaunchPerformance({ ...empty, eventVolume })
    }

    const dbIds = adsetRows.map((a) => a.id)
    const { data: insData, error: insightsError } = await db
      .from('daily_insights')
      .select('adset_id, date_start, spend, impressions, reach, clicks, link_clicks, bookings')
      .eq('ad_account_id', accountId)
      .eq('entity_level', 'adset')
      .gte('date_start', since)
      .lte('date_start', until)
      .in('adset_id', dbIds)
    if (insightsError) throw new LaunchPerformanceUnavailableError('daily_insights')
    const insights = (insData ?? []) as InsightRow[]
    const audienceInventory = await fetchAudienceInventory(db, accountId, metaAccountId)

    const byAdset = new Map<string, InsightRow[]>()
    for (const r of insights) {
      if (!r.adset_id) continue
      const arr = byAdset.get(r.adset_id) ?? []
      arr.push(r)
      byAdset.set(r.adset_id, arr)
    }

    // Optional per-ad-set delivery-estimate MAU bounds (live Graph call) — best-effort, per-set
    // isolation, skipped entirely without a token. Labeled downstream; never Ads Manager's bucket.
    const mauByAdsetId = new Map<string, { lower: number; upper: number }>()
    if (includeLiveEnrichment && process.env.META_ACCESS_TOKEN) {
      await Promise.all(
        adsetRows.map(async (a) => {
          if (!a.adset_id) return
          try {
            const est = await requireCapability(getAdPlatform('meta'), 'deliveryEstimate').fetch(a.adset_id)
            if (est.available) mauByAdsetId.set(a.adset_id, { lower: est.mau_lower, upper: est.mau_upper })
          } catch { /* optional signal — never blocks the diagnosis */ }
        }),
      )
    }

    const adsets: AdsetDiagnosticInput[] = adsetRows.map((a) => {
      const rows = byAdset.get(a.id) ?? []
      const sum = (f: (r: InsightRow) => number) => rows.reduce((s, r) => s + f(r), 0)
      return {
        ...(a.adset_id ? { id: a.adset_id } : {}),
        name: a.adset_name ?? '(unnamed ad set)',
        optimizationEvent: resolveObservedOptimizationEvent(a.optimization_goal, a.promoted_object),
        optimizationGoal: a.optimization_goal,
        learningStage: a.learning_stage,
        learningConversions: a.learning_conversions,
        lastSigEditTs: a.last_sig_edit_ts,
        targeting: a.targeting,
        targetingSyncedAt: a.targeting_last_synced_at,
        targetingRelaxation: a.targeting_optimization_types,
        deliverySubStatus: normalizePersistedDeliverySubStatus(
          a.delivery_sub_status,
          a.delivery_sub_status_read_available,
          a.delivery_sub_status_synced_at,
        ),
        mauBounds: a.adset_id ? mauByAdsetId.get(a.adset_id) ?? null : null,
        dailyBudget: a.daily_budget,
        dataWindowStart: since,
        days: rows.map((r) => ({ date: r.date_start, spend: Number(r.spend ?? 0) })),
        spend: sum((r) => Number(r.spend ?? 0)),
        impressions: sum((r) => Number(r.impressions ?? 0)),
        reach: sum((r) => Number(r.reach ?? 0)),
        clicks: sum((r) => Number(r.clicks ?? 0)),
        linkClicks: sum((r) => Number(r.link_clicks ?? 0)),
        bookings: sum((r) => Number(r.bookings ?? 0)),
      }
    })
    // Only ad sets that actually delivered in the window.
    const delivering = adsets.filter((s) => s.spend > 0)

    // Campaign-budget metadata is optional for this diagnostic section. A failed read must degrade
    // the concentration interpretation to UNKNOWN, never fail the complete diagnosis.
    let campaignBudgetById: Map<string, CampaignBudgetRow> | null = null
    try {
      const campaignIds = [...new Set(adsetRows.map((a) => a.campaign_id))]
      const { data: campaignData, error: campaignError } = await db
        .from('campaigns')
        .select('id, daily_budget, lifetime_budget')
        .eq('ad_account_id', accountId)
        .in('id', campaignIds)
      if (!campaignError) {
        const rows = (campaignData ?? []) as CampaignBudgetRow[]
        campaignBudgetById = new Map(rows.map((row) => [row.id, row]))
      }
    } catch { /* optional signal — concentration remains UNKNOWN */ }

    const deliveringIds = new Set(
      adsetRows
        .filter((row) => (byAdset.get(row.id) ?? []).some((insight) => Number(insight.spend ?? 0) > 0))
        .map((row) => row.id),
    )
    const controls = adsetRows
      .filter((row) => deliveringIds.has(row.id))
      .map((row): BudgetControl => {
        const campaign = campaignBudgetById?.get(row.campaign_id)
        if (!campaign) return 'unknown'
        if ((campaign.daily_budget ?? 0) > 0 || (campaign.lifetime_budget ?? 0) > 0) return 'campaign'
        if ((row.daily_budget ?? 0) > 0 || (row.lifetime_budget ?? 0) > 0) return 'adset'
        return 'unknown'
      })
    const budgetControl: BudgetControl = controls.includes('unknown')
      ? 'unknown'
      : new Set(controls).size > 1
        ? 'mixed'
        : controls[0] ?? 'unknown'

    const eventVolume = includeLiveEnrichment
      ? await fetchRequiredDatasetStats(accountId)
      : liveEnrichmentDisabled()
    // Authoritative conversion-event rate from GA4 (reconciles with the outcome ledger): 28 CLOSED days ÷ 4 weeks.
    // (Ending at nyToday() made a 29-day span incl. a partial day — diluted the /week rate ~3.5% low,
    // and this rate feeds the structurally_starved-vs-healthy verdict.)
    let conversionEventPerWeek: number | undefined
    if (includeLiveEnrichment) {
      try {
        const ga = await getGa4ConfirmationTelemetryBySource(nyDaysAgo(28), nyDaysAgo(1))
        // This one genuinely wants an EVENT rate (optimization-event volume for the learning phase),
        // not a booking count, so confirmation events are the right input here.
        if (ga.available) conversionEventPerWeek = (ga.paid.confirmationEvents + ga.organic.confirmationEvents) / 4
      } catch { /* GA4 optional — fall back to pixel stats */ }
    }
    return buildLaunchPerformance({
      today,
      window: { from: since, to: until },
      budgetControl,
      metaAccountId: metaAccountId ?? '__unresolved_account__',
      audiencesById: audienceInventory.read.read_available ? audienceInventory.rows : undefined,
      audienceInventory: audienceInventory.read,
      adsets: delivering,
      eventVolume,
      conversionEventPerWeek,
      writeModeEnabled,
    })
  } catch (err) {
    if (err instanceof LaunchPerformanceUnavailableError) throw err
    throw new LaunchPerformanceUnavailableError('gatherer')
  }
}
