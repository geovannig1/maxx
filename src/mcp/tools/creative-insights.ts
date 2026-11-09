import { roundMoney } from '@/lib/utils/format-currency'
import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getCreativeCorrelations, type CorrelationResult } from '@/lib/creative/correlator'
import { computeFormatMix, type FormatMix } from '@/lib/creative/format-diversity'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import {
  normalizePersistedDeliverySubStatus,
  type DeliverySubStatusEvidence,
} from '@/lib/platforms/meta/delivery-sub-status'
import {
  readPaidCreativeOutcomes,
} from '@/lib/creative/paid-outcomes-store'
import type { PaidCreativeOutcomes } from '@/lib/creative/paid-outcomes'
import { readVisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes-store'
import type { VisionPaidAttributeOutcomes } from '@/lib/creative/vision-paid-attribute-outcomes'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

interface CreativeDeliveryObservation {
  creative_id: string
  creative_name: string | null
  thumbnail_url: string | null
  avg_ctr: number | null
  total_spend: number
  meta_bookings_estimate: number
  vision_tags: Record<string, unknown>
}

interface AdDeliverySubStatusObservation {
  ad_id: string
  ad_name: string | null
  creative_id: string | null
  delivery_sub_status: DeliverySubStatusEvidence
}

interface DiagnosticCorrelation {
  field: string
  value: string
  count: number
  avg_ctr: number | null
  meta_cpa_estimate: number | null
  meta_bookings_estimate: number
  ctr_difference_from_unweighted_baseline_pct: number | null
  meta_cpa_estimate_difference_from_unweighted_baseline_pct: number | null
  evidence_basis: 'meta_delivery_and_modelled_attribution'
}

interface DiagnosticFormatMix extends Omit<FormatMix, 'single_format_warning'> {
  single_format_observation: string | null
}

function safeVisionTags(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  if (['video', 'static', 'carousel'].includes(String(row.format))) safe.format = row.format
  for (const key of ['has_text_overlay', 'shows_price', 'cta_visible'] as const) {
    if (typeof row[key] === 'boolean') safe[key] = row[key]
  }
  if (['solo', 'group', 'broll', 'none'].includes(String(row.talent_type))) {
    safe.talent_type = row.talent_type
  }
  if (['studio', 'outdoor', 'other'].includes(String(row.setting))) safe.setting = row.setting
  if (['bright', 'dark', 'warm', 'neutral'].includes(String(row.color_mood))) {
    safe.color_mood = row.color_mood
  }
  return safe
}

function projectDiagnosticFormatMix(formatMix: FormatMix): DiagnosticFormatMix {
  const onlyKnownFormat = formatMix.shares.filter((share) => share.format !== 'unknown')
  const singleFormatObservation = formatMix.single_format_warning && onlyKnownFormat.length === 1
    ? `All ${formatMix.total_creatives} observed creatives share the ${onlyKnownFormat[0].format} format.`
    : null
  const { total_creatives, total_spend, shares } = formatMix
  return { total_creatives, total_spend, shares, single_format_observation: singleFormatObservation }
}

function projectDiagnosticCorrelations(correlations: CorrelationResult[]): DiagnosticCorrelation[] {
  return correlations.map((correlation) => ({
    field: correlation.field,
    value: correlation.value,
    count: correlation.count,
    avg_ctr: correlation.avg_ctr,
    meta_cpa_estimate: correlation.avg_cpa,
    meta_bookings_estimate: correlation.avg_bookings,
    ctr_difference_from_unweighted_baseline_pct: correlation.vs_baseline_ctr,
    meta_cpa_estimate_difference_from_unweighted_baseline_pct: correlation.vs_baseline_cpa,
    evidence_basis: 'meta_delivery_and_modelled_attribution',
  }))
}

function buildInsightSummary(correlations: DiagnosticCorrelation[]): string {
  if (correlations.length === 0) return 'No creative-attribute delivery observations are available for this window.'
  return `${correlations.length} descriptive creative-attribute groups observed. No comparative verdict or creative direction is supplied.`
}

interface PaidOutcomesReadUnavailable {
  status: 'read_unavailable'
  reason: string
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
}

type PaidOutcomesPlane = PaidCreativeOutcomes | PaidOutcomesReadUnavailable
type PaidAttributeDistributionsPlane = VisionPaidAttributeOutcomes | PaidOutcomesReadUnavailable
type SupabaseErrorLike = { code?: string | null; message?: string | null }

function isMissingDeliverySubStatusColumns(error: SupabaseErrorLike | null): boolean {
  if (!error) return false
  const message = error.message ?? ''
  return /delivery_sub_status/i.test(message) && /does not exist|not exist|unknown column|undefined column/i.test(message)
}

/** A generic reason for the tool result; the source detail is logged to stderr only. */
function redactedReason(error: unknown): string {
  return logToolError('get_creative_insights', 'CREATIVE_INSIGHTS_SOURCE_READ_FAILED', error)
}

function unavailablePaidOutcomes(reason: string): PaidOutcomesReadUnavailable {
  return {
    status: 'read_unavailable',
    reason,
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
  }
}

function unavailableCreativeInsights(
  errorCode: string,
  reason: string,
  paidOutcomes: PaidOutcomesPlane,
  paidAttributeDistributions: PaidAttributeDistributionsPlane,
) {
  return {
    status: 'unavailable' as const,
    error_code: errorCode,
    unavailable_reason: reason,
    action_authority_tier: 'diagnostic_only' as const,
    setup_guidance_status: 'withheld' as const,
    prescriptions: [] as [],
    correlations: [] as DiagnosticCorrelation[],
    creative_delivery_observations: [] as CreativeDeliveryObservation[],
    ad_delivery_sub_statuses: [] as AdDeliverySubStatusObservation[],
    paid_outcomes: paidOutcomes,
    paid_attribute_distributions: paidAttributeDistributions,
  }
}

async function getCreativeDeliveryObservations(
  adAccountDbId: string,
  range: { start: string; end: string },
  limit = 10
): Promise<{
  observations: CreativeDeliveryObservation[]
  ad_delivery_sub_statuses: AdDeliverySubStatusObservation[]
  format_mix: DiagnosticFormatMix
}> {
  const supabase = getAdminClient()
  const emptyMix = projectDiagnosticFormatMix(computeFormatMix([]))

  // Fetch ad-level insights with creative data via ads join
  const richSelect =
    `ad_id, spend, ${OW.many}, clicks, impressions, ads!inner(ad_id, ad_name, creative_id, ad_account_id, delivery_sub_status, delivery_sub_status_read_available, delivery_sub_status_synced_at, creatives(id, creative_name, thumbnail_url, vision_analysis, asset_type, video_id))`
  const baselineSelect =
    `ad_id, spend, ${OW.many}, clicks, impressions, ads!inner(ad_id, ad_name, creative_id, ad_account_id, creatives(id, creative_name, thumbnail_url, vision_analysis, asset_type, video_id))`

  const read = (selectClause: string) => supabase
    .from('daily_insights')
    .select(selectClause)
    .eq('ad_account_id', adAccountDbId)
    .eq('entity_level', 'ad')
    .eq('ads.ad_account_id', adAccountDbId)
    .gte('date_start', range.start)
    .lte('date_start', range.end)
    .not('ad_id', 'is', null)

  let deliveryColumnsAvailable = true
  let { data, error } = await read(richSelect)
  if (isMissingDeliverySubStatusColumns(error)) {
    const fallback = await read(baselineSelect)
    data = fallback.data
    error = fallback.error
    deliveryColumnsAvailable = false
  }
  if (error) {
    throw new Error(`Creative delivery observation read failed: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return { observations: [], ad_delivery_sub_statuses: [], format_mix: emptyMix }
  }

  // Aggregate per creative
  const byCreative = new Map<
    string,
    {
      spend: number
      bookings: number
      clicks: number
      impressions: number
      creative_name: string | null
      thumbnail_url: string | null
      vision_analysis: Record<string, unknown> | null
      asset_type: string | null
      video_id: string | null
    }
  >()
  const byAd = new Map<string, AdDeliverySubStatusObservation>()

  const rows = data as unknown as Array<{
    ads?: unknown
    spend?: number | null
    bookings?: number | null
    clicks?: number | null
    impressions?: number | null
  }>
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ad = row.ads as any
    const creative = ad?.creatives ?? null
    const creativeDbId = ad?.creative_id as string | null
    const metaAdId = typeof ad?.ad_id === 'string' ? ad.ad_id : null
    if (metaAdId && !byAd.has(metaAdId)) {
      byAd.set(metaAdId, {
        ad_id: metaAdId,
        ad_name: typeof ad.ad_name === 'string' ? ad.ad_name : null,
        creative_id: typeof creativeDbId === 'string' ? creativeDbId : null,
        delivery_sub_status: deliveryColumnsAvailable
          ? normalizePersistedDeliverySubStatus(
            ad.delivery_sub_status,
            ad.delivery_sub_status_read_available,
            ad.delivery_sub_status_synced_at,
          )
          : normalizePersistedDeliverySubStatus(null, false, null),
      })
    }
    if (!creativeDbId || !creative) continue

    const existing = byCreative.get(creativeDbId)
    if (!existing) {
      byCreative.set(creativeDbId, {
        spend: row.spend ?? 0,
        bookings: row.bookings ?? 0,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        creative_name: creative.creative_name ?? null,
        thumbnail_url: creative.thumbnail_url ?? null,
        vision_analysis: creative.vision_analysis ?? null,
        asset_type: creative.asset_type ?? null,
        video_id: creative.video_id ?? null,
      })
    } else {
      existing.spend += row.spend ?? 0
      existing.bookings += row.bookings ?? 0
      existing.clicks += row.clicks ?? 0
      existing.impressions += row.impressions ?? 0
    }
  }

  // avg_ctr is recomputed from summed clicks/impressions. Spend order describes where delivery occurred;
  // it does not classify performance or select a creative for production.
  const results: CreativeDeliveryObservation[] = Array.from(byCreative.entries())
    .map(([id, agg]) => ({
      creative_id: id,
      creative_name: agg.creative_name,
      thumbnail_url: agg.thumbnail_url,
      avg_ctr: agg.impressions > 0 ? Math.round(((agg.clicks * 100) / agg.impressions) * 1000000) / 1000000 : null,
      total_spend: roundMoney(agg.spend),
      meta_bookings_estimate: agg.bookings,
      vision_tags: safeVisionTags(agg.vision_analysis),
    }))
    .sort((a, b) => b.total_spend - a.total_spend || a.creative_id.localeCompare(b.creative_id))
    .slice(0, limit)

  // Format mix across ALL creatives that delivered in the window (not just the top N).
  const format_mix = projectDiagnosticFormatMix(computeFormatMix(
    Array.from(byCreative.values()).map((agg) => ({ asset_type: agg.asset_type, video_id: agg.video_id, spend: agg.spend })),
  ))

  const ad_delivery_sub_statuses = Array.from(byAd.values())
    .sort((left, right) => left.ad_id.localeCompare(right.ad_id))

  return { observations: results, ad_delivery_sub_statuses, format_mix }
}

async function readMetaCreativeInsights(
  adAccountId: string,
  range: { start: string; end: string },
): Promise<object> {
  const [correlations, creatives] = await Promise.all([
    getCreativeCorrelations(adAccountId, range),
    getCreativeDeliveryObservations(adAccountId, range, 10),
  ])
  const diagnosticCorrelations = projectDiagnosticCorrelations(correlations)
  const periodDays = Math.round(
    (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000,
  ) + 1
  return {
    status: 'available',
    period_days: periodDays,
    period: range,
    action_authority_tier: 'diagnostic_only',
    setup_guidance_status: 'withheld',
    prescriptions: [],
    correlations: diagnosticCorrelations,
    creative_delivery_observations: creatives.observations,
    ad_delivery_sub_statuses: creatives.ad_delivery_sub_statuses,
    format_mix: creatives.format_mix,
    insight_summary: buildInsightSummary(diagnosticCorrelations),
    note: 'Descriptive Meta delivery and modelled-attribution observations only. Delivery sub-status stays per ad and is never promoted to a reused-creative verdict. No comparative performance verdict or creative-production direction is supplied.',
  }
}

export async function getCreativeInsights(args: {
  days?: number
  start_date?: string
  end_date?: string
}): Promise<object> {
  const hasStart = args.start_date !== undefined
  const hasEnd = args.end_date !== undefined
  if (hasStart !== hasEnd) throw new ToolInputError('Creative insights start_date and end_date must be provided together.')
  if (hasStart && args.days !== undefined) {
    throw new ToolInputError('Creative insights accepts either an explicit date range or days, not both.')
  }
  const requestedDays = args.days ?? 30
  if (!Number.isSafeInteger(requestedDays)) throw new ToolInputError('Creative insights days must be an integer.')
  const days = Math.min(Math.max(requestedDays, 1), 90)
  const explicitRange = hasStart && hasEnd
    ? resolveClosedDateRange(args.start_date, args.end_date)
    : null
  const range = explicitRange
    ? { start: explicitRange.start, end: explicitRange.end }
    : { start: nyDaysAgo(days), end: nyDaysAgo(1) }
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const reason = `Creative insights are unavailable because active account ownership is ${activeAccount.reason}.`
    return unavailableCreativeInsights(
      activeAccountErrorCode(activeAccount.reason),
      reason,
      unavailablePaidOutcomes(reason),
      unavailablePaidOutcomes(reason),
    )
  }

  const [metaResult, paidResult] = await Promise.allSettled([
    readMetaCreativeInsights(activeAccount.account.id, range),
    readPaidCreativeOutcomes(db, activeAccount.account.id),
  ])
  const paidOutcomes = paidResult.status === 'fulfilled'
    ? paidResult.value
    : unavailablePaidOutcomes(redactedReason(paidResult.reason))
  let paidAttributeDistributions: PaidAttributeDistributionsPlane
  if (paidResult.status === 'fulfilled') {
    try {
      paidAttributeDistributions = await readVisionPaidAttributeOutcomes(
        db,
        activeAccount.account.id,
        paidResult.value,
      )
    } catch (error) {
      paidAttributeDistributions = unavailablePaidOutcomes(redactedReason(error))
    }
  } else {
    paidAttributeDistributions = unavailablePaidOutcomes(
      `Paid creative outcomes are unavailable: ${redactedReason(paidResult.reason)}`,
    )
  }

  if (metaResult.status === 'rejected') {
    return unavailableCreativeInsights(
      'CREATIVE_INSIGHTS_READ_UNAVAILABLE',
      `Creative insights could not be read: ${redactedReason(metaResult.reason)}`,
      paidOutcomes,
      paidAttributeDistributions,
    )
  }
  return {
    ...metaResult.value,
    paid_outcomes: paidOutcomes,
    paid_attribute_distributions: paidAttributeDistributions,
  }
}
