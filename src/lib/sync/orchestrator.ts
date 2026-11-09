import { accountCurrency } from '@/config/business-config'
import * as Sentry from '@sentry/nextjs'
import { getAdminClient } from '@/lib/supabase/admin'
import { getAdPlatform } from '@/lib/platforms/registry'
import type { AdAccountRecord } from '@/lib/platforms/types'
import { yesterday, nyDaysAgo, nyToday } from '@/lib/utils/date-utils'
import { refreshReportRollups } from '@/lib/report/rollup-refresh'
import { PAID_COHORT_POLICY } from '@/lib/attribution/paid-cohort-policy'

// Meta RESTATES recent daily insights after the fact: spend finalizes over ~48–72h (delayed billing /
// impression reconciliation) and attributed conversions restate up to the 7-day click window. A
// yesterday-only sync freezes the morning-after snapshot forever. Every sync re-pulls a rolling window so
// restatements land in daily_insights. refreshReportRollups is legacy-only: current V3 reports stay
// immutable with the exact ExecutiveEvidence snapshot used by their digest and email.
export const LIFECYCLE_MIN_INSIGHT_DAYS = 30
export const INSIGHT_RESTATEMENT_LOOKBACK_DAYS = Math.max(
  LIFECYCLE_MIN_INSIGHT_DAYS,
  PAID_COHORT_POLICY.recentScaleDays + PAID_COHORT_POLICY.maturedCutDays,
)
import { createSyncLog, updateSyncLog, reconcileOrphanedSyncs } from './log-sync'
import { upsertCampaigns } from './upsert-campaigns'
import { upsertAdSets } from './upsert-adsets'
import { upsertCustomAudiences } from './upsert-custom-audiences'
import { upsertAds } from './upsert-ads'
import { upsertCreatives, linkCreativesToAds } from './upsert-creatives'
import {
  reconcileAccountBookings,
  META_OUTCOME_PLANE_POLICY,
  reconcileMetaOutcomeHierarchy,
  upsertInsights,
  validateMetaInsightDeliveryRows,
  type MetaOutcomePlaneReadiness,
} from './upsert-insights'
import { runAlertDetection } from '@/lib/alerts/detector'
import { runFlagEngine } from '@/lib/flags/engine'
import { generateRecommendationsFromFlags, type FlagRow } from '@/lib/recommendations/generate'
import { generateDailyReport, trailingInclusiveWindow } from '@/lib/report/generator'
import { hydrateTargetOverrides } from '@/lib/targets/store'
import { reconcileOutcomeSources, reconcilePartialErrors, type SourceReconcileResult } from '@/lib/outcomes/reconciliation'
import { readEnabledOutcomeSources } from '@/lib/outcomes/source-health'
import { reportOutcomeArrival, reportOutcomesReady as outcomeReportReady, type ReportOutcomeArrival } from '@/lib/outcomes/report-gate'
import { publishPaidCohortPair } from '@/lib/attribution/paid-cohort-store'
import { paidCohortPublicationContext } from './paid-cohort-stage'
import { sweepUnsentOutcomeConversions } from '@/lib/conversions/outcome-sweep'
import { captureMetaSetupGeneration } from '@/lib/setup-history/capture'
import { refreshExecutivePlacementEvidence } from './executive-placement-evidence'
import type { MetaInsightRow } from '@/types/meta-api'

/** An ad-account money field (spend_cap, amount_spent) in major units of the account's own currency,
 *  on Meta's offset table (not a fixed /100); null when absent or the currency is not a Meta currency. */
function metaAccountMoney(value: string | undefined, currency: string | undefined): number | null {
  const units = getAdPlatform('meta').budgetUnits
  if (!value || !currency || !units.supports(currency)) return null
  const minor = parseFloat(value)
  return Number.isFinite(minor) ? units.fromMinor(minor, currency) : null
}

const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 2000

export function canPublishDecisionEvidence(lifecycleRun: boolean, insightLevelsComplete: boolean): boolean {
  return lifecycleRun && insightLevelsComplete
}

export function canRunLiveDecisionPipeline(
  lifecycleRun: boolean,
  insightLevelsComplete: boolean,
  metaOutcomeMetricsComplete: boolean,
  paidCohortPublished: boolean,
): boolean {
  return lifecycleRun && insightLevelsComplete && metaOutcomeMetricsComplete && paidCohortPublished
}

export const DECISION_GATE_NAMES = [
  'lifecycleRun',
  'insightLevelsComplete',
  'metaOutcomeMetricsComplete',
  'paidCohortPublished',
] as const

export type DecisionGateName = (typeof DECISION_GATE_NAMES)[number]

export interface DecisionGateRecord {
  verdict: 'live' | 'frozen'
  gates: Record<DecisionGateName, boolean>
  /** Every gate that was false. Empty when the verdict is `live`. */
  closedBy: DecisionGateName[]
  metaOutcomeBlockerCodes: string[]
  evaluatedAt: string
}

/**
 * The record that says WHICH gate closed.
 *
 * `canRunLiveDecisionPipeline` ANDs four booleans and returns one. If flags and recommendations stop
 * generating, nothing would otherwise record which of the four was false — three are function-locals
 * that never leave this file — so the answer would have to be reverse-engineered from side effects.
 * Every gate is therefore named in the run's own log row.
 *
 * `closedBy` lists ALL false gates rather than the first, because "fix this one and the pipeline runs"
 * is only true when it is the sole entry.
 */
export function buildDecisionGateRecord(
  gates: Record<DecisionGateName, boolean>,
  metaOutcomeBlockerCodes: string[],
  evaluatedAt: string,
): DecisionGateRecord {
  const closedBy = DECISION_GATE_NAMES.filter((name) => !gates[name])
  return {
    verdict: closedBy.length === 0 ? 'live' : 'frozen',
    gates,
    closedBy,
    metaOutcomeBlockerCodes,
    evaluatedAt,
  }
}

function numericInsightValue(value: string | undefined): number {
  return Number(value)
}

function insightRowsHaveDelivery(rows: MetaInsightRow[]): boolean {
  return rows.some((row) =>
    numericInsightValue(row.spend) > 0 ||
    numericInsightValue(row.impressions) > 0 ||
    numericInsightValue(row.clicks) > 0,
  )
}

function insightResponseTotals(rows: MetaInsightRow[]) {
  return rows.reduce((totals, row) => ({
    spend: totals.spend + numericInsightValue(row.spend),
    impressions: totals.impressions + numericInsightValue(row.impressions),
    clicks: totals.clicks + numericInsightValue(row.clicks),
  }), { spend: 0, impressions: 0, clicks: 0 })
}

function inclusiveDates(start: string, end: string): string[] {
  const startMs = Date.parse(`${start}T00:00:00.000Z`)
  const endMs = Date.parse(`${end}T00:00:00.000Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) return []
  const dates: string[] = []
  for (let time = startMs; time <= endMs; time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10))
  }
  return dates
}

export function lifecycleWindowIsComplete(
  start: string,
  end: string,
  lastCompleteDate: string = yesterday(),
): boolean {
  return end === lastCompleteDate && inclusiveDates(start, end).length >= LIFECYCLE_MIN_INSIGHT_DAYS
}

/** Meta omits account days with no delivery. Once the full request succeeds and every returned row
 * validates, fill only those missing account dates with explicit delivery zeros so stale warehouse rows
 * cannot masquerade as current. Outcome lists stay absent because campaign rows own conversion truth. */
export function prepareAccountInsightRows(
  rows: MetaInsightRow[],
  since: string,
  until: string,
): MetaInsightRow[] {
  validateMetaInsightDeliveryRows('account', rows, since, until)
  if (rows.length === 0) {
    throw new Error(
      'No authoritative account-level row was returned by the current Meta sync; empty is not authoritative zero',
    )
  }
  const byDate = new Map(rows.map((row) => [row.date_start, row]))
  return inclusiveDates(since, until).map((date) => byDate.get(date) ?? {
    date_start: date,
    date_stop: date,
    spend: '0',
    impressions: '0',
    reach: '0',
    clicks: '0',
    unique_clicks: '0',
    frequency: '0',
    ctr: '0',
    cpc: '0',
    cpm: '0',
  })
}

function deliveryTotalsByDate(rows: MetaInsightRow[]): Map<string, ReturnType<typeof insightResponseTotals>> {
  const dates = new Map<string, MetaInsightRow[]>()
  for (const row of rows) dates.set(row.date_start, [...(dates.get(row.date_start) ?? []), row])
  return new Map([...dates].map(([date, dateRows]) => [date, insightResponseTotals(dateRows)]))
}

function deliveryTotalsReconcile(
  authority: ReturnType<typeof insightResponseTotals>,
  candidate: ReturnType<typeof insightResponseTotals>,
): boolean {
  return (
    Math.abs(candidate.spend - authority.spend) <= 0.01 &&
    Math.abs(candidate.impressions - authority.impressions) <= 0.5 &&
    Math.abs(candidate.clicks - authority.clicks) <= 0.5
  )
}

export interface DailySyncResult {
  logId: string
  success: boolean
  error?: string
  metaOutcomeMetricsComplete: boolean
  metaOutcomeBlockerCodes: string[]
  outcomeReconcile?: SourceReconcileResult
  committedReport?: { id: string; reportDate: string }
  /** Set when every enabled outcome source is push-only (the report records how outcomes arrived). */
  outcomeArrival?: ReportOutcomeArrival | null
}

async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  apiCallsRef: { count: number; rateLimitHit: boolean; retryCount: number }
): Promise<T> {
  let attempt = 0
  let backoffMs = INITIAL_BACKOFF_MS

  while (true) {
    try {
      apiCallsRef.count++
      return await fn()
    } catch (err) {
      const isRateLimit = getAdPlatform('meta').isApiError(err) && err.isRateLimit?.()
      const retryable = getAdPlatform('meta').isApiError(err) && (isRateLimit || err.isTransient?.())

      if (retryable && attempt < MAX_RETRIES) {
        attempt++
        if (isRateLimit) apiCallsRef.rateLimitHit = true
        apiCallsRef.retryCount++
        console.log(`[Sync] ${context}: ${isRateLimit ? 'rate limit hit' : 'transient error'}, retry ${attempt}/${MAX_RETRIES} in ${backoffMs}ms`)
        await new Promise((res) => setTimeout(res, backoffMs))
        backoffMs *= 2
        continue
      }

      throw err
    }
  }
}

async function upsertAdAccount(
  adAccountId: string
): Promise<{ dbId: string; accountName: string; currency: string }> {
  const supabase = getAdminClient()
  const now = new Date().toISOString()

  // Fetch live account data from Meta API (includes pixel, IG, page IDs)
  let accountMeta: AdAccountRecord | null = null
  try {
    accountMeta = await getAdPlatform('meta').entities.fetchAccount(adAccountId)
  } catch (err) {
    console.warn('[Sync] fetchAdAccount failed — upserting with ID only:', err instanceof Error ? err.message : err)
  }

  const upsertPayload: Record<string, unknown> = {
    account_id: adAccountId,
    last_synced_at: now,
  }

  if (accountMeta) {
    upsertPayload.account_name = accountMeta.name
    upsertPayload.currency = accountMeta.currency
    upsertPayload.account_status = accountMeta.account_status
    upsertPayload.timezone_name = accountMeta.timezone_name
    upsertPayload.business_id = accountMeta.business?.id ?? null
    upsertPayload.business_name = accountMeta.business?.name ?? null
    upsertPayload.spend_cap = metaAccountMoney(accountMeta.spend_cap, accountMeta.currency)
    upsertPayload.amount_spent = metaAccountMoney(accountMeta.amount_spent, accountMeta.currency)
    upsertPayload.disable_reason = accountMeta.disable_reason ?? null
    if (accountMeta.pixel_id) upsertPayload.pixel_id = accountMeta.pixel_id
    if (accountMeta.instagram_account_id) upsertPayload.instagram_account_id = accountMeta.instagram_account_id
    if (accountMeta.facebook_page_id) upsertPayload.facebook_page_id = accountMeta.facebook_page_id
  }

  const { data, error } = await supabase
    .from('ad_accounts')
    .upsert(upsertPayload, { onConflict: 'account_id', ignoreDuplicates: false })
    .select('id, account_name, currency')
    .single()

  if (error) {
    throw new Error(`upsertAdAccount failed: ${error.message}`)
  }

  return {
    dbId: data.id as string,
    accountName: (data.account_name as string) ?? adAccountId,
    currency: (data.currency as string) ?? accountCurrency(),
  }
}

export async function runDailySync(params: {
  adAccountId: string
  triggeredBy: string
  dateRangeStart?: string
  dateRangeEnd?: string
}): Promise<DailySyncResult> {
  const dateStart = params.dateRangeStart ?? nyDaysAgo(INSIGHT_RESTATEMENT_LOOKBACK_DAYS)
  const dateEnd = params.dateRangeEnd ?? yesterday()
  const metaAccountId = params.adAccountId

  // LIFECYCLE GATE: the flag engine (which resolves/closes active flags) and recommendation generation
  // (which REPLACES the account's open recommendations) mutate live decision state as of `dateEnd`.
  // A historical/backfill sync (e.g. /api/sync with previous_7_days) must never run them — it would
  // close today's flags and supersede today's recommendations using past data. Only a run whose window
  // ends at the canonical current completed day (yesterday, NY) AND carries at least 30 complete days
  // runs lifecycle steps; short/manual and historical windows remain ingest-only.
  const lifecycleRun = lifecycleWindowIsComplete(dateStart, dateEnd)

  // Band the flag/alert engines against the saved Performance-Targets overrides (defaults if none).
  // Covers both the cron and the manual /api/sync, since both flow through here. The cron's later
  // recommendations/monitoring steps inherit the same active ranges (same process).
  await hydrateTargetOverrides()

  const syncStartTime = Date.now()

  const apiCalls = { count: 0, rateLimitHit: false, retryCount: 0 }

  console.log(`[Sync] Starting daily sync for account ${metaAccountId} (${dateStart} → ${dateEnd})`)
  console.log(`[Sync] Triggered by: ${params.triggeredBy}`)

  // Step 1: Upsert ad account to get the DB UUID (required for sync log FK)
  // We do this before creating the log so the log has a valid ad_account_id FK.
  console.log(`[Sync] Upserting ad account ${metaAccountId}`)
  const { dbId: adAccountDbId } = await upsertAdAccount(metaAccountId)

  // Step 1a: Watchdog — reconcile orphaned in-progress syncs before starting a new one.
  try {
    const reconciled = await reconcileOrphanedSyncs(adAccountDbId)
    if (reconciled > 0) console.warn(`[Sync] Watchdog marked ${reconciled} orphaned sync(s) as failed`)
  } catch (e) {
    console.warn('[Sync] Orphan reconciliation failed (non-fatal):', e instanceof Error ? e.message : e)
  }

  // Step 1b: Create sync log with the real DB UUID. This INSERT is also the DURABLE SINGLE-FLIGHT CLAIM
  // (`api_sync_logs_one_active_per_account`): if another sync is already active for this account, createSyncLog returns null and we
  // abort EARLY — before any ingest — instead of racing to the flag-commit CAS after a wasted double pull.
  const logId = await createSyncLog({
    adAccountId: adAccountDbId,
    syncType: 'full',
    triggeredBy: params.triggeredBy,
    dateRangeStart: dateStart,
    dateRangeEnd: dateEnd,
  })
  if (logId === null) {
    console.warn(`[Sync] A sync is already running for account ${metaAccountId} — skipping (single-flight).`)
    return {
      logId: '',
      success: false,
      error: 'sync_already_running',
      metaOutcomeMetricsComplete: false,
      metaOutcomeBlockerCodes: ['sync_not_started'],
    }
  }

  await updateSyncLog(logId, {
    status: 'running',
    startedAt: new Date().toISOString(),
  })

  // Declared outside the try so a run that throws AFTER the gate was evaluated still records which gate
  // closed. Stays undefined when the run ends before evaluation, which persists as NULL — "not
  // recorded", never "passed".
  let decisionGate: DecisionGateRecord | undefined

  try {
    const partialErrors: string[] = []
    let setupSourceBlockers: string[] = []
    let setupGenerationId: string | null = null
    let outcomeReconcile: SourceReconcileResult | undefined
    let committedReport: DailySyncResult['committedReport']
    let outcomeArrival: ReportOutcomeArrival | null = null

    // Step 2: Fetch & upsert campaigns
    console.log(`[Sync] Fetching campaigns`)
    const campaigns = await withRetry(
      () => getAdPlatform('meta').entities.fetchCampaigns(metaAccountId),
      'fetchCampaigns',
      apiCalls
    )
    const campaignCount = await upsertCampaigns(adAccountDbId, campaigns)
    console.log(`[Sync] Upserted ${campaignCount} campaigns`)

    // Step 3: Fetch & upsert ad sets
    console.log(`[Sync] Fetching ad sets`)
    const adSets = await withRetry(
      () => getAdPlatform('meta').entities.fetchAdSets(metaAccountId),
      'fetchAdSets',
      apiCalls
    )
    const adSetCount = await upsertAdSets(adAccountDbId, adSets)
    console.log(`[Sync] Upserted ${adSetCount} ad sets`)

    // Step 3b: audience subtype, ownership, source and health make the targeting spec interpretable.
    // This read is non-fatal because permissions vary, but its failure is explicit: unresolved
    // audience metadata freezes composition and every audience-dependent money conclusion.
    try {
      console.log('[Sync] Fetching custom audiences')
      const audiences = await withRetry(
        () => getAdPlatform('meta').entities.fetchCustomAudiences(metaAccountId),
        'fetchCustomAudiences',
        apiCalls,
      )
      const audienceCount = await upsertCustomAudiences(adAccountDbId, metaAccountId, audiences)
      console.log(`[Sync] Upserted ${audienceCount} custom audiences`)
    } catch (audienceError) {
      const message = audienceError instanceof Error ? audienceError.message : String(audienceError)
      console.warn('[Sync] Custom-audience sync failed; audience conclusions will freeze:', message)
      partialErrors.push(`custom-audiences: ${message}`)
      setupSourceBlockers = [...setupSourceBlockers, 'custom_audience_sync_failed']
    }

    // Step 4: Fetch & upsert ads
    console.log(`[Sync] Fetching ads`)
    const ads = await withRetry(
      () => getAdPlatform('meta').entities.fetchAds(metaAccountId),
      'fetchAds',
      apiCalls
    )
    const adCount = await upsertAds(adAccountDbId, ads)
    console.log(`[Sync] Upserted ${adCount} ads`)

    // Step 6: Fetch creative IDs from ads, batch-fetch creatives, upsert
    const creativeIds = [
      ...new Set(
        ads
          .map((ad) => ad.creative?.id)
          .filter((id): id is string => Boolean(id))
      ),
    ]
    let creativeCount = 0
    try {
      if (creativeIds.length > 0) {
        console.log(`[Sync] Fetching ${creativeIds.length} creatives`)
        const creatives = await withRetry(
          () => getAdPlatform('meta').entities.fetchCreatives(creativeIds),
          'fetchCreatives',
          apiCalls
        )
        creativeCount = await upsertCreatives(adAccountDbId, creatives)
        console.log(`[Sync] Upserted ${creativeCount} creatives`)
        if (creativeCount !== creativeIds.length) {
          setupSourceBlockers = [...setupSourceBlockers, 'creative_inventory_incomplete']
          partialErrors.push(
            `creatives: expected ${creativeIds.length} current rows but committed ${creativeCount}`,
          )
        }
      } else {
        console.log(`[Sync] No creatives to fetch`)
      }

      // Step 7: Link creative FKs to ads
      console.log(`[Sync] Linking creatives to ads`)
      await linkCreativesToAds(adAccountDbId)
    } catch (creativeErr) {
      const m = creativeErr instanceof Error ? creativeErr.message : String(creativeErr)
      console.warn('[Sync] Creatives step failed (non-fatal):', m)
      partialErrors.push(`creatives: ${m}`)
      setupSourceBlockers = [...setupSourceBlockers, 'creative_sync_failed']
    }

    // Step 7b: Persist the observed setup/configuration state before performance reads and decision
    // logic. This is append-only evidence capture only; it never calls Meta write APIs and it never
    // infers why a material setup change happened unless an approved setup-change plan matches it.
    try {
      const setupGeneration = await captureMetaSetupGeneration(getAdminClient(), {
        adAccountId: adAccountDbId,
        syncLogId: logId,
        observedAt: new Date().toISOString(),
        sourceNotBefore: new Date(syncStartTime).toISOString(),
        blockerCodes: setupSourceBlockers,
      })
      setupGenerationId = setupGeneration.generationId
      console.log(
        `[Sync] Captured Meta setup generation ${setupGeneration.generationId} ` +
        `(${setupGeneration.entityCount} entities)`,
      )
    } catch (setupHistoryErr) {
      const m = setupHistoryErr instanceof Error ? setupHistoryErr.message : String(setupHistoryErr)
      console.warn('[Sync] Setup-history capture failed (non-fatal):', m)
      partialErrors.push(`setup-history: ${m}`)
    }

    // Step 8: Fetch insights at all 4 levels
    const insightLevels = ['account', 'campaign', 'adset', 'ad'] as const
    let totalInsights = 0
    let insightLevelsComplete = true
    let accountInsightTotals = { spend: 0, impressions: 0, clicks: 0 }
    let accountInsightsHaveDelivery = false
    let accountLastDayHasDelivery = false
    const currentInsightRows: Partial<Record<(typeof insightLevels)[number], MetaInsightRow[]>> = {}

    for (const level of insightLevels) {
      try {
        console.log(`[Sync] Fetching insights at level: ${level}`)
        const rawInsightRows = await withRetry(
          () => getAdPlatform('meta').insights.fetchInsights({ accountId: metaAccountId, level, since: dateStart, until: dateEnd }),
          `fetchInsights:${level}`,
          apiCalls
        )
        const insightRows = level === 'account'
          ? prepareAccountInsightRows(rawInsightRows, dateStart, dateEnd)
          : rawInsightRows
        if (level !== 'account') {
          validateMetaInsightDeliveryRows(level, insightRows, dateStart, dateEnd)
        }
        currentInsightRows[level] = insightRows

        if (lifecycleRun && level === 'account') {
          accountInsightTotals = insightResponseTotals(insightRows)
          accountInsightsHaveDelivery = insightRowsHaveDelivery(insightRows)
          const lastDayRows = insightRows.filter((row) => row.date_start === dateEnd)
          accountLastDayHasDelivery = insightRowsHaveDelivery(lastDayRows)
        } else if (lifecycleRun) {
          if (insightRows.length === 0 && accountInsightsHaveDelivery) {
            insightLevelsComplete = false
            partialErrors.push(
              `insights:${level}: positive account delivery had no current ${level}-level rows`,
            )
          } else {
            const levelTotals = insightResponseTotals(insightRows)
            const accountByDate = deliveryTotalsByDate(currentInsightRows.account ?? [])
            const levelByDate = deliveryTotalsByDate(insightRows)
            const dailyTotalsReconcile = inclusiveDates(dateStart, dateEnd).every((date) =>
              deliveryTotalsReconcile(
                accountByDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 },
                levelByDate.get(date) ?? { spend: 0, impressions: 0, clicks: 0 },
              ),
            )
            if (!deliveryTotalsReconcile(accountInsightTotals, levelTotals) || !dailyTotalsReconcile) {
              insightLevelsComplete = false
              partialErrors.push(
                `insights:${level}: current response delivery did not reconcile by date to account delivery`,
              )
            } else if (accountLastDayHasDelivery && !insightRows.some((row) => row.date_start === dateEnd)) {
              insightLevelsComplete = false
              partialErrors.push(
                `insights:${level}: current response omitted the last complete day with account delivery`,
              )
            }
          }
        }

        const upserted = await upsertInsights(adAccountDbId, metaAccountId, level, insightRows)
        if (lifecycleRun && level !== 'account' && upserted !== insightRows.length) {
          insightLevelsComplete = false
          partialErrors.push(
            `insights:${level}: ${insightRows.length - upserted} current row(s) could not be bound to synchronized entities`,
          )
        }
        totalInsights += upserted
        console.log(`[Sync] Upserted ${upserted} ${level}-level insight rows`)
      } catch (insErr) {
        insightLevelsComplete = false
        const m = insErr instanceof Error ? insErr.message : String(insErr)
        console.warn(`[Sync] Insights level ${level} failed (non-fatal):`, m)
        partialErrors.push(`insights:${level}: ${m}`)
      }
    }

    console.log(`[Sync] Total insights upserted: ${totalInsights}`)

    let metaOutcomePlane: MetaOutcomePlaneReadiness
    if (
      currentInsightRows.campaign !== undefined &&
      currentInsightRows.adset !== undefined &&
      currentInsightRows.ad !== undefined
    ) {
      metaOutcomePlane = reconcileMetaOutcomeHierarchy({
        campaign: currentInsightRows.campaign,
        adset: currentInsightRows.adset,
        ad: currentInsightRows.ad,
        since: dateStart,
        until: dateEnd,
      })
    } else {
      const missingLevels = (['campaign', 'adset', 'ad'] as const)
        .filter((level) => currentInsightRows[level] === undefined)
      metaOutcomePlane = {
        complete: false,
        blockerCodes: missingLevels.map((level) => `meta_outcome_${level}_source_unavailable`),
        coverageBlockerCodes: [],
        policyVersion: META_OUTCOME_PLANE_POLICY.version,
      }
    }
    if (!metaOutcomePlane.complete) {
      partialErrors.push(`meta-outcomes: ${metaOutcomePlane.blockerCodes.join(', ')}`)
    }

    // Step 8b: project reconciled campaign outcomes onto account delivery rows. Meta can omit the
    // account action/result planes; campaign is the outcome authority for executive readers.
    if (insightLevelsComplete && metaOutcomePlane.complete) {
      try {
        const raised = await reconcileAccountBookings(adAccountDbId, dateStart, dateEnd)
        if (raised > 0) console.log(`[Sync] Account outcomes reconciled to campaign authority on ${raised} day(s)`)
      } catch (rollupErr) {
        const m = rollupErr instanceof Error ? rollupErr.message : String(rollupErr)
        console.warn('[Sync] Account bookings rollup failed (non-fatal):', m)
        partialErrors.push(`account-bookings-rollup: ${m}`)
        metaOutcomePlane = {
          ...metaOutcomePlane,
          complete: false,
          blockerCodes: [...metaOutcomePlane.blockerCodes, 'meta_outcome_account_rollup_failed'],
        }
      }
    } else {
      console.warn('[Sync] Account bookings rollup skipped: current Meta delivery/outcome authority is incomplete')
    }

    // Step 8c: refresh the exact trailing-seven publisher/platform placement source before the
    // executive evidence snapshot is built. A failed dimension leaves the prior atomic window in
    // place and is surfaced as unavailable by its source-head contract; it never becomes a zero.
    if (lifecycleRun) {
      try {
        const placement = await refreshExecutivePlacementEvidence({
          adAccountDbId,
          metaAccountId,
          lastCompleteDate: dateEnd,
        })
        console.log(
          `[Sync] Executive placement evidence refreshed ` +
          `(${placement.windowStart}…${placement.windowEnd}, ${placement.rowCount} rows)`,
        )
      } catch (placementError) {
        const message = placementError instanceof Error ? placementError.message : String(placementError)
        console.warn('[Sync] Executive placement evidence refresh failed:', message)
        partialErrors.push(`executive-placements: ${message}`)
      }
    }

    // Step 8d: reconcile enabled outcome sources inside the same lifecycle run that publishes paid cohorts. Running
    // this later in the cron created two incompatible timelines: recommendations were already
    // committed before the ledger safety-net finished, and manual syncs never reconciled at all.
    if (lifecycleRun) {
      try {
        outcomeReconcile = await reconcileOutcomeSources({
          supabase: getAdminClient(),
          adAccountId: adAccountDbId,
        })
        // A push-only install has no reconciling source: nothing ran, and the run is not partial.
        partialErrors.push(...reconcilePartialErrors(outcomeReconcile))
      } catch (reconcileError) {
        const message = reconcileError instanceof Error ? reconcileError.message : String(reconcileError)
        outcomeReconcile = { available: false, reason: message }
        partialErrors.push(`outcome-reconcile: ${message}`)
      }
    }

    // Step 8e: at-least-once conversions for generic (webhook) outcome sources, the counterpart of
    // the reconciled-source sweep inside step 8d. Live mode only; a failure is partial, never fatal.
    if (lifecycleRun) {
      try {
        const sweep = await sweepUnsentOutcomeConversions(getAdminClient())
        if (sweep.ran) console.log(`[Sync] Outcome conversions sweep: ${sweep.sent} sent, ${sweep.errors} errors, ${sweep.markedMissed} closed out`)
      } catch (sweepError) {
        const message = sweepError instanceof Error ? sweepError.message : String(sweepError)
        partialErrors.push(`outcome-conversions: ${message}`)
      }
    }

    // Step 9: Run alert detection (non-fatal — a transient DB error here must not discard the
    // campaigns/adsets/ads/insights already upserted this run, nor trip the cron's fatal early-return).
    if (lifecycleRun && insightLevelsComplete && metaOutcomePlane.complete) {
      console.log(`[Sync] Running alert detection for ${dateEnd}`)
      try {
        const alertCount = await runAlertDetection(adAccountDbId, dateEnd)
        console.log(`[Sync] Created ${alertCount} new alerts`)
      } catch (alertErr) {
        const m = alertErr instanceof Error ? alertErr.message : String(alertErr)
        console.warn('[Sync] Alert detection failed (non-fatal):', m)
        partialErrors.push(`alerts: ${m}`)
      }
    } else if (lifecycleRun) {
      console.warn('[Sync] Alert detection skipped: current Meta delivery/outcome authority is incomplete')
      partialErrors.push('alerts: skipped because current Meta delivery/outcome authority is incomplete')
    } else {
      console.log('[Sync] Ingest-only run — alert mutation skipped')
    }

    // Steps 9b→9c→10 — Durable generations: the flag → recommendation → report pipeline is a FAIL-STOP chain of
    // atomic, CAS-guarded generations. Each stage's failure records a partial error and STOPS the chain
    // (no downstream generation on a failed upstream commit) — the prior report stands, nothing is
    // half-written, and no fabricated "no recommendations" narrative is committed on a failed rec commit.
    //
    // 9b/9c are LIFECYCLE-GATED (see lifecycleRun): a historical sync must not resolve/supersede current
    // flags/recs with past data. The report (Step 10) still runs for a historical end date, but pinned to
    // that date's latest committed recommendation generation (null ⇒ the no-manifest/labeled path).
    let recGenerationId: string | null | undefined // undefined ⇒ chain fail-stopped this run → skip report
    let paidCohortPublished = !lifecycleRun
    if (canPublishDecisionEvidence(lifecycleRun, insightLevelsComplete)) {
      try {
        const publication = await publishPaidCohortPair(
          getAdminClient(),
          adAccountDbId,
          paidCohortPublicationContext({
            evaluationRunId: logId,
            asOfDate: nyToday(),
            sourceNotBefore: new Date(syncStartTime).toISOString(),
            reconcile: outcomeReconcile ?? { available: false, reason: 'reconciliation did not run' },
          }),
        )
        paidCohortPublished = true
        console.log(
          `[Sync] Paid cohort pair committed for run ${publication.evaluationRunId} ` +
          `(recent ${publication.recentGenerationId}, matured ${publication.maturedGenerationId})`,
        )
      } catch (cohortError) {
        const message = cohortError instanceof Error ? cohortError.message : String(cohortError)
        console.warn('[Sync] Paid cohort publication failed — skipping flags + recommendations + report:', message)
        partialErrors.push(`paid-cohort: ${message}`)
      }
    } else if (lifecycleRun) {
      console.warn('[Sync] One or more required insight levels failed — skipping paid cohort publication and live decisions')
    }
    // Record which gate closed BEFORE branching on it, so the record exists even if the branch throws.
    decisionGate = buildDecisionGateRecord(
      {
        lifecycleRun,
        insightLevelsComplete,
        metaOutcomeMetricsComplete: metaOutcomePlane.complete,
        paidCohortPublished,
      },
      [...metaOutcomePlane.blockerCodes],
      new Date().toISOString(),
    )
    console.log(
      decisionGate.verdict === 'live'
        ? '[Sync] Decision gate: LIVE — all four inputs true'
        : `[Sync] Decision gate: FROZEN — closed by ${decisionGate.closedBy.join(', ')}`,
    )

    if (canRunLiveDecisionPipeline(
      lifecycleRun,
      insightLevelsComplete,
      metaOutcomePlane.complete,
      paidCohortPublished,
    )) {
      let flagGen: Awaited<ReturnType<typeof runFlagEngine>> | null = null
      console.log(`[Sync] Running flag engine for ${dateEnd}`)
      try {
        // The sync's start instant is the metadata-freshness boundary — campaign upserts happened
        // AFTER it (same app clock stamps last_synced_at), so exactly the campaigns Meta confirmed this
        // run are classified/judged; everything else is frozen and counted.
        const currentRunBoundary = new Date(syncStartTime).toISOString()
        flagGen = await runFlagEngine(adAccountDbId, dateEnd, {
          metadataNotBefore: currentRunBoundary,
          insightNotBefore: currentRunBoundary,
        })
        console.log(
          `[Sync] Flag generation ${flagGen.generation_id} committed — ${flagGen.row_count} written, ` +
          `${flagGen.structural_closures} structural, ${flagGen.orphan_closures} orphan closures, ` +
          `${flagGen.unknown_metadata_flags} unknown-metadata flags${flagGen.budget_decisions_frozen ? ', BUDGET FROZEN' : ''}`
        )
        // Honest degradation: a frozen or stale-metadata run is NOT a clean success — record it
        // as a partial sync while still continuing non-fatally (cron unchanged).
        if (flagGen.budget_decisions_frozen) partialErrors.push('flags: budget decisions frozen (campaign data unreadable or no freshness boundary)')
        if ((flagGen.unresolved_referenced_campaigns ?? 0) > 0) partialErrors.push(`flags: ${flagGen.unresolved_referenced_campaigns} referenced campaign(s) with unresolved (stale/missing) metadata (frozen)`)
        if (flagGen.unknown_metadata_flags > 0) partialErrors.push(`flags: ${flagGen.unknown_metadata_flags} active budget flag(s) preserved on unknown/stale metadata`)
      } catch (flagErr) {
        const m = flagErr instanceof Error ? flagErr.message : String(flagErr)
        console.warn('[Sync] Flag generation failed — skipping recommendations + report:', m)
        partialErrors.push(`flags: ${m}`)
      }

      if (flagGen) {
        console.log(`[Sync] Generating recommendations from flags for ${dateEnd}`)
        try {
          const recGen = await generateRecommendationsFromFlags(adAccountDbId, dateEnd, flagGen.active_flags as unknown as FlagRow[], flagGen.generation_id)
          recGenerationId = recGen.generation_id
          console.log(`[Sync] Recommendation generation ${recGen.generation_id} committed (${recGen.row_count} recs)`)
        } catch (recErr) {
          const m = recErr instanceof Error ? recErr.message : String(recErr)
          console.warn('[Sync] Recommendation generation failed — skipping report:', m)
          partialErrors.push(`recommendations: ${m}`)
        }
      }
    } else if (!lifecycleRun) {
      console.log(`[Sync] Historical run (${dateEnd} ≠ current day) — decisions and current-evidence report skipped`)
    } else if (insightLevelsComplete && paidCohortPublished && !metaOutcomePlane.complete) {
      // Diagnostic-only report: current delivery remains useful, but no current flag/recommendation
      // generation may consume unavailable conversion metrics.
      recGenerationId = null
      console.warn('[Sync] Meta outcome metrics incomplete — flags/recommendations frozen; continuing diagnostic report')
    }

    // Step 10: Generate + commit the daily report, pinned to recGenerationId (non-fatal — LLM key may be
    // missing, and a stale-generation SKIP is expected under concurrency). Skipped entirely when the chain
    // fail-stopped above (recGenerationId === undefined) so the prior report is never overwritten blind.
    // A reconciled outcome source needs this run's reconciliation to cover the window. When every
    // enabled source is push-only (no reconciliation can exist) the report is produced and records how
    // its outcomes arrived. An unreadable source list keeps the reconciliation gate.
    const reportWindow = trailingInclusiveWindow(dateEnd, 30)
    if (recGenerationId !== undefined) {
      try {
        // a mixed install records the arrival of its push-only part; its reconciled part keeps the gate.
        outcomeArrival = reportOutcomeArrival(await readEnabledOutcomeSources(getAdminClient(), adAccountDbId))
      } catch (sourcesError) {
        const message = sourcesError instanceof Error ? sourcesError.message : String(sourcesError)
        partialErrors.push(`outcome-sources: ${message}`)
      }
    }
    const reportOutcomesReady = outcomeReportReady({
      lifecycleRun,
      arrival: outcomeArrival,
      reconcile: outcomeReconcile,
      startDate: reportWindow.from,
      endDate: reportWindow.to,
    })
    if (recGenerationId !== undefined && !reportOutcomesReady) {
      console.warn('[Sync] Daily report skipped: this run did not produce a complete outcome-source reconciliation covering its trailing 30-day window')
      partialErrors.push('report: current outcome source window unavailable or incomplete')
    } else if (recGenerationId !== undefined) {
      console.log(`[Sync] Generating daily report for ${dateEnd}`)
      try {
        const res = await generateDailyReport(adAccountDbId, dateEnd, recGenerationId, {
          setupGenerationId,
          sourceNotBefore: new Date(syncStartTime).toISOString(),
          metaOutcomePlane,
          outcomeArrival,
        })
        if (res.committed && typeof res.report_id === 'string') {
          committedReport = { id: res.report_id, reportDate: dateEnd }
          console.log(`[Sync] Report ${res.report_id} committed for ${dateEnd}`)
        } else {
          console.warn(`[Sync] Report not committed (${res.reason}) — prior report stands`)
          partialErrors.push(`report: ${res.reason}`)
        }
      } catch (reportErr) {
        const m = reportErr instanceof Error ? reportErr.message : String(reportErr)
        console.warn(`[Sync] Report generation skipped:`, m)
        partialErrors.push(`report: ${m}`)
      }
    }

    // Step 10b: Compatibility-only restatement for pre-evidence legacy rows. Current V3 reports are
    // excluded at the update boundary so their columns, digest, and evidence cannot diverge. Non-fatal.
    try {
      const restated = await refreshReportRollups(adAccountDbId, dateStart, dateEnd)
      if (restated > 0) console.log(`[Sync] Restated daily_reports numbers on ${restated} day(s)`)
    } catch (rollupErr) {
      const m = rollupErr instanceof Error ? rollupErr.message : String(rollupErr)
      console.warn('[Sync] Report rollup restatement failed (non-fatal):', m)
      partialErrors.push(`report-rollup-restatement: ${m}`)
    }

    // Step 11: Mark sync as success — or PARTIAL when non-fatal stage errors were recorded (a failed
    // recommendation/report stage must not read as a clean green sync). Cron continuation is unchanged.
    const durationMs = Date.now() - syncStartTime
    await updateSyncLog(logId, {
      status: partialErrors.length ? 'partial' : 'success',
      completedAt: new Date().toISOString(),
      durationMs,
      campaignsFetched: campaignCount,
      adsetsFetched: adSetCount,
      adsFetched: adCount,
      creativesFetched: creativeCount,
      insightsFetched: totalInsights,
      apiCallsMade: apiCalls.count,
      rateLimitHit: apiCalls.rateLimitHit,
      retryCount: apiCalls.retryCount,
      errorMessage: partialErrors.length ? `Partial success: ${partialErrors.join('; ')}` : undefined,
      decisionGate,
    })

    if (partialErrors.length) {
      console.warn(`[Sync] Completed in ${durationMs}ms with ${partialErrors.length} non-fatal error(s)`)
    } else {
      console.log(`[Sync] Completed in ${durationMs}ms`)
    }
    return {
      logId,
      success: true,
      metaOutcomeMetricsComplete: metaOutcomePlane.complete,
      metaOutcomeBlockerCodes: [...metaOutcomePlane.blockerCodes],
      outcomeReconcile,
      committedReport,
      outcomeArrival,
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    const durationMs = Date.now() - syncStartTime

    console.error(`[Sync] Failed after ${durationMs}ms:`, error.message)

    // Mask any tokens that might have leaked into error messages
    const safeMessage = error.message.replace(
      /\b([A-Za-z0-9]{6})[A-Za-z0-9]{5,}([A-Za-z0-9]{4})\b/g,
      (match: string, prefix: string, suffix: string) =>
        match.length > 20 ? `${prefix}...${suffix}` : match
    )

    // Surface sync failures to Sentry. Token expiry is fatal — a silent expired token caused a
    // past data outage, so it must page rather than sit unnoticed in the sync log.
    const isTokenError = getAdPlatform('meta').isApiError(err) && err.isTokenError?.()
    Sentry.captureException(error, {
      level: isTokenError ? 'fatal' : 'error',
      tags: { area: 'sync', meta_token_expired: isTokenError ? 'true' : 'false' },
    })

    await updateSyncLog(logId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      durationMs,
      apiCallsMade: apiCalls.count,
      rateLimitHit: apiCalls.rateLimitHit,
      retryCount: apiCalls.retryCount,
      errorMessage: safeMessage,
      errorCode: getAdPlatform('meta').isApiError(err) ? String(err.code ?? '') : undefined,
      errorDetails: getAdPlatform('meta').isApiError(err) ? { code: err.code, subcode: err.subcode } : undefined,
      decisionGate,
    })

    throw error
  }
}
