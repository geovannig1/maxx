import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaidCohortEvidence } from '@/lib/attribution/paid-cohort-reader'
import type { PaidEligibilityManifestWindowProof } from '@/lib/attribution/paid-eligibility-manifest'
import { inclusiveAccountDates } from '@/lib/economics/account-date-window'
import { computeActiveAccountDailyBudget } from '@/lib/economics/pragmatic-profit-evidence'
import { loadAccountPlatform } from '@/lib/platforms/account-platform'
import type { AdPlatform } from '@/lib/platforms/types'
import { getAdminClient } from '@/lib/supabase/admin'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import type {
  CockpitRange,
  MetaDeliveryEvidence,
  PaidAssociationEvidence,
  PartialTodayEvidence,
} from './evidence'

type InsightRow = {
  date_start: unknown
  date_stop: unknown
  meta_campaign_id?: unknown
  spend: unknown
  bookings: unknown
  impressions: unknown
  link_clicks: unknown
  frequency: unknown
  actions: unknown
  action_values: unknown
}

type MetaAction = { action_type?: unknown; value?: unknown }

const CANONICAL_PURCHASE_ACTION = 'purchase'
const CANONICAL_LEAD_ACTION = 'lead'

type SyncGenerationRow = {
  status: unknown
  date_range_start: unknown
  date_range_end: unknown
  completed_at: unknown
  insights_fetched?: unknown
  decision_gate?: unknown
}

type DeliveryDecisionGate = {
  gates?: {
    insightLevelsComplete?: unknown
    metaOutcomeMetricsComplete?: unknown
  }
}

function nonnegativeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readSingleCanonicalAction(
  raw: unknown,
  actionType: string,
): { matched: boolean; value: number | null; ambiguous: boolean } {
  if (!Array.isArray(raw)) return { matched: false, value: null, ambiguous: false }
  const matches = raw.filter((entry): entry is MetaAction => (
    typeof entry === 'object' && entry !== null
      && (entry as MetaAction).action_type === actionType
  ))
  if (matches.length === 0) return { matched: false, value: null, ambiguous: false }
  if (matches.length !== 1) return { matched: true, value: null, ambiguous: true }
  const value = nonnegativeNumber(matches[0].value)
  return { matched: true, value, ambiguous: value === null }
}

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function hasExactManifestPopulation(
  cohort: PaidCohortEvidence,
  manifest: PaidEligibilityManifestWindowProof,
): boolean {
  const generationMetrics = cohort.generationMetrics
  const expected = [
    [cohort.capturedTouches, manifest.capture.captured],
    [generationMetrics?.capture_eligible_inputs, manifest.capture.eligible],
    [generationMetrics?.manifest_captured_touches, manifest.capture.captured],
    [generationMetrics?.linker_eligible_appointments, manifest.linker.eligible],
    [generationMetrics?.linker_evaluated_appointments, manifest.linker.evaluated],
    [generationMetrics?.manifest_linked_appointments, manifest.linker.linked],
  ] as const
  return expected.every(([left, right]) => (
    typeof left === 'number' && Number.isSafeInteger(left) && left >= 0 && left === right
  ))
}

function readCoveringMetaGeneration(
  rows: SyncGenerationRow[],
  range: CockpitRange,
): { synchronizedAt: string | null; blockerCodes: string[] } {
  const covering = rows.filter((row) => typeof row.date_range_start === 'string'
    && typeof row.date_range_end === 'string'
    && row.date_range_start <= range.start
    && row.date_range_end >= range.end
    && typeof row.completed_at === 'string'
    && Number.isFinite(Date.parse(row.completed_at)))
  if (covering.length === 0) {
    return { synchronizedAt: null, blockerCodes: ['meta_sync_generation_window_uncovered'] }
  }
  const latest = [...covering].sort((left, right) =>
    Date.parse(String(right.completed_at)) - Date.parse(String(left.completed_at)))[0]
  const decisionGate = latest.decision_gate
  const deliveryGate = typeof decisionGate === 'object' && decisionGate !== null
    ? decisionGate as DeliveryDecisionGate
    : null
  const partialDeliveryComplete = latest.status === 'partial'
    && nonnegativeNumber(latest.insights_fetched) !== null
    && nonnegativeNumber(latest.insights_fetched)! > 0
    && deliveryGate?.gates?.insightLevelsComplete === true
    && deliveryGate.gates.metaOutcomeMetricsComplete === true
  if (latest.status !== 'success' && !partialDeliveryComplete) {
    return { synchronizedAt: null, blockerCodes: ['meta_sync_generation_not_successful'] }
  }
  return { synchronizedAt: latest.completed_at as string, blockerCodes: [] }
}

type NativePeriodInsightRow = {
  date_start?: unknown
  date_stop?: unknown
  reach?: unknown
  frequency?: unknown
}

type NativePeriodDelivery = {
  frequency: number | null
  reach: number | null
  blockerCodes: string[]
}

async function readNativePeriodDelivery(
  db: SupabaseClient,
  adAccountId: string,
  metaAccountId: string,
  range: CockpitRange,
  generationBlockerCodes: readonly string[],
): Promise<NativePeriodDelivery> {
  if (generationBlockerCodes.length > 0) {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_freshness_unavailable'],
    }
  }
  if (metaAccountId.trim().length === 0) {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_account_scope_invalid'],
    }
  }

  let platform: AdPlatform
  try {
    platform = await loadAccountPlatform(db, adAccountId)
  } catch {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_platform_unavailable'],
    }
  }

  let rows: NativePeriodInsightRow[]
  try {
    rows = await platform.insights.fetchPeriodDelivery({
      accountId: metaAccountId,
      since: range.start,
      until: range.end,
    })
  } catch {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_query_failed'],
    }
  }

  if (!Array.isArray(rows) || rows.length !== 1) {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_coverage_invalid'],
    }
  }
  const row = rows[0]
  if (row.date_start !== range.start || row.date_stop !== range.end) {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_all_days_window_mismatch'],
    }
  }
  const frequency = nonnegativeNumber(row.frequency)
  if (frequency === null) {
    return {
      frequency: null,
      reach: null,
      blockerCodes: ['meta_native_period_frequency_missing'],
    }
  }
  return {
    frequency,
    reach: nonnegativeNumber(row.reach),
    blockerCodes: [],
  }
}

/**
 * One blocker code per absent day is UNBOUNDED, and the array it lands in is not.
 *
 * `builder.ts` spreads a source's `blockerCodes` into every claim it produces -- ten per window --
 * and both comparison windows carry their own copy. A wide request multiplies one code per day by
 * that fan-out: the shipped one-click YTD preset (`DATE_PRESETS`, persisted in the URL) can have
 * well over a hundred absent days in its current window and more in its prior one whenever
 * `daily_insights` account rows only begin partway through the year.
 *
 * That pushed the governed cockpit payload past `MAX_TOOL_RESULT_CHARS`, and the consequence is not
 * a shorter answer: `chat.ts` registers claims only `if (!truncated)`, so the model receives an
 * unparseable preview and the turn ends in "a governed lookup that does publish citable claims
 * returned none this time". The chat loses ALL its evidence on a preset the owner can click.
 *
 * So the enumeration is capped and the remainder stated as a count. Diagnosis keeps the first few
 * dates AND the true total; availability is untouched, because `spendAvailable` still turns on
 * `spendBlockers.length === 0` and this returns a non-empty list whenever any day is absent.
 */
const MAX_ENUMERATED_DAY_CODES = 5

export function boundedDayCodes(family: string, dates: readonly string[]): string[] {
  if (dates.length <= MAX_ENUMERATED_DAY_CODES) return dates.map((date) => `${family}:${date}`)
  return [
    ...dates.slice(0, MAX_ENUMERATED_DAY_CODES).map((date) => `${family}:${date}`),
    `${family}_count:${dates.length}`,
  ]
}

export async function readMetaDelivery(
  db: SupabaseClient,
  adAccountId: string,
  metaAccountId: string,
  range: CockpitRange,
): Promise<MetaDeliveryEvidence> {
  const expectedDates = inclusiveAccountDates(range.start, range.end)
  const base = (level: 'account' | 'campaign') => db.from('daily_insights')
    .select('date_start,date_stop,meta_campaign_id,spend,bookings,impressions,link_clicks,frequency,actions,action_values')
    .eq('ad_account_id', adAccountId)
    .eq('entity_level', level)
    .gte('date_start', range.start)
    .lte('date_start', range.end)
    .order('date_start', { ascending: true })
  const [accountResult, campaignResult, generationResult] = await Promise.all([
    base('account').limit(expectedDates.length + 1),
    base('campaign').limit(expectedDates.length * 100 + 1),
    db.from('api_sync_logs')
      .select('status,date_range_start,date_range_end,completed_at,insights_fetched,decision_gate')
      .eq('ad_account_id', adAccountId)
      .order('completed_at', { ascending: false })
      .limit(100),
  ])
  if (accountResult.error || !Array.isArray(accountResult.data)) {
    return {
      available: false, spendAvailable: false, resultsAvailable: false,
      purchaseAvailable: false, leadAvailable: false, linkCtrAvailable: false, cpmAvailable: false, frequencyAvailable: false,
      spend: null, results: null, purchaseValue: null, purchaseCount: null, leads: null,
      linkClicks: null, impressions: null, nativeFrequency: null, nativeReach: null,
      dailyBudget: null, spendCoveredDays: 0, coveredDays: 0, expectedDays: expectedDates.length,
      synchronizedAt: null, blockerCodes: ['meta_delivery_read_failed'],
    }
  }

  const accountRows = accountResult.data as InsightRow[]
  const generation = generationResult.error || !Array.isArray(generationResult.data)
    ? { synchronizedAt: null, blockerCodes: ['meta_sync_generation_read_failed'] }
    : readCoveringMetaGeneration(generationResult.data as SyncGenerationRow[], range)
  const accountByDate = new Map<string, InsightRow>()
  const spendBlockers: string[] = []
  const incompleteDates: string[] = []
  for (const row of accountRows) {
    if (typeof row.date_start !== 'string' || !expectedDates.includes(row.date_start)
        || row.date_stop !== row.date_start || accountByDate.has(row.date_start)) {
      spendBlockers.push('meta_account_spend_window_invalid')
      continue
    }
    if (nonnegativeNumber(row.spend) === null) incompleteDates.push(row.date_start)
    accountByDate.set(row.date_start, row)
  }
  spendBlockers.push(...boundedDayCodes('meta_account_spend_day_incomplete', incompleteDates))
  spendBlockers.push(...boundedDayCodes(
    'meta_account_spend_day_missing',
    expectedDates.filter((date) => !accountByDate.has(date)),
  ))
  const spendAvailable = spendBlockers.length === 0 && generation.blockerCodes.length === 0
  const accountSpendByDate = new Map(expectedDates.map((date) => [
    date,
    spendAvailable ? nonnegativeNumber(accountByDate.get(date)!.spend)! : 0,
  ]))

  const resultBlockers: string[] = []
  const campaignRows = Array.isArray(campaignResult.data) ? campaignResult.data as InsightRow[] : []
  if (campaignResult.error || !Array.isArray(campaignResult.data)) {
    resultBlockers.push('meta_campaign_results_read_failed')
  } else if (campaignRows.length > expectedDates.length * 100) {
    resultBlockers.push('meta_campaign_results_page_limit_exceeded')
  }
  const campaignByKey = new Map<string, InsightRow>()
  for (const row of campaignRows) {
    const campaignId = row.meta_campaign_id
    if (typeof row.date_start !== 'string' || !expectedDates.includes(row.date_start)
        || row.date_stop !== row.date_start || typeof campaignId !== 'string' || campaignId.length === 0) {
      resultBlockers.push('meta_campaign_result_identity_invalid')
      continue
    }
    const key = `${row.date_start}:${campaignId}`
    if (campaignByKey.has(key)) resultBlockers.push('meta_campaign_result_duplicate')
    campaignByKey.set(key, row)
    const rowSpend = nonnegativeNumber(row.spend)
    if (rowSpend === null || nonnegativeNumber(row.bookings) === null) {
      resultBlockers.push(`meta_campaign_result_incomplete:${key}`)
    }
  }
  if (spendAvailable) {
    for (const date of expectedDates) {
      const accountSpend = accountSpendByDate.get(date)!
      const campaignSpend = campaignRows
        .filter((row) => row.date_start === date)
        .reduce((sum, row) => sum + (nonnegativeNumber(row.spend) ?? 0), 0)
      // Additive totals reconcile to one minor unit of the account currency (a cent, a yen, a fil).
      // Percentage tolerances can hide a missing campaign at scale and are forbidden for a canonical Results claim.
      if (Math.abs(campaignSpend - accountSpend) > 10 ** -currencyFractionDigits()) {
        resultBlockers.push(`meta_campaign_spend_reconciliation_failed:${date}`)
      }
    }
  } else {
    resultBlockers.push('meta_account_spend_unavailable_for_result_reconciliation')
  }

  const resultsAvailable = resultBlockers.length === 0 && generation.blockerCodes.length === 0
  const metricBlockers: string[] = []
  let purchaseValue = 0
  let purchaseCount = 0
  let sawPurchase = false
  let leads = 0
  let sawLead = false
  let linkClicks = 0
  let impressions = 0
  let linkCtrAvailable = spendAvailable
  let cpmAvailable = spendAvailable
  for (const date of expectedDates) {
    const row = accountByDate.get(date)
    if (!row) continue
    const purchaseCountRead = readSingleCanonicalAction(row.actions, CANONICAL_PURCHASE_ACTION)
    const purchaseValueRead = readSingleCanonicalAction(row.action_values, CANONICAL_PURCHASE_ACTION)
    if (purchaseCountRead.matched || purchaseValueRead.matched) sawPurchase = true
    if (purchaseCountRead.ambiguous || purchaseValueRead.ambiguous
        || purchaseCountRead.matched !== purchaseValueRead.matched
        || (purchaseCountRead.matched && (purchaseCountRead.value === null || purchaseValueRead.value === null))) {
      metricBlockers.push(`meta_purchase_canonical_pair_invalid:${date}`)
    } else if (purchaseCountRead.matched && purchaseValueRead.matched) {
      purchaseCount += purchaseCountRead.value!
      purchaseValue += purchaseValueRead.value!
    }

    const leadRead = readSingleCanonicalAction(row.actions, CANONICAL_LEAD_ACTION)
    if (leadRead.matched) sawLead = true
    if (leadRead.ambiguous) metricBlockers.push(`meta_lead_canonical_action_invalid:${date}`)
    else if (leadRead.matched) leads += leadRead.value!

    const rowLinkClicks = nonnegativeNumber(row.link_clicks)
    const rowImpressions = nonnegativeNumber(row.impressions)
    if (rowLinkClicks === null) {
      linkCtrAvailable = false
      metricBlockers.push(`meta_link_clicks_missing:${date}`)
    } else {
      linkClicks += rowLinkClicks
    }
    if (rowImpressions === null) {
      linkCtrAvailable = false
      cpmAvailable = false
      metricBlockers.push(`meta_impressions_missing:${date}`)
    } else {
      impressions += rowImpressions
    }
  }
  if (!sawPurchase) metricBlockers.push('meta_purchase_canonical_action_missing')
  const purchaseAvailable = spendAvailable && sawPurchase
    && !metricBlockers.some((code) => code.startsWith('meta_purchase_'))
  const leadAvailable = spendAvailable && sawLead
    && !metricBlockers.some((code) => code.startsWith('meta_lead_'))
  const nativePeriod = await readNativePeriodDelivery(db, adAccountId, metaAccountId, range, generation.blockerCodes)
  const frequencyAvailable = spendAvailable && nativePeriod.frequency !== null && nativePeriod.blockerCodes.length === 0
  return {
    available: spendAvailable && resultsAvailable,
    spendAvailable,
    resultsAvailable,
    purchaseAvailable,
    leadAvailable,
    linkCtrAvailable: linkCtrAvailable && impressions > 0,
    cpmAvailable: cpmAvailable && impressions > 0,
    frequencyAvailable,
    spend: spendAvailable ? expectedDates.reduce((sum, date) => sum + accountSpendByDate.get(date)!, 0) : null,
    results: resultsAvailable
      ? campaignRows.reduce((sum, row) => sum + (nonnegativeNumber(row.bookings) ?? 0), 0)
      : null,
    purchaseValue: purchaseAvailable ? purchaseValue : null,
    purchaseCount: purchaseAvailable ? purchaseCount : null,
    leads: leadAvailable ? leads : null,
    linkClicks: linkCtrAvailable && impressions > 0 ? linkClicks : null,
    impressions: cpmAvailable && impressions > 0 ? impressions : null,
    nativeFrequency: frequencyAvailable ? nativePeriod.frequency : null,
    nativeReach: frequencyAvailable ? nativePeriod.reach : null,
    dailyBudget: null,
    spendCoveredDays: accountByDate.size,
    coveredDays: spendAvailable && resultsAvailable ? expectedDates.length : 0,
    expectedDays: expectedDates.length,
    synchronizedAt: generation.synchronizedAt,
    blockerCodes: sorted([
      ...generation.blockerCodes,
      ...spendBlockers,
      ...resultBlockers,
      ...metricBlockers,
      ...nativePeriod.blockerCodes,
    ]),
  }
}

export async function readDailyBudget(db: SupabaseClient, adAccountId: string): Promise<number | null> {
  // The cockpit must use the same CBO/ABO-safe computation as authority. Summing every active
  // ad-set budget first double-counts CBO children and makes mixed accounts look over-budget.
  return computeActiveAccountDailyBudget(
    db as ReturnType<typeof getAdminClient>,
    adAccountId,
  )
}

export async function readPartialToday(
  db: SupabaseClient,
  adAccountId: string,
  date: string,
  dailyBudget: number | null,
): Promise<PartialTodayEvidence> {
  const result = await db.from('daily_insights')
    .select('date_start,date_stop,spend,synced_at')
    .eq('ad_account_id', adAccountId).eq('entity_level', 'account')
    .eq('date_start', date).order('synced_at', { ascending: false }).limit(2)
  if (result.error || !Array.isArray(result.data)) {
    return { available: false, date, spend: null, dailyBudget, synchronizedAt: null, blockerCodes: ['partial_today_read_failed'] }
  }
  if (result.data.length !== 1) {
    return {
      available: false, date, spend: null, dailyBudget, synchronizedAt: null,
      blockerCodes: [result.data.length === 0 ? 'partial_today_not_yet_available' : 'partial_today_duplicate_rows'],
    }
  }
  const row = result.data[0]
  const spend = nonnegativeNumber(row.spend)
  if (row.date_start !== date || row.date_stop !== date || spend === null) {
    return { available: false, date, spend: null, dailyBudget, synchronizedAt: null, blockerCodes: ['partial_today_row_invalid'] }
  }
  return {
    available: true, date, spend, dailyBudget,
    synchronizedAt: typeof row.synced_at === 'string' ? row.synced_at : null,
    blockerCodes: [],
  }
}

export function paidEvidenceFromCohort(
  cohort: PaidCohortEvidence | null,
  manifest: PaidEligibilityManifestWindowProof | null,
  evaluationRunId: string | null,
): PaidAssociationEvidence {
  if (!cohort) {
    return {
      available: false, evaluationRunId: null, window: null, spend: null, recordedRevenue: null, coverage: null,
      completenessProof: null,
      synchronizedAt: manifest?.synchronizedAt ?? null, blockerCodes: ['paid_cohort_unavailable'],
    }
  }
  const manifestMatchesRun = manifest !== null && evaluationRunId !== null
    && manifest.evaluationRunId === evaluationRunId
  const manifestMatchesCohort = manifestMatchesRun && manifest !== null
    && cohort.policyVersion === 3
    && manifest.window.start === cohort.windowStart
    && manifest.window.end === cohort.windowEnd
  const populationMatches = manifestMatchesCohort && manifest !== null
    && hasExactManifestPopulation(cohort, manifest)
  const manifestComplete = populationMatches && manifest !== null
    && manifest.capture.complete
    && manifest.linker.complete
    && manifest.capture.captured === manifest.capture.eligible
    && manifest.linker.evaluated === manifest.linker.eligible
    && manifest.blockerCodes.length === 0
  const revenue = nonnegativeNumber(cohort.metrics.outcome_recorded_revenue)
  return {
    available: cohort.complete && cohort.generationComplete && manifestComplete
      && revenue !== null && cohort.spend !== null,
    evaluationRunId,
    window: { start: cohort.windowStart, end: cohort.windowEnd },
    spend: cohort.spend,
    recordedRevenue: revenue,
    coverage: populationMatches && manifest ? { numerator: manifest.linker.evaluated, denominator: manifest.linker.eligible } : null,
    completenessProof: populationMatches && manifest ? {
      policyVersion: manifest.policyVersion,
      evaluationRunId: manifest.evaluationRunId,
      captureComplete: manifest.capture.complete,
      linkerComplete: manifest.linker.complete,
      captureEligibleInputs: manifest.capture.eligible,
      capturedTouches: manifest.capture.captured,
      eligibleAppointments: manifest.linker.eligible,
      evaluatedAppointments: manifest.linker.evaluated,
      linkedAppointments: manifest.linker.linked,
      blockerCodes: [...manifest.blockerCodes],
    } : null,
    synchronizedAt: manifest?.synchronizedAt ?? null,
    blockerCodes: sorted([
      ...cohort.generationBlockerCodes,
      ...cohort.blockerCodes,
      ...(manifest?.blockerCodes ?? []),
      ...(!manifestMatchesRun ? ['paid_completeness_manifest_run_mismatch'] : []),
      ...(cohort.policyVersion !== 3 ? ['paid_cohort_policy_v3_required'] : []),
      ...(manifestMatchesRun && manifest
        && (manifest.window.start !== cohort.windowStart || manifest.window.end !== cohort.windowEnd)
        ? ['paid_completeness_manifest_window_mismatch'] : []),
      ...(manifestMatchesCohort && !populationMatches ? ['paid_completeness_manifest_population_mismatch'] : []),
    ]),
  }
}

export function selectExactPaidCohortEvidence(
  pair: { recentScale: PaidCohortEvidence; maturedCut: PaidCohortEvidence } | null,
  range: { start: string; end: string },
): PaidCohortEvidence | null {
  if (!pair) return null
  return [pair.recentScale, pair.maturedCut].find(
    (cohort) => cohort.windowStart === range.start && cohort.windowEnd === range.end,
  ) ?? null
}
