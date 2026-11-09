import { poissonCountCI } from '@/lib/learning/model'
import type { ExecutiveEvidenceSnapshotV1 } from '@/lib/report/executive-evidence'
import { formatMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export type PacingBand = 'green' | 'yellow' | 'orange' | 'red' | 'unavailable'

export function pacingBand(spend: number, target: number | null): PacingBand {
  if (target === null || !Number.isFinite(target) || target <= 0 || !Number.isFinite(spend)) return 'unavailable'
  const offPct = Math.abs((spend - target) / target) * 100
  if (offPct <= 4) return 'green'
  if (offPct <= 10) return 'yellow'
  if (offPct <= 15) return 'orange'
  return 'red'
}

/** Structurally typed so the pacing renderings can live beside the band formula they render. */
export interface DigestPacing { spend: number | null; target: number | null; band: PacingBand }

/** Legacy V2 caveat shared by both persisted renderings. */
export const PACING_TARGET_CAVEAT =
  'Target is read from your current budget settings, which may have changed since.'

/** Legacy V2 shared pacing guard. */
export function reportablePacing(pacing: DigestPacing): { spend: number; target: number } | null {
  if (pacing.band === 'unavailable' || !isUsable(pacing.spend) || !isUsable(pacing.target)) return null
  return { spend: pacing.spend, target: pacing.target }
}

/** The other half of the aligned guard: one copy of the unverified sentence for both renderings. */
export function pacingUnverifiedSentence(pacing: DigestPacing): string {
  const spendText = isUsable(pacing.spend) ? `${formatMoney(pacing.spend)}` : 'unavailable'
  return `Spend ${spendText} — no usable active daily budget target was read, so pacing is unverified.`
}

/** Plain sentences, as every structured digest array is: bullets belong to the renderers. */
export function pacingLines(pacing: DigestPacing): string[] {
  const reportable = reportablePacing(pacing)
  if (reportable === null) return [pacingUnverifiedSentence(pacing)]
  return [
    `Spend ${formatMoney(reportable.spend)} against a ${formatMoney(reportable.target)} daily budget target — pacing ${pacing.band}.`,
    PACING_TARGET_CAVEAT,
  ]
}

export const WEEKLY_SPEND_CONTEXT_UNAVAILABLE =
  'Weekly budget comparison unavailable — no exact budget-effective interval was provided for the trailing seven-day window.'

export function unclassifiedSpendContextLines(pacing: DigestPacing): string[] {
  const spend = isUsable(pacing.spend) ? `${formatMoney(pacing.spend)}` : 'unavailable'
  return [`Reported-day spend: ${spend}.`, WEEKLY_SPEND_CONTEXT_UNAVAILABLE]
}

interface BudgetEntityStatus {
  status: string | null
  /** Meta's DELIVERY status. Absent on legacy rows; null when Meta returned none. */
  effective_status?: string | null
}
interface BudgetCampaign extends BudgetEntityStatus { id: string; status: string; daily_budget: number | null }
interface BudgetAdset extends BudgetEntityStatus { campaign_id: string; daily_budget: number | null }

/**
 * `effective_status` is what predicts whether an entity can spend: it already folds in parent
 * pauses, disapprovals and schedule state, none of which move the configured `status`. It is
 * therefore preferred wherever it was read, and `status` is the fallback for rows that carry none.
 */
function resolvedStatus(entity: BudgetEntityStatus): string | null {
  const effective = entity.effective_status
  if (typeof effective === 'string' && effective.trim().length > 0) return effective
  return entity.status
}

function isActiveEntity(entity: BudgetEntityStatus): boolean {
  const status = resolvedStatus(entity)
  return status !== null && status.toUpperCase() === 'ACTIVE'
}

/**
 * Caller contract: pass ALL campaigns and ALL ad sets for the account. Campaigns are keyed by
 * `Campaign.id` (the DB uuid primary key) — NOT `Campaign.campaign_id`, which holds the Meta id —
 * and ad sets are matched to their campaign via `AdSet.campaign_id`, the FK to that same uuid.
 * Ad sets whose campaign_id has no matching campaign, or whose campaign is not ACTIVE, are
 * correctly ignored: they never reach the per-campaign loop below.
 *
 * CBO campaigns budget at campaign level; ABO campaigns budget at ad-set level (fallback).
 */
export function sumDailyBudgetTarget(campaigns: BudgetCampaign[], adsets: BudgetAdset[]): number | null {
  let total = 0
  let found = false
  const countedCampaignIds = new Set<string>()
  for (const c of campaigns) {
    if (!isActiveEntity(c)) continue
    if (countedCampaignIds.has(c.id)) continue // duplicate campaign row: already counted, skip
    countedCampaignIds.add(c.id)
    const own = adsets.filter((s) => s.campaign_id === c.id)
    if (c.daily_budget !== null && c.daily_budget > 0) {
      // A campaign-level (CBO) budget only funds delivery when something under it can actually
      // spend. An ACTIVE campaign whose ad sets are ALL paused spends $0, so counting its budget
      // inflated the target, pushed pacing red, and put "Needs attention" on the banner on a day
      // the owner had merely paused a campaign's ad sets.
      if (own.some(isActiveEntity)) {
        total += c.daily_budget
        found = true
        continue
      }
      // Same honesty rule as the ABO branch: with no ACTIVE ad set found and at least one whose
      // status is unreadable, this campaign's contribution is unknowable, not zero.
      if (own.some((s) => resolvedStatus(s) === null)) return null
      continue
    }
    // ABO fallback: sum this campaign's ACTIVE ad-set budgets. AdSet.status is nullable — a null
    // status means we cannot tell whether that ad set is active, so the account-wide target
    // becomes unverifiable. An honest 'unavailable' (null) beats a confidently wrong number, so
    // bail out for the WHOLE account rather than silently under-counting.
    let campaignTotal = 0
    let campaignFound = false
    for (const s of own) {
      const status = resolvedStatus(s)
      if (status === null) return null
      if (status.toUpperCase() !== 'ACTIVE') continue
      if (s.daily_budget !== null && s.daily_budget > 0) {
        campaignTotal += s.daily_budget
        campaignFound = true
      }
    }
    if (campaignFound) {
      total += campaignTotal
      found = true
    }
  }
  return found ? total : null
}

// Single source of truth for the change-reporting threshold: a later task must update
// daily-digest.ts to import this instead of keeping its own private copy of 20.
export const RATE_THRESHOLD_PCT = 20

export type DeltaState = 'no_baseline' | 'within_noise' | 'significant'
export interface GatedDelta { delta_pct: number | null; noise_gated: boolean; state: DeltaState }

function pct(current: number, baseline: number): number {
  return ((current - baseline) / baseline) * 100
}

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

export function gateRateDelta(current: number | null, baseline: number | null): GatedDelta {
  if (!isUsable(current) || !isUsable(baseline) || baseline === 0) {
    return { delta_pct: null, noise_gated: true, state: 'no_baseline' }
  }
  const delta = pct(current, baseline)
  const state: DeltaState = Math.abs(delta) < RATE_THRESHOLD_PCT ? 'within_noise' : 'significant'
  return { delta_pct: delta, noise_gated: state !== 'significant', state }
}

/** Poisson gate for low-volume daily counts (leads, bookings): a delta is 'significant' only when
 *  the two 1.645σ confidence intervals are FULLY disjoint. This is deliberately conservative for a
 *  daily pulse on a low-volume account — biased toward reporting "no verdict" (within_noise) over
 *  asserting a false directional verdict. */
export function gateCountDelta(current: number | null, baseline: number | null): GatedDelta {
  if (!isUsable(current) || !isUsable(baseline) || baseline === 0) {
    return { delta_pct: null, noise_gated: true, state: 'no_baseline' }
  }
  const a = poissonCountCI(current)
  const b = poissonCountCI(baseline)
  const disjoint = a.lo > b.hi || b.lo > a.hi
  const state: DeltaState = disjoint ? 'significant' : 'within_noise'
  return { delta_pct: pct(current, baseline), noise_gated: state !== 'significant', state }
}

/** Persisted V2 compatibility only. V3 has no composite stoplight. */
export type StoplightStatus = 'green' | 'amber' | 'red'

/** The delivery diagnosis as the digest sees it. 'unknown' covers an absent or unreadable verdict:
 *  an undetermined diagnosis is never treated as a healthy one. */
export type DeliveryVerdict = 'healthy' | 'too_early' | 'still_learning' | 'structurally_starved' | 'unknown'

export type DigestBusinessState = 'higher' | 'lower' | 'mixed' | 'stable' | 'insufficient_evidence' | 'unavailable'
export type DigestPaidDeliveryState = 'improving' | 'declining' | 'mixed' | 'stable' | 'insufficient_evidence' | 'unavailable'
export type DigestDataConfidenceState = 'complete' | 'degraded' | 'unavailable'

export interface DigestDescriptiveStates {
  business: { state: DigestBusinessState; line: string }
  paid_delivery: { state: DigestPaidDeliveryState; line: string }
  data_confidence: { state: DigestDataConfidenceState; line: string }
}

type EvidenceRecord = Record<string, unknown>

function recordOf(value: unknown): EvidenceRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as EvidenceRecord
    : null
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function noBlockers(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function sourceAvailable(value: unknown): boolean {
  const source = recordOf(value)
  return source?.availability === 'available' && noBlockers(source.blockerCodes)
}

function isoDay(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(timestamp) ? timestamp : null
}

function isCompleteSevenDayWindow(value: unknown): boolean {
  const window = recordOf(value)
  if (window?.availability !== 'available' || !noBlockers(window.blockerCodes)) return false
  const start = isoDay(window.startDate)
  const end = isoDay(window.endDate)
  return start !== null && end !== null && ((end - start) / 86_400_000) + 1 === 7
}

function evidenceWindowFacts(snapshot: EvidenceRecord, source: 'outcomes' | 'meta', window: 'trailing7' | 'prior7') {
  const evidence = recordOf(snapshot[source])
  const byWindow = recordOf(evidence?.byWindow)
  return recordOf(byWindow?.[window])
}

type CompleteOutcomeFacts = EvidenceRecord & {
  activeAppointments: number
  activeAmountPaidRevenue: number
  amountPaidCoverage: EvidenceRecord & { withRecordedAmount: number; total: number }
}

function amountPaidComplete(facts: EvidenceRecord): facts is CompleteOutcomeFacts {
  const coverage = recordOf(facts.amountPaidCoverage)
  return finiteNonNegative(facts.activeAppointments)
    && finiteNonNegative(facts.activeAmountPaidRevenue)
    && finiteNonNegative(coverage?.withRecordedAmount)
    && finiteNonNegative(coverage?.total)
    && coverage?.withRecordedAmount === coverage?.total
}

function businessUnavailable(line: string): DigestDescriptiveStates['business'] {
  return { state: 'unavailable', line }
}

function deriveBusinessState(snapshot: EvidenceRecord): DigestDescriptiveStates['business'] {
  const windows = recordOf(snapshot.windows)
  const current = evidenceWindowFacts(snapshot, 'outcomes', 'trailing7')
  const prior = evidenceWindowFacts(snapshot, 'outcomes', 'prior7')
  if (current === null || prior === null) {
    return businessUnavailable('Business: unavailable — complete outcome evidence was not available for both seven-day windows.')
  }
  if (
    !amountPaidComplete(current)
    || !amountPaidComplete(prior)
  ) {
    return businessUnavailable(`Business: unavailable — amount paid on currently active ${OW.many} is incomplete or malformed.`)
  }
  if (!isCompleteSevenDayWindow(windows?.trailing7) || !isCompleteSevenDayWindow(windows?.prior7)) {
    return {
      state: 'insufficient_evidence',
      line: 'Business: insufficient evidence — both complete seven-day windows are required before applying the diagnostic reporting thresholds.',
    }
  }
  if (prior.activeAppointments === 0 || prior.activeAmountPaidRevenue === 0) {
    return {
      state: 'insufficient_evidence',
      line: `Business: insufficient evidence — the prior seven-day ${OW.one} or active-${OW.one} amount-paid baseline is zero.`,
    }
  }

  const bookings = gateCountDelta(current.activeAppointments, prior.activeAppointments)
  const amountPaid = gateRateDelta(current.activeAmountPaidRevenue, prior.activeAmountPaidRevenue)
  const bookingDirection = Math.sign(bookings.delta_pct ?? 0)
  const amountDirection = Math.sign(amountPaid.delta_pct ?? 0)
  if (bookings.state === 'significant' && amountPaid.state === 'significant' && bookingDirection === amountDirection) {
    if (bookingDirection > 0) {
      return {
        state: 'higher',
        line: `Business: higher — active ${OW.many} and amount paid on currently active ${OW.many} were both above the prior seven-day window beyond diagnostic reporting thresholds.`,
      }
    }
    return {
      state: 'lower',
      line: `Business: lower — active ${OW.many} and amount paid on currently active ${OW.many} were both below the prior seven-day window beyond diagnostic reporting thresholds.`,
    }
  }
  if (bookings.state === 'within_noise' && amountPaid.state === 'within_noise') {
    return {
      state: 'stable',
      line: `Business: stable — neither active ${OW.many} nor amount paid on currently active ${OW.many} crossed its diagnostic reporting threshold.`,
    }
  }
  return {
    state: 'mixed',
    line: `Business: mixed — active ${OW.many} and amount paid on currently active ${OW.many} did not move together beyond the diagnostic reporting thresholds.`,
  }
}

type Direction = 'improving' | 'declining' | 'stable'

function rateDirection(delta: GatedDelta, lowerIsBetter: boolean): Direction {
  if (delta.state !== 'significant' || delta.delta_pct === null) return 'stable'
  const increased = delta.delta_pct > 0
  return increased === lowerIsBetter ? 'declining' : 'improving'
}

type CompleteMetaFacts = EvidenceRecord & {
  spendAmount: number
  impressions: number
  linkClicks: number
  landingPageViews: number
}

function validMetaFacts(facts: EvidenceRecord): facts is CompleteMetaFacts {
  return finiteNonNegative(facts.spendAmount)
    && finiteNonNegative(facts.impressions)
    && finiteNonNegative(facts.linkClicks)
    && finiteNonNegative(facts.landingPageViews)
    && facts.linkClicks <= facts.impressions
}

function derivePaidDeliveryState(snapshot: EvidenceRecord): DigestDescriptiveStates['paid_delivery'] {
  const windows = recordOf(snapshot.windows)
  const current = evidenceWindowFacts(snapshot, 'meta', 'trailing7')
  const prior = evidenceWindowFacts(snapshot, 'meta', 'prior7')
  if (
    current === null
    || prior === null
    || !validMetaFacts(current)
    || !validMetaFacts(prior)
    || !isCompleteSevenDayWindow(windows?.trailing7)
    || !isCompleteSevenDayWindow(windows?.prior7)
  ) {
    return {
      state: 'unavailable',
      line: 'Paid delivery: unavailable — complete Meta evidence was not available for both seven-day windows.',
    }
  }
  if (
    current.spendAmount <= 0
    || prior.spendAmount <= 0
    || current.landingPageViews < 20
    || prior.landingPageViews < 20
    || current.impressions < 1_000
    || prior.impressions < 1_000
  ) {
    return {
      state: 'insufficient_evidence',
      line: 'Paid delivery: insufficient evidence — the diagnostic minimum is positive spend, 20 landing-page views, and 1,000 impressions in each complete seven-day window.',
    }
  }

  const currentCostPerLpv = current.spendAmount / current.landingPageViews
  const priorCostPerLpv = prior.spendAmount / prior.landingPageViews
  const currentLinkCtr = (current.linkClicks / current.impressions) * 100
  const priorLinkCtr = (prior.linkClicks / prior.impressions) * 100
  const efficiency = rateDirection(gateRateDelta(currentCostPerLpv, priorCostPerLpv), true)
  const ctr = rateDirection(gateRateDelta(currentLinkCtr, priorLinkCtr), false)
  if (efficiency === 'stable' && ctr === 'stable') {
    return {
      state: 'stable',
      line: 'Paid delivery: stable — cost per landing-page view and link CTR stayed within diagnostic reporting thresholds.',
    }
  }
  if ((efficiency === 'improving' || ctr === 'improving') && efficiency !== 'declining' && ctr !== 'declining') {
    return {
      state: 'improving',
      line: 'Paid delivery: improving — cost per landing-page view and/or link CTR improved beyond a diagnostic reporting threshold with no significant opposing signal.',
    }
  }
  if ((efficiency === 'declining' || ctr === 'declining') && efficiency !== 'improving' && ctr !== 'improving') {
    return {
      state: 'declining',
      line: 'Paid delivery: declining — cost per landing-page view and/or link CTR declined beyond a diagnostic reporting threshold with no significant opposing signal.',
    }
  }
  return {
    state: 'mixed',
    line: 'Paid delivery: mixed — cost per landing-page view and link CTR moved in opposing directions beyond diagnostic reporting thresholds.',
  }
}

function allRequiredSourcesComplete(sources: EvidenceRecord): boolean {
  return [
    'setupChanges', 'outcomes', 'meta', 'metaColdWarm', 'metaPlacements',
    'tracking', 'capi', 'gaIdentity', 'paidCohort',
  ]
    .every((key) => sourceAvailable(sources[key]))
}

function completeCohort(value: unknown): boolean {
  const cohort = recordOf(value)
  const recentScale = recordOf(cohort?.recentScale)
  const maturedCut = recordOf(cohort?.maturedCut)
  return cohort?.complete === true
    && noBlockers(cohort.blockerCodes)
    && recentScale?.complete === true
    && noBlockers(recentScale.blockerCodes)
    && maturedCut?.complete === true
    && noBlockers(maturedCut.blockerCodes)
    && recordOf(cohort.exactPaidAssociation) !== null
}

function latestChangeKnown(snapshot: EvidenceRecord): boolean {
  const setup = recordOf(snapshot.setupChanges)
  const latest = recordOf(setup?.latest_material_change)
  const windows = recordOf(snapshot.windows)
  const postChange = recordOf(windows?.postChange)
  return setup?.complete === true
    && setup?.status === 'available'
    && noBlockers(setup.blocker_codes)
    && latest?.status === 'known'
    && typeof latest.reason === 'string'
    && latest.reason.trim().length > 0
    && typeof latest.materialChangeId === 'string'
    && latest.materialChangeId.length > 0
    && typeof latest.occurredAt === 'string'
    && Number.isFinite(Date.parse(latest.occurredAt))
    && postChange?.availability === 'available'
    && typeof postChange.changeId === 'string'
    && postChange.changeId === latest.materialChangeId
    && noBlockers(postChange.blockerCodes)
}

function deriveDataConfidenceState(snapshot: EvidenceRecord): DigestDescriptiveStates['data_confidence'] {
  const sources = recordOf(snapshot.sources)
  const currentOutcome = evidenceWindowFacts(snapshot, 'outcomes', 'trailing7')
  const priorOutcome = evidenceWindowFacts(snapshot, 'outcomes', 'prior7')
  const currentMeta = evidenceWindowFacts(snapshot, 'meta', 'trailing7')
  const priorMeta = evidenceWindowFacts(snapshot, 'meta', 'prior7')
  if (
    sources === null
    || recordOf(snapshot.outcomes) === null
    || recordOf(snapshot.meta) === null
    || currentOutcome === null || !amountPaidComplete(currentOutcome)
    || priorOutcome === null || !amountPaidComplete(priorOutcome)
    || currentMeta === null || !validMetaFacts(currentMeta)
    || priorMeta === null || !validMetaFacts(priorMeta)
    || recordOf(sources.outcomes)?.availability === 'unavailable'
    || recordOf(sources.meta)?.availability === 'unavailable'
  ) {
    return {
      state: 'unavailable',
      line: 'Data confidence: unavailable — core outcome-source or Meta evidence is absent or malformed.',
    }
  }

  const complete = allRequiredSourcesComplete(sources)
    && noBlockers(snapshot.blockerCodes)
    && recordOf(snapshot.tracking) !== null
    && recordOf(snapshot.capi) !== null
    && recordOf(snapshot.gaIdentity) !== null
    && recordOf(snapshot.metaColdWarm) !== null
    && recordOf(snapshot.metaPlacements) !== null
    && completeCohort(snapshot.paidCohort)
    && latestChangeKnown(snapshot)
  return complete
    ? {
        state: 'complete',
        line: 'Data confidence: complete — every required evidence source and paid-cohort check is available with no unresolved blocker.',
      }
    : {
        state: 'degraded',
        line: 'Data confidence: degraded — at least one required source, cohort check, blocker, or material-change reason is incomplete.',
      }
}

/**
 * Pure containment adapter: the executive snapshot is the only input. Pacing and daily KPI movement
 * are deliberately absent, so neither can silently become an account-wide verdict.
 */
export function deriveDigestDescriptiveStates(
  evidence: ExecutiveEvidenceSnapshotV1 | null | undefined,
): DigestDescriptiveStates {
  const snapshot = recordOf(evidence)
  if (snapshot === null) {
    return {
      business: businessUnavailable('Business: unavailable — the executive evidence snapshot was not available.'),
      paid_delivery: { state: 'unavailable', line: 'Paid delivery: unavailable — the executive evidence snapshot was not available.' },
      data_confidence: { state: 'unavailable', line: 'Data confidence: unavailable — the executive evidence snapshot was not available.' },
    }
  }
  return {
    business: deriveBusinessState(snapshot),
    paid_delivery: derivePaidDeliveryState(snapshot),
    data_confidence: deriveDataConfidenceState(snapshot),
  }
}
