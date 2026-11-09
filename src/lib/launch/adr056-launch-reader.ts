import 'server-only'

import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import { etDateOf, yesterday } from '@/lib/utils/date-utils'
import {
  ADR056_TAGGED_META_AD_IDS,
  buildAdr056LaunchComparison,
  type Adr056SourceGeneration,
  type Adr056AdRow,
  type Adr056InsightRow,
  type Adr056LaunchComparison,
} from './adr056-launch-comparison'

export class Adr056LaunchReadError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'Adr056LaunchReadError'
  }
}

function fail(code: string): never {
  throw new Adr056LaunchReadError(code)
}

interface SyncGenerationRow {
  status: unknown
  date_range_start: unknown
  date_range_end: unknown
  completed_at: unknown
}

function successfulCoveringGeneration(
  rows: SyncGenerationRow[],
  start: string,
  end: string,
): Adr056SourceGeneration {
  const coveringSuccesses = rows.filter((row) => row.status === 'success'
    && typeof row.date_range_start === 'string' && row.date_range_start <= start
    && typeof row.date_range_end === 'string' && row.date_range_end >= end
    && typeof row.completed_at === 'string' && Number.isFinite(Date.parse(row.completed_at)))
  if (coveringSuccesses.length === 0) return { state: 'uncovered', completedAt: null }
  const latest = coveringSuccesses.sort((a, b) =>
    Date.parse(String(b.completed_at)) - Date.parse(String(a.completed_at)))[0]
  return { state: 'covered', completedAt: latest.completed_at as string }
}

export async function readAdr056LaunchComparison(
  input: { lastClosedDate?: string; selectedFrom?: string } = {},
  db: ReturnType<typeof getAdminClient> = getAdminClient(),
): Promise<Adr056LaunchComparison> {
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) fail(activeAccountErrorCode(activeAccount.reason))

  const { data: adsData, error: adsError } = await db
    .from('ads')
    .select('id, ad_id, adset_id, ad_name, meta_creative_id, meta_created_time, meta_updated_time, effective_status')
    .eq('ad_account_id', activeAccount.account.id)
  if (adsError) fail('ADR056_ADS_READ_UNAVAILABLE')

  const ads = (adsData ?? []) as Adr056AdRow[]
  // ADR-056 uses a versioned immutable Meta-ID cohort. The name marker is no longer authority.
  const tagged = ads.filter((ad) => ADR056_TAGGED_META_AD_IDS.includes(ad.ad_id as typeof ADR056_TAGGED_META_AD_IDS[number]))
  const launchDates = tagged
    .map((ad) => ad.meta_created_time ? etDateOf(ad.meta_created_time) : '')
    .filter(Boolean)
    .sort()
  const lastClosedDate = input.lastClosedDate ?? yesterday()

  // Let the pure contract return a precise unavailable cohort-count/time blocker without issuing
  // broad insight reads when the live entity inventory itself does not resolve safely.
  if (tagged.length !== 4 || launchDates.length !== tagged.length) {
    return buildAdr056LaunchComparison({
      ads,
      insights: [],
      accountInsightDates: [],
      lastClosedDate,
      lastSyncedAt: null,
      requestedFrom: input.selectedFrom ?? null,
      taggedMetaAdIds: ADR056_TAGGED_META_AD_IDS,
      requireCompleteCohortCoverage: true,
    })
  }

  const monthStart = `${launchDates[0].slice(0, 7)}-01`
  const [insightsResult, accountDatesResult, generationResult, learningResult] = await Promise.all([
    db
      .from('daily_insights')
      .select('ad_id, date_start, spend, impressions, clicks, link_clicks, landing_page_views, bookings, bookings_view_through')
      .eq('ad_account_id', activeAccount.account.id)
      .eq('entity_level', 'ad')
      .gte('date_start', monthStart)
      .lte('date_start', lastClosedDate),
    db
      .from('daily_insights')
      .select('date_start')
      .eq('ad_account_id', activeAccount.account.id)
      .eq('entity_level', 'account')
      .gte('date_start', monthStart)
      .lte('date_start', lastClosedDate),
    db
      .from('api_sync_logs')
      .select('status,date_range_start,date_range_end,completed_at')
      .eq('ad_account_id', activeAccount.account.id)
      .order('completed_at', { ascending: false })
      .limit(100),
    db
      .from('adsets')
      .select('id, learning_stage')
      .eq('ad_account_id', activeAccount.account.id),
  ])

  if (insightsResult.error || accountDatesResult.error) fail('ADR056_INSIGHTS_READ_UNAVAILABLE')
  const sourceGeneration = generationResult.error || !Array.isArray(generationResult.data)
    ? { state: 'read_failed', completedAt: null } as const
    : successfulCoveringGeneration(generationResult.data as SyncGenerationRow[], monthStart, lastClosedDate)

  return buildAdr056LaunchComparison({
    ads,
    insights: (insightsResult.data ?? []) as Adr056InsightRow[],
    accountInsightDates: (accountDatesResult.data ?? [])
      .map((row) => String((row as { date_start?: unknown }).date_start ?? ''))
      .filter(Boolean),
    lastClosedDate,
    lastSyncedAt: sourceGeneration.completedAt,
    sourceGeneration,
    requestedFrom: input.selectedFrom ?? null,
    taggedMetaAdIds: ADR056_TAGGED_META_AD_IDS,
    requireCompleteCohortCoverage: true,
    learningStates: learningResult.error
      ? []
      : (learningResult.data ?? [])
          .filter((row) => tagged.some((ad) => ad.adset_id === row.id))
          .map((row) => typeof row.learning_stage === 'string' ? row.learning_stage : null),
  })
}
