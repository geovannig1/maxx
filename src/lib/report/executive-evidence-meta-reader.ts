import type { SupabaseClient } from '@supabase/supabase-js'
import { summarizeAccountSpendWindow } from '@/lib/economics/ad-spend-reader'
import { inclusiveAccountDates } from '@/lib/economics/account-date-window'
import type {
  ExecutiveEvidenceSourceReadV1,
  ExecutiveEvidenceWindowKeyV1,
  ExecutiveEvidenceWindowRequestV1,
  ExecutiveMetaColdWarmEvidenceV1,
  ExecutiveMetaColdWarmUnitV1,
  ExecutiveMetaEvidenceV1,
  ExecutiveMetaOutcomePlaneV1,
  ExecutiveMetaPlacementEvidenceV1,
  ExecutiveMetaWeeklyFactsV1,
  ExecutiveMetaWindowFactsV1,
  ExecutiveSetupChangeProjectionV1,
  ExecutiveWindowFactsV1,
} from './executive-evidence.types'
import {
  reconcileExecutivePlacementSpendV1,
  projectExecutivePlacementRowsV1,
  validateExecutivePlacementSourceHeadV1,
  type ExecutivePlacementOutcomeAuthorityV1,
} from './executive-evidence-placement'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export {
  reconcileExecutivePlacementOutcomesV1,
  reconcileExecutivePlacementSpendV1,
  projectExecutivePlacementRowsV1,
  validateExecutivePlacementSourceHeadV1,
} from './executive-evidence-placement'

const WINDOW_KEYS: ExecutiveEvidenceWindowKeyV1[] = ['lastDay', 'trailing7', 'prior7', 'monthToDate', 'postChange']
const PAGE_SIZE = 1_000
const COMPLETE_OUTCOME_PLANE: ExecutiveMetaOutcomePlaneV1 = {
  status: 'complete',
  blockerCodes: [],
  coverageBlockerCodes: [],
  sourceNotBefore: null,
  checkedLevels: [],
}

type InsightRow = Record<string, unknown>

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function nonnegative(value: unknown): value is number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return value !== null && value !== '' && Number.isFinite(parsed) && parsed >= 0
}

function numberValue(value: unknown): number {
  return Number(value)
}

function sum(rows: InsightRow[], key: string): number {
  return rows.reduce((total, row) => total + numberValue(row[key]), 0)
}

function nullableSum(rows: InsightRow[], key: string): number | null {
  return rows.every((row) => nonnegative(row[key])) ? sum(rows, key) : null
}

function peakDaily(rows: InsightRow[], key: string): number {
  return Math.max(...rows.map((row) => numberValue(row[key])))
}

export function aggregateExecutiveMetaRowsV1(
  rows: InsightRow[],
  authoritativeSpend?: number,
  metaOutcomePlane: ExecutiveMetaOutcomePlaneV1 = COMPLETE_OUTCOME_PLANE,
): ExecutiveMetaWindowFactsV1 {
  const requiredDelivery = ['spend', 'impressions', 'reach', 'clicks']
  if (rows.some((row) => requiredDelivery.some((field) => !nonnegative(row[field])))) {
    throw new Error('Meta insight row contains an invalid required metric')
  }
  if (metaOutcomePlane.status === 'incomplete') {
    return {
      spendAmount: authoritativeSpend ?? sum(rows, 'spend'),
      impressions: sum(rows, 'impressions'),
      // `daily_insights.reach` is non-additive. Keep the useful daily observation but never
      // manufacture selected-period unique reach by adding days together.
      reach: peakDaily(rows, 'reach'),
      reachAggregation: 'peak_daily',
      linkClicks: nullableSum(rows, 'link_clicks'),
      landingPageViews: nullableSum(rows, 'landing_page_views'),
      leads: null,
      modeledBookings: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: null,
      outcomePlane: metaOutcomePlane,
    }
  }
  const requiredOutcome = ['leads', 'bookings']
  if (rows.some((row) => requiredOutcome.some((field) => !nonnegative(row[field])))) {
    throw new Error('Meta insight row contains an invalid required outcome metric')
  }
  const modeledBookings = sum(rows, 'bookings')
  const modeledViewBookings = nullableSum(rows, 'bookings_view_through')
  if (modeledViewBookings !== null && modeledViewBookings > modeledBookings) {
    throw new Error(`Meta view-through ${OW.many} exceed modeled ${OW.many}`)
  }
  return {
    spendAmount: authoritativeSpend ?? sum(rows, 'spend'),
    impressions: sum(rows, 'impressions'),
    reach: peakDaily(rows, 'reach'),
    reachAggregation: 'peak_daily',
    linkClicks: nullableSum(rows, 'link_clicks'),
    landingPageViews: nullableSum(rows, 'landing_page_views'),
    leads: sum(rows, 'leads'),
    modeledBookings,
    modeledBookingValue: nullableSum(rows, 'appointment_value'),
    modeledClickBookings: modeledViewBookings === null ? null : modeledBookings - modeledViewBookings,
    modeledViewBookings,
    modeledUnknownBookings: modeledViewBookings === null ? modeledBookings : 0,
    outcomePlane: metaOutcomePlane,
  }
}

function factBlockers(fact: ExecutiveMetaWindowFactsV1, scope: string): string[] {
  const metrics = {
    link_clicks: fact.linkClicks,
    landing_page_views: fact.landingPageViews,
    leads: fact.leads,
    modeled_bookings: fact.modeledBookings,
    modeled_booking_value: fact.modeledBookingValue,
    modeled_click_bookings: fact.modeledClickBookings,
    modeled_view_bookings: fact.modeledViewBookings,
    modeled_unknown_bookings: fact.modeledUnknownBookings,
  }
  const blockers = Object.entries(metrics)
    .filter(([, value]) => value === null)
    .map(([metric]) => `meta_metric_unavailable:${scope}:${metric}`)
  if (fact.outcomePlane?.status === 'incomplete') {
    blockers.push(`meta_outcome_plane_incomplete:${scope}`)
    blockers.push(...fact.outcomePlane.blockerCodes.map((code) => `meta_outcome_plane:${scope}:${code}`))
  }
  // Coverage gaps are recorded even when the plane is complete. They do not make the response
  // untrustworthy, but a day on which Meta reported a booking and no value must not read as a day worth
  // zero — the value metrics above already fall to null through nullableSum, and this names why.
  for (const code of fact.outcomePlane?.coverageBlockerCodes ?? []) {
    blockers.push(`meta_outcome_coverage:${scope}:${code}`)
  }
  return unique(blockers)
}

function shiftDate(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function weeklyWindows(lastCompleteDate: string): Array<{ start: string; end: string }> {
  return Array.from({ length: 8 }, (_, index) => {
    const end = shiftDate(lastCompleteDate, -index * 7)
    return { start: shiftDate(end, -6), end }
  }).reverse()
}

async function readAccountInsights(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
): Promise<InsightRow[]> {
  const requestedStarts = WINDOW_KEYS.map((key) => request.windows[key].startDate).filter(
    (value): value is string => value !== null,
  )
  const start = [...requestedStarts, weeklyWindows(request.lastCompleteDate)[0].start].sort()[0]
  const expected = inclusiveAccountDates(start, request.lastCompleteDate)
  const result = await db
    .from('daily_insights')
    .select(
      'ad_account_id,entity_level,campaign_id,adset_id,ad_id,date_start,date_stop,spend,synced_at,impressions,reach,clicks,link_clicks,landing_page_views,leads,bookings,bookings_view_through,appointment_value',
    )
    .eq('ad_account_id', request.accountId)
    .eq('entity_level', 'account')
    .gte('date_start', start)
    .lte('date_start', request.lastCompleteDate)
    .lte('synced_at', request.asOf)
    .order('date_start', { ascending: true })
    .limit(expected.length + 1)
  if (result.error) throw new Error(`Meta account insights read failed: ${result.error.message}`)
  if (!Array.isArray(result.data)) throw new Error('Meta account insights read returned a non-array result')
  return result.data as InsightRow[]
}

function windowFact(args: {
  rows: InsightRow[]
  request: ExecutiveEvidenceWindowRequestV1
  start: string
  end: string
  sourceNotBefore?: string
  metaOutcomePlane?: ExecutiveMetaOutcomePlaneV1
}): ExecutiveMetaWindowFactsV1 | null {
  const rows = args.rows.filter(
    (row) => typeof row.date_start === 'string' && row.date_start >= args.start && row.date_start <= args.end,
  )
  if (args.sourceNotBefore) {
    const boundary = Date.parse(args.sourceNotBefore)
    if (!Number.isFinite(boundary)) throw new Error('Meta current-run source boundary is invalid')
    if (rows.some((row) => {
      const syncedAt = Date.parse(String(row.synced_at ?? ''))
      return !Number.isFinite(syncedAt) || syncedAt < boundary
    })) return null
  }
  const spend = summarizeAccountSpendWindow({
    adAccountId: args.request.accountId,
    window: { start: args.start, end: args.end },
    asOf: args.request.asOf,
    rows: rows.map((row) => ({
      ad_account_id: row.ad_account_id,
      entity_level: row.entity_level,
      campaign_id: row.campaign_id,
      adset_id: row.adset_id,
      ad_id: row.ad_id,
      date_start: row.date_start,
      date_stop: row.date_stop,
      spend: row.spend,
      synced_at: row.synced_at,
    })),
  })
  if (spend.status !== 'available') return null
  return aggregateExecutiveMetaRowsV1(rows, Number(spend.totalSpend), args.metaOutcomePlane)
}

export async function readExecutiveMetaEvidenceV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  currentRunSourceNotBefore?: string,
  metaOutcomePlane?: ExecutiveMetaOutcomePlaneV1,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaEvidenceV1>> {
  const rows = await readAccountInsights(db, request)
  const blockers: string[] = []
  const byWindow = {} as ExecutiveWindowFactsV1<ExecutiveMetaWindowFactsV1>
  for (const key of WINDOW_KEYS) {
    const window = request.windows[key]
    if (window.availability !== 'available' || !window.startDate) {
      byWindow[key] = null
      continue
    }
    const fact = windowFact({
      rows,
      request,
      start: window.startDate,
      end: window.endDate,
      sourceNotBefore: currentRunSourceNotBefore,
      metaOutcomePlane,
    })
    byWindow[key] = fact
    if (!fact) blockers.push(`meta_window_incomplete:${key}`)
    else blockers.push(...factBlockers(fact, key))
  }
  const weeklyTrend8: ExecutiveMetaWeeklyFactsV1[] = []
  for (const [index, window] of weeklyWindows(request.lastCompleteDate).entries()) {
    const fact = windowFact({ rows, request, ...window, metaOutcomePlane })
    if (!fact) blockers.push(`meta_weekly_window_incomplete:${index}`)
    else {
      blockers.push(...factBlockers(fact, `weeklyTrend8:${index}`))
      weeklyTrend8.push({
        ...fact,
        windowStart: window.start,
        windowEnd: window.end,
      })
    }
  }
  // The core head is deliberately tied to the required last-complete-day row. A fresh historical
  // restatement must never make a retained stale last-day row appear current.
  const head =
    rows
      .filter((row) => row.date_start === request.lastCompleteDate)
      .map((row) => String(row.synced_at ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  return {
    availability: blockers.length === 0 ? 'available' : 'partial',
    head,
    blockerCodes: unique(blockers),
    data: { byWindow, weeklyTrend8 },
  }
}

async function readAdsetInsights(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  currentRunSourceNotBefore?: string,
): Promise<InsightRow[]> {
  const window = request.windows.trailing7
  let query = db
    .from('daily_insights')
    .select(
      'date_start,synced_at,meta_campaign_id,meta_adset_id,spend,impressions,reach,clicks,link_clicks,landing_page_views,leads,bookings,bookings_view_through,appointment_value',
    )
    .eq('ad_account_id', request.accountId)
    .eq('entity_level', 'adset')
    .gte('date_start', window.startDate!)
    .lte('date_start', window.endDate)
    .lte('synced_at', request.asOf)
  if (currentRunSourceNotBefore) query = query.gte('synced_at', currentRunSourceNotBefore)
  const result = await query
    .order('date_start', { ascending: true })
    .limit(10_001)
  if (result.error) throw new Error(`Meta ad-set insights read failed: ${result.error.message}`)
  if (!Array.isArray(result.data) || result.data.length > 10_000) {
    throw new Error('Meta ad-set insights read was unavailable or exceeded 10,000 rows')
  }
  return result.data as InsightRow[]
}

export async function readExecutiveMetaColdWarmV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  setup: ExecutiveSetupChangeProjectionV1,
  authoritativeSpend: number | null,
  currentRunSourceNotBefore?: string,
  metaOutcomePlane?: ExecutiveMetaOutcomePlaneV1,
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaColdWarmEvidenceV1>> {
  const rows = await readAdsetInsights(db, request, currentRunSourceNotBefore)
  const blockers = setup.cold_warm_comparison.blocker_codes.map((code) => `setup:${code}`)
  if (authoritativeSpend === null) {
    blockers.push('meta_cold_warm_account_spend_unavailable')
  } else if (Math.abs(sum(rows, 'spend') - authoritativeSpend) > 0.01) {
    blockers.push('meta_cold_warm_spend_reconciliation_failed')
  }
  const units: ExecutiveMetaColdWarmUnitV1[] = []
  for (const adset of setup.adsets.filter((row) => row.comparison_role === 'cold' || row.comparison_role === 'warm')) {
    const unitRows = rows.filter((row) => row.meta_adset_id === adset.meta_adset_id)
    if (unitRows.length === 0) {
      blockers.push(`meta_cold_warm_unit_rows_missing:${adset.meta_adset_id}`)
      continue
    }
    const fact = aggregateExecutiveMetaRowsV1(unitRows, undefined, metaOutcomePlane)
    blockers.push(...factBlockers(fact, adset.meta_adset_id))
    units.push({
      entityLevel: 'adset',
      entityId: adset.meta_adset_id,
      parentCampaignId: adset.meta_campaign_id,
      name: adset.name ?? adset.meta_adset_id,
      comparisonRole: adset.comparison_role,
      ...fact,
    })
  }
  if (units.length === 0) blockers.push('meta_cold_warm_units_unavailable')
  const finalBlockers = unique(blockers)
  const head =
    rows
      .map((row) => String(row.synced_at ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  return {
    availability: finalBlockers.length === 0 ? 'available' : 'partial',
    head,
    blockerCodes: finalBlockers,
    data: {
      windowStart: request.windows.trailing7.startDate!,
      windowEnd: request.windows.trailing7.endDate,
      comparisonStatus: finalBlockers.length === 0 ? 'clean' : 'blocked',
      blockerCodes: finalBlockers,
      units,
    },
  }
}

async function readPlacementRows(db: SupabaseClient, request: ExecutiveEvidenceWindowRequestV1): Promise<InsightRow[]> {
  const window = request.windows.trailing7
  const rows: InsightRow[] = []
  for (let page = 0; page < 20; page += 1) {
    const from = page * PAGE_SIZE
    const result = await db
      .from('insight_breakdowns')
      .select('date_start,breakdown_type,breakdown_value,spend,impressions,clicks,leads,bookings,created_at')
      .eq('ad_account_id', request.accountId)
      .eq('entity_level', 'adset')
      .in('breakdown_type', ['publisher_platform', 'platform_position'])
      .gte('date_start', window.startDate!)
      .lte('date_start', window.endDate)
      .lte('created_at', request.asOf)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (result.error) throw new Error(`Meta placement breakdown read failed: ${result.error.message}`)
    if (!Array.isArray(result.data)) throw new Error('Meta placement breakdown returned a non-array result')
    rows.push(...(result.data as InsightRow[]))
    if (result.data.length < PAGE_SIZE) return rows
  }
  throw new Error('Meta placement breakdown exceeded 20,000 rows')
}

export async function readExecutiveMetaPlacementsV1(
  db: SupabaseClient,
  request: ExecutiveEvidenceWindowRequestV1,
  authoritativeSpend: number | null,
  currentRunSourceNotBefore?: string,
  metaOutcomePlane: ExecutiveMetaOutcomePlaneV1 = COMPLETE_OUTCOME_PLANE,
  authoritativeOutcomes: ExecutivePlacementOutcomeAuthorityV1 = {
    leads: null,
    modeledBookings: null,
  },
): Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaPlacementEvidenceV1>> {
  const rows = await readPlacementRows(db, request)
  const healthRead = await db.from('app_settings').select('value')
    .eq('ad_account_id', request.accountId)
    .eq('key', 'executive_placement_evidence_health')
    .maybeSingle()
  if (healthRead.error) throw new Error(`Meta placement source-head read failed: ${healthRead.error.message}`)
  const windowStart = request.windows.trailing7.startDate!
  const windowEnd = request.windows.trailing7.endDate
  const sourceHead = validateExecutivePlacementSourceHeadV1(healthRead.data?.value, {
    windowStart,
    windowEnd,
    asOf: request.asOf,
    rowCount: rows.length,
    sourceNotBefore: currentRunSourceNotBefore,
  })
  if (!sourceHead.valid) {
    return {
      availability: 'unavailable',
      head: sourceHead.head,
      blockerCodes: sourceHead.blockerCodes,
      data: null,
    }
  }
  if (
    rows.some(
      (row) =>
        !['publisher_platform', 'platform_position'].includes(String(row.breakdown_type)) ||
        !String(row.breakdown_value ?? '').trim() ||
        ['spend', 'impressions', 'clicks'].some((field) => !nonnegative(row[field])),
    )
  ) {
    throw new Error('Meta placement breakdown contains invalid data')
  }
  const blockers = reconcileExecutivePlacementSpendV1(rows, authoritativeSpend)
  const placementProjection = projectExecutivePlacementRowsV1(
    rows,
    metaOutcomePlane,
    authoritativeOutcomes,
  )
  blockers.push(...placementProjection.blockerCodes)
  if (rows.length === 0) blockers.push('meta_placements_no_rows')
  const finalBlockers = unique(blockers)
  return {
    availability: finalBlockers.length === 0 ? 'available' : 'partial',
    head: sourceHead.head,
    blockerCodes: finalBlockers,
    data: {
      windowStart,
      windowEnd,
      blockerCodes: finalBlockers,
      rows: placementProjection.rows,
    },
  }
}
