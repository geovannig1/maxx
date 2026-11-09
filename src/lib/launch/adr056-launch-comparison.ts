import { roundMoney } from '@/lib/utils/format-currency'
import { etDateOf } from '@/lib/utils/date-utils'

/** Legacy display marker only; treatment membership never resolves from an ad name. */
export const ADR056_AD_NAME_MARKER = '(ADR-056 tagged)'

/**
 * ADR-056 treatment membership is a versioned immutable Meta-ID cohort. Names remain display
 * metadata only; renaming an ad must never rewrite historical launch evidence.
 */
export const ADR056_COHORT_VERSION = 'adr-056-v1'
export const ADR056_TAGGED_META_AD_IDS = [
  '100000000000000013',
  '100000000000000014',
  '100000000000000015',
  '100000000000000016',
] as const

export interface Adr056AdRow {
  id: string
  ad_id: string
  adset_id?: string | null
  ad_name: string | null
  meta_creative_id: string | null
  meta_created_time: string | null
  meta_updated_time: string | null
  effective_status: string | null
}

export interface Adr056InsightRow {
  ad_id: string | null
  date_start: string
  spend: number | string | null
  impressions: number | string | null
  clicks: number | string | null
  link_clicks: number | string | null
  landing_page_views: number | string | null
  bookings: number | string | null
  bookings_view_through: number | string | null
}

export interface Adr056CohortMetrics {
  spend: number
  impressions: number
  clicks: number
  linkClicks: number
  landingPageViews: number
  /** Meta's modelled AppointmentConfirmed Results column, not business bookings. */
  metaResults: number
  clickResults: number | null
  viewResults: number | null
  attributionSplitAvailable: boolean
  metaCostPerResult: number | null
  nativePeriodReach: null
  nativePeriodFrequency: null
  appointmentValue: null
  exactPaidCpa: null
  exactPaidRoas: null
}

export interface Adr056ResolvedAd {
  databaseId: string
  metaAdId: string
  name: string
  creativeId: string
  audience: 'warm_mixed' | 'cold'
  effectiveStatus: string | null
  createdAt: string | null
  updatedAt: string | null
}

interface AudienceSummary {
  label: string
  metrics: Adr056CohortMetrics
}

interface CohortSummary {
  warm: AudienceSummary
  cold: AudienceSummary
  combined: AudienceSummary
}

interface DatedWindow {
  from: string | null
  to: string | null
  days: number
}

export interface Adr056LaunchComparison {
  status: 'available' | 'partial' | 'unavailable'
  blockers: string[]
  missingAccountInsightDates: string[]
  source: {
    system: 'Meta daily warehouse'
    role: 'delivery_and_modelled_attribution'
    lastSyncedAt: string | null
  }
  provenance: {
    treatment: {
      basis: 'immutable_meta_ad_ids'
      cohortVersion: typeof ADR056_COHORT_VERSION
      metaAdIds: string[]
    }
    audience: {
      warm: 'ad_name_derived'
      cold: 'ad_name_derived'
    }
    window: {
      mode: 'canonical_launch_as_of'
      requested: { from: string | null; to: string }
      selectedFromApplied: false
      selectedToAppliedAsOfDate: true
    }
  }
  boundary: {
    launchDate: string | null
    firstCleanTaggedDate: string | null
    launchDateIsMixed: boolean
  }
  windows: {
    previous: { from: string | null; to: string | null }
    launchDay: { from: string | null; to: string | null }
    tagged: { from: string | null; to: string | null }
  }
  taggedAds: Adr056ResolvedAd[]
  predecessorAds: Adr056ResolvedAd[]
  previous: CohortSummary
  tagged: CohortSummary
  launchDay: {
    previous: AudienceSummary
    tagged: AudienceSummary
  }
  matched?: {
    windows: { previous: DatedWindow; tagged: DatedWindow }
    previous: CohortSummary
    tagged: CohortSummary
  }
  verdict?: {
    state: 'hold_investigate'
    label: 'HOLD / INVESTIGATE'
    financialConclusionAllowed: false
  }
  learning?: {
    status: 'available' | 'unavailable'
    states: string[]
  }
}

export type Adr056SourceGeneration =
  | { state: 'covered'; completedAt: string }
  | { state: 'uncovered' | 'read_failed'; completedAt: null }

const DAY_MS = 86_400_000

function addDays(value: string, days: number): string {
  const epoch = Date.parse(`${value}T00:00:00Z`)
  return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10)
}

function eachDate(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  const count = Math.floor((end - start) / DAY_MS) + 1
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * DAY_MS).toISOString().slice(0, 10),
  )
}

function number(value: number | string | null): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function validRequiredMetric(value: number | string | null): boolean {
  if (value === null || value === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function hasValidRequiredMetrics(row: Adr056InsightRow): boolean {
  return [
    row.spend,
    row.impressions,
    row.clicks,
    row.link_clicks,
    row.landing_page_views,
    row.bookings,
  ].every(validRequiredMetric)
}

function money(value: number): number {
  return roundMoney(value)
}

function emptyMetrics(): Adr056CohortMetrics {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    linkClicks: 0,
    landingPageViews: 0,
    metaResults: 0,
    clickResults: 0,
    viewResults: 0,
    attributionSplitAvailable: true,
    metaCostPerResult: null,
    nativePeriodReach: null,
    nativePeriodFrequency: null,
    appointmentValue: null,
    exactPaidCpa: null,
    exactPaidRoas: null,
  }
}

function summarize(
  insights: Adr056InsightRow[],
  adIds: Set<string>,
  from: string | null,
  to: string | null,
): Adr056CohortMetrics {
  if (!from || !to || to < from || adIds.size === 0) return emptyMetrics()
  const rows = insights.filter((row) =>
    row.ad_id !== null && adIds.has(row.ad_id) && row.date_start >= from && row.date_start <= to,
  )

  let spend = 0
  let impressions = 0
  let clicks = 0
  let linkClicks = 0
  let landingPageViews = 0
  let metaResults = 0
  let viewResults = 0
  let attributionSplitAvailable = true

  for (const row of rows) {
    const rowResults = number(row.bookings)
    const rowView = row.bookings_view_through === null
      ? null
      : number(row.bookings_view_through)
    spend += number(row.spend)
    impressions += number(row.impressions)
    clicks += number(row.clicks)
    linkClicks += number(row.link_clicks)
    landingPageViews += number(row.landing_page_views)
    metaResults += rowResults
    if (rowResults > 0) {
      if (rowView === null || rowView > rowResults) attributionSplitAvailable = false
      else viewResults += rowView
    }
  }

  const normalizedSpend = money(spend)
  return {
    spend: normalizedSpend,
    impressions,
    clicks,
    linkClicks,
    landingPageViews,
    metaResults,
    clickResults: attributionSplitAvailable ? metaResults - viewResults : null,
    viewResults: attributionSplitAvailable ? viewResults : null,
    attributionSplitAvailable,
    metaCostPerResult: metaResults > 0 ? money(normalizedSpend / metaResults) : null,
    // Daily rows cannot establish any of these. They stay unavailable even when other delivery
    // metrics are measured; callers must never substitute a daily sum or purchase-family value.
    nativePeriodReach: null,
    nativePeriodFrequency: null,
    appointmentValue: null,
    exactPaidCpa: null,
    exactPaidRoas: null,
  }
}

function audience(name: string): 'warm_mixed' | 'cold' {
  return /^warm\b/i.test(name.trim()) ? 'warm_mixed' : 'cold'
}

function resolvedAd(row: Adr056AdRow): Adr056ResolvedAd {
  const name = row.ad_name ?? row.ad_id
  return {
    databaseId: row.id,
    metaAdId: row.ad_id,
    name,
    creativeId: row.meta_creative_id ?? '',
    audience: audience(name),
    effectiveStatus: row.effective_status,
    createdAt: row.meta_created_time,
    updatedAt: row.meta_updated_time,
  }
}

function cohortSummary(
  insights: Adr056InsightRow[],
  ads: Adr056ResolvedAd[],
  from: string | null,
  to: string | null,
): CohortSummary {
  const warmIds = new Set(ads.filter((ad) => ad.audience === 'warm_mixed').map((ad) => ad.databaseId))
  const coldIds = new Set(ads.filter((ad) => ad.audience === 'cold').map((ad) => ad.databaseId))
  const allIds = new Set(ads.map((ad) => ad.databaseId))
  return {
    warm: { label: 'Warm / mixed audience', metrics: summarize(insights, warmIds, from, to) },
    cold: { label: 'Cold audience', metrics: summarize(insights, coldIds, from, to) },
    combined: { label: 'Combined', metrics: summarize(insights, allIds, from, to) },
  }
}

function unavailableComparison(
  blockers: string[],
  lastSyncedAt: string | null,
  input: {
    requestedFrom?: string | null
    lastClosedDate: string
    taggedMetaAdIds?: readonly string[]
  },
): Adr056LaunchComparison {
  const empty = cohortSummary([], [], null, null)
  return {
    status: 'unavailable',
    blockers,
    missingAccountInsightDates: [],
    source: {
      system: 'Meta daily warehouse',
      role: 'delivery_and_modelled_attribution',
      lastSyncedAt,
    },
    provenance: {
      treatment: {
        basis: 'immutable_meta_ad_ids',
        cohortVersion: ADR056_COHORT_VERSION,
        metaAdIds: [...(input.taggedMetaAdIds ?? ADR056_TAGGED_META_AD_IDS)].sort(),
      },
      audience: { warm: 'ad_name_derived', cold: 'ad_name_derived' },
      window: {
        mode: 'canonical_launch_as_of',
        requested: { from: input.requestedFrom ?? null, to: input.lastClosedDate },
        selectedFromApplied: false,
        selectedToAppliedAsOfDate: true,
      },
    },
    boundary: { launchDate: null, firstCleanTaggedDate: null, launchDateIsMixed: false },
    windows: {
      previous: { from: null, to: null },
      launchDay: { from: null, to: null },
      tagged: { from: null, to: null },
    },
    taggedAds: [],
    predecessorAds: [],
    previous: empty,
    tagged: empty,
    launchDay: { previous: empty.combined, tagged: empty.combined },
    matched: {
      windows: {
        previous: { from: null, to: null, days: 0 },
        tagged: { from: null, to: null, days: 0 },
      },
      previous: empty,
      tagged: empty,
    },
    verdict: {
      state: 'hold_investigate',
      label: 'HOLD / INVESTIGATE',
      financialConclusionAllowed: false,
    },
    learning: { status: 'unavailable', states: [] },
  }
}

export function buildAdr056LaunchComparison(input: {
  ads: Adr056AdRow[]
  insights: Adr056InsightRow[]
  accountInsightDates: string[]
  lastClosedDate: string
  lastSyncedAt: string | null
  /** Production evidence: a successful sync generation that covers the exact warehouse window. */
  sourceGeneration?: Adr056SourceGeneration
  /** Selected dashboard start date is retained as provenance, never used to redefine this cohort's canonical window. */
  requestedFrom?: string | null
  /** Production reader supplies the versioned immutable Meta-ID cohort. */
  taggedMetaAdIds?: readonly string[]
  /** Require a row or explicit zero for every cohort entity-day in each comparison window. */
  requireCompleteCohortCoverage?: boolean
  learningStates?: Array<string | null>
}): Adr056LaunchComparison {
  const taggedMetaAdIds = input.taggedMetaAdIds ?? ADR056_TAGGED_META_AD_IDS
  const expectedTaggedAdCount = taggedMetaAdIds.length
  const isTagged = (ad: Adr056AdRow) =>
    taggedMetaAdIds.includes(ad.ad_id)
  // Cohort membership is immutable historical identity. Current delivery status is context only;
  // pausing an ADR-056 ad later must not rewrite its launch history.
  const taggedRows = input.ads.filter((ad) => isTagged(ad))

  if (taggedRows.length !== expectedTaggedAdCount) {
    return unavailableComparison(['tagged_cohort_count_mismatch'], input.lastSyncedAt, {
      requestedFrom: input.requestedFrom,
      lastClosedDate: input.lastClosedDate,
      taggedMetaAdIds,
    })
  }

  const launchInstants = taggedRows
    .map((ad) => ad.meta_created_time)
    .filter((value): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)))
  if (launchInstants.length !== taggedRows.length) {
    return unavailableComparison(['tagged_launch_time_unavailable'], input.lastSyncedAt, {
      requestedFrom: input.requestedFrom,
      lastClosedDate: input.lastClosedDate,
      taggedMetaAdIds,
    })
  }

  const firstLaunchInstant = launchInstants.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
  const launchDate = etDateOf(firstLaunchInstant)
  if (!launchDate) return unavailableComparison(['tagged_launch_time_unavailable'], input.lastSyncedAt, {
    requestedFrom: input.requestedFrom,
    lastClosedDate: input.lastClosedDate,
    taggedMetaAdIds,
  })

  const predecessorRows: Adr056AdRow[] = []
  const predecessorBlockers: string[] = []
  for (const tagged of taggedRows) {
    const candidates = input.ads
      .filter((candidate) =>
        candidate.id !== tagged.id
        && !isTagged(candidate)
        && candidate.meta_creative_id !== null
        && candidate.meta_creative_id === tagged.meta_creative_id
        && Date.parse(candidate.meta_created_time ?? '') < Date.parse(tagged.meta_created_time ?? ''),
      )
      .sort((a, b) => Date.parse(b.meta_updated_time ?? '') - Date.parse(a.meta_updated_time ?? ''))
    if (candidates.length === 0) {
      predecessorBlockers.push(`predecessor_missing:${tagged.ad_id}`)
    } else if (candidates.length > 1) {
      predecessorBlockers.push(`predecessor_ambiguous:${tagged.ad_id}`)
    } else {
      predecessorRows.push(candidates[0])
    }
  }

  const taggedAds = taggedRows.map(resolvedAd).sort((a, b) => a.metaAdId.localeCompare(b.metaAdId))
  const predecessorAds = predecessorRows.map(resolvedAd).sort((a, b) => a.metaAdId.localeCompare(b.metaAdId))
  const firstCleanTaggedDate = addDays(launchDate, 1)
  const monthStart = `${launchDate.slice(0, 7)}-01`
  const previousEnd = addDays(launchDate, -1)

  const relevantAdIds = new Set([
    ...taggedAds.map((ad) => ad.databaseId),
    ...predecessorAds.map((ad) => ad.databaseId),
  ])
  const relevantInsights = input.insights.filter((row) =>
    row.ad_id !== null
    && relevantAdIds.has(row.ad_id)
    && row.date_start >= monthStart
    && row.date_start <= input.lastClosedDate,
  )
  if (relevantInsights.some((row) => !hasValidRequiredMetrics(row))) {
    return unavailableComparison(['invalid_insight_metric'], input.lastSyncedAt, {
      requestedFrom: input.requestedFrom,
      lastClosedDate: input.lastClosedDate,
      taggedMetaAdIds,
    })
  }
  const seenAdDays = new Set<string>()
  for (const row of relevantInsights) {
    const key = `${row.ad_id}:${row.date_start}`
    if (seenAdDays.has(key)) {
      return unavailableComparison(['duplicate_ad_insight_rows'], input.lastSyncedAt, {
        requestedFrom: input.requestedFrom,
        lastClosedDate: input.lastClosedDate,
        taggedMetaAdIds,
      })
    }
    seenAdDays.add(key)
  }

  const expectedDates = eachDate(monthStart, input.lastClosedDate)
  const observedDates = new Set(input.accountInsightDates)
  const missingAccountInsightDates = expectedDates.filter((date) => !observedDates.has(date))
  const lastSyncedDate = input.lastSyncedAt ? etDateOf(input.lastSyncedAt) : ''
  const freshnessBlockers = input.sourceGeneration
    ? input.sourceGeneration.state === 'covered'
      ? []
      : [input.sourceGeneration.state === 'read_failed'
        ? 'source_generation_read_failed'
        : 'source_generation_window_uncovered']
    : !lastSyncedDate
      ? ['source_freshness_unavailable']
      : lastSyncedDate <= input.lastClosedDate
        ? ['source_generation_not_post_window']
        : []
  const blockers = [
    ...predecessorBlockers,
    ...(missingAccountInsightDates.length > 0 ? ['account_insight_days_missing'] : []),
    ...freshnessBlockers,
    ...(input.lastClosedDate < firstCleanTaggedDate ? ['clean_tagged_window_not_observed'] : []),
  ]
  if (input.requireCompleteCohortCoverage) {
    const expectedCohortKeys = [
      ...predecessorAds.flatMap((ad) => eachDate(monthStart, previousEnd).map((date) => `${ad.databaseId}:${date}`)),
      ...taggedAds.flatMap((ad) => eachDate(firstCleanTaggedDate, input.lastClosedDate).map((date) => `${ad.databaseId}:${date}`)),
      ...predecessorAds.map((ad) => `${ad.databaseId}:${launchDate}`),
      ...taggedAds.map((ad) => `${ad.databaseId}:${launchDate}`),
    ]
    if (expectedCohortKeys.some((key) => !seenAdDays.has(key))) {
      blockers.push('cohort_ad_insight_days_missing')
    }
  }
  const status: Adr056LaunchComparison['status'] = blockers.length > 0 ? 'partial' : 'available'

  const previous = cohortSummary(input.insights, predecessorAds, monthStart, previousEnd)
  const tagged = cohortSummary(input.insights, taggedAds, firstCleanTaggedDate, input.lastClosedDate)
  const launchPrevious = cohortSummary(input.insights, predecessorAds, launchDate, launchDate)
  const launchTagged = cohortSummary(input.insights, taggedAds, launchDate, launchDate)
  const previousDays = eachDate(monthStart, previousEnd).length
  const taggedDays = eachDate(firstCleanTaggedDate, input.lastClosedDate).length
  const matchedDays = Math.min(previousDays, taggedDays)
  const matchedPreviousFrom = matchedDays > 0 ? addDays(previousEnd, -(matchedDays - 1)) : null
  const matchedTaggedTo = matchedDays > 0 ? addDays(firstCleanTaggedDate, matchedDays - 1) : null
  const normalizedLearningStates = [...new Set((input.learningStates ?? []).filter((state): state is string => Boolean(state)))].sort()

  return {
    status,
    blockers,
    missingAccountInsightDates,
    source: {
      system: 'Meta daily warehouse',
      role: 'delivery_and_modelled_attribution',
      lastSyncedAt: input.lastSyncedAt,
    },
    provenance: {
      treatment: {
        basis: 'immutable_meta_ad_ids',
        cohortVersion: ADR056_COHORT_VERSION,
        metaAdIds: [...taggedMetaAdIds].sort(),
      },
      audience: { warm: 'ad_name_derived', cold: 'ad_name_derived' },
      window: {
        mode: 'canonical_launch_as_of',
        requested: { from: input.requestedFrom ?? null, to: input.lastClosedDate },
        selectedFromApplied: false,
        selectedToAppliedAsOfDate: true,
      },
    },
    boundary: { launchDate, firstCleanTaggedDate, launchDateIsMixed: true },
    windows: {
      previous: { from: monthStart, to: previousEnd },
      launchDay: { from: launchDate, to: launchDate },
      tagged: { from: firstCleanTaggedDate, to: input.lastClosedDate },
    },
    taggedAds,
    predecessorAds,
    previous,
    tagged,
    launchDay: { previous: launchPrevious.combined, tagged: launchTagged.combined },
    matched: {
      windows: {
        previous: { from: matchedPreviousFrom, to: matchedDays > 0 ? previousEnd : null, days: matchedDays },
        tagged: { from: matchedDays > 0 ? firstCleanTaggedDate : null, to: matchedTaggedTo, days: matchedDays },
      },
      previous: cohortSummary(input.insights, predecessorAds, matchedPreviousFrom, matchedDays > 0 ? previousEnd : null),
      tagged: cohortSummary(input.insights, taggedAds, matchedDays > 0 ? firstCleanTaggedDate : null, matchedTaggedTo),
    },
    verdict: {
      state: 'hold_investigate',
      label: 'HOLD / INVESTIGATE',
      financialConclusionAllowed: false,
    },
    learning: {
      status: normalizedLearningStates.length > 0 ? 'available' : 'unavailable',
      states: normalizedLearningStates,
    },
  }
}
