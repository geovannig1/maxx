import { roundMoney } from '@/lib/utils/format-currency'
import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getSupabaseClient } from '../lib/supabase'
import { sanitizeObject } from '../lib/sanitize'
import { validateDateRange } from '../lib/validation'
import { checkRateLimit } from '../lib/rate-limit'
import {
  normalizePersistedDeliverySubStatus,
  type DeliverySubStatusEvidence,
} from '@/lib/platforms/meta/delivery-sub-status'

interface DailyFrequencyObservation {
  date: string
  frequency: number
}

interface DeliveryEvidence {
  action_authority_tier: 'diagnostic_only'
  evidence_state: 'observed' | 'limited'
  observation: string
  prescriptions: []
}

interface AdAggregate {
  spend: number
  metaLeadsEstimate: number
  impressions: number
  clicks: number
  adName: string
  creativeId: string | null
  dailyFrequency: DailyFrequencyObservation[]
  deliverySubStatus: DeliverySubStatusEvidence
}

type SupabaseErrorLike = { code?: string | null; message?: string | null }

function isMissingDeliverySubStatusColumns(error: SupabaseErrorLike | null): boolean {
  if (!error) return false
  const message = error.message ?? ''
  return /delivery_sub_status/i.test(message) && /does not exist|not exist|unknown column|undefined column/i.test(message)
}

function finiteNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** PURE: describe whether delivery telemetry exists. This never classifies a creative or emits a decision. */
export function describeDeliveryEvidence(input: {
  impressions: number
  frequencyObservationCount: number
}): DeliveryEvidence {
  const hasEvidence = input.impressions > 0 || input.frequencyObservationCount > 0
  return {
    action_authority_tier: 'diagnostic_only',
    evidence_state: hasEvidence ? 'observed' : 'limited',
    observation: hasEvidence
      ? 'Meta delivery telemetry was observed. Daily frequency values are reported without a performance classification.'
      : 'No impressions or daily frequency values were observed for this ad in the selected window.',
    prescriptions: [],
  }
}

function unavailableCreativeDelivery(errorCode: string, reason: string, period: { start: string; end: string }) {
  return {
    status: 'unavailable' as const,
    error_code: errorCode,
    unavailable_reason: reason,
    period,
    action_authority_tier: 'diagnostic_only' as const,
    prescriptions: [] as [],
    ads: [],
    total: 0,
  }
}

export async function getCreativeFatigue(args: {
  start_date?: string
  end_date?: string
  min_spend?: number
}) {
  checkRateLimit('get_creative_performance')
  const { start, end } = validateDateRange(args.start_date, args.end_date)
  const period = { start, end }
  if (args.min_spend !== undefined && (!Number.isFinite(args.min_spend) || args.min_spend < 0)) {
    throw new ToolInputError('min_spend must be a non-negative finite number')
  }

  const db = getSupabaseClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return unavailableCreativeDelivery(
      activeAccountErrorCode(activeAccount.reason),
      `Creative delivery evidence is unavailable because active account ownership is ${activeAccount.reason}.`,
      period,
    )
  }
  const adAccountId = activeAccount.account.id

  // Read daily delivery rows and their parent ads under the same resolved account. Creatives are read
  // separately below so a malformed cross-account creative relationship cannot leak into this result.
  const richSelect =
    'ad_id, date_start, spend, impressions, clicks, leads, frequency, ads!inner(ad_name, status, ad_account_id, creative_id, delivery_sub_status, delivery_sub_status_read_available, delivery_sub_status_synced_at)'
  const baselineSelect =
    'ad_id, date_start, spend, impressions, clicks, leads, frequency, ads!inner(ad_name, status, ad_account_id, creative_id)'
  const read = (selectClause: string) => db
    .from('daily_insights')
    .select(selectClause)
    .eq('ad_account_id', adAccountId)
    .eq('entity_level', 'ad')
    .eq('ads.ad_account_id', adAccountId)
    .gte('date_start', start)
    .lte('date_start', end)
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
    return unavailableCreativeDelivery(
      'CREATIVE_DELIVERY_READ_UNAVAILABLE',
      logToolError('get_creative_performance', 'CREATIVE_DELIVERY_READ_UNAVAILABLE', error),
      period,
    )
  }

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const byAd = new Map<string, AdAggregate>()
  for (const row of rows) {
    const adId = typeof row.ad_id === 'string' ? row.ad_id : null
    if (!adId) continue

    const ad = row.ads && !Array.isArray(row.ads) ? row.ads as Record<string, unknown> : null
    if (!ad || ad.ad_account_id !== adAccountId) continue

    const prior = byAd.get(adId)
    const frequency = row.frequency === null || row.frequency === undefined
      ? null
      : finiteNumber(row.frequency)
    const date = typeof row.date_start === 'string' ? row.date_start : String(row.date_start ?? '')
    const frequencyObservation = frequency === null || date.length === 0
      ? []
      : [{ date, frequency }]

    byAd.set(adId, {
      spend: (prior?.spend ?? 0) + finiteNumber(row.spend),
      metaLeadsEstimate: (prior?.metaLeadsEstimate ?? 0) + finiteNumber(row.leads),
      impressions: (prior?.impressions ?? 0) + finiteNumber(row.impressions),
      clicks: (prior?.clicks ?? 0) + finiteNumber(row.clicks),
      adName: typeof ad.ad_name === 'string' && ad.ad_name.length > 0
        ? ad.ad_name
        : (prior?.adName ?? 'Unknown Ad'),
      creativeId: typeof ad.creative_id === 'string' ? ad.creative_id : (prior?.creativeId ?? null),
      dailyFrequency: [...(prior?.dailyFrequency ?? []), ...frequencyObservation],
      deliverySubStatus: prior?.deliverySubStatus ?? (deliveryColumnsAvailable
        ? normalizePersistedDeliverySubStatus(
          ad.delivery_sub_status,
          ad.delivery_sub_status_read_available,
          ad.delivery_sub_status_synced_at,
        )
        : normalizePersistedDeliverySubStatus(null, false, null)),
    })
  }

  const creativeIds = [...new Set(
    Array.from(byAd.values()).map((ad) => ad.creativeId).filter((id): id is string => id !== null),
  )]
  const assetTypeByCreativeId = new Map<string, string | null>()
  if (creativeIds.length > 0) {
    const { data: creatives, error: creativeError } = await db
      .from('creatives')
      .select('id, asset_type')
      .eq('ad_account_id', adAccountId)
      .in('id', creativeIds)

    if (creativeError) {
      return unavailableCreativeDelivery(
        'CREATIVE_METADATA_READ_UNAVAILABLE',
        logToolError('get_creative_performance', 'CREATIVE_METADATA_READ_UNAVAILABLE', creativeError),
        period,
      )
    }
    for (const creative of creatives ?? []) {
      if (typeof creative.id !== 'string') continue
      assetTypeByCreativeId.set(
        creative.id,
        typeof creative.asset_type === 'string' ? creative.asset_type : null,
      )
    }
  }

  const ads = Array.from(byAd.entries())
    .filter(([, aggregate]) => args.min_spend === undefined || aggregate.spend >= args.min_spend)
    .map(([adId, aggregate]) => {
      const ctr = aggregate.impressions > 0
        ? (aggregate.clicks / aggregate.impressions) * 100
        : null
      const metaCplEstimate = aggregate.metaLeadsEstimate > 0
        ? aggregate.spend / aggregate.metaLeadsEstimate
        : null
      const dailyFrequencyObservations = [...aggregate.dailyFrequency]
        .sort((a, b) => a.date.localeCompare(b.date))
      const evidence = describeDeliveryEvidence({
        impressions: aggregate.impressions,
        frequencyObservationCount: dailyFrequencyObservations.length,
      })

      return sanitizeObject({
        ad_id: adId,
        ad_name: aggregate.adName,
        asset_type: aggregate.creativeId
          ? (assetTypeByCreativeId.get(aggregate.creativeId) ?? null)
          : null,
        spend: roundMoney(aggregate.spend),
        impressions: aggregate.impressions,
        clicks: aggregate.clicks,
        meta_leads_estimate: aggregate.metaLeadsEstimate,
        ctr: ctr === null ? null : Math.round(ctr * 10_000) / 10_000,
        meta_cpl_estimate: metaCplEstimate === null ? null : roundMoney(metaCplEstimate),
        daily_frequency_observations: dailyFrequencyObservations,
        delivery_sub_status: aggregate.deliverySubStatus,
        ...evidence,
      })
    })
    .sort((a, b) => Number(b.spend) - Number(a.spend) || String(a.ad_id).localeCompare(String(b.ad_id)))

  return {
    status: 'available' as const,
    period,
    action_authority_tier: 'diagnostic_only' as const,
    prescriptions: [] as [],
    ads,
    total: ads.length,
    observed_count: ads.filter((ad) => ad.evidence_state === 'observed').length,
    limited_count: ads.filter((ad) => ad.evidence_state === 'limited').length,
    note: 'Exact-account Meta delivery evidence only. Daily frequency is not aggregated into a period value or converted into a creative or budget verdict. Governed decisions remain in Current Recommendations.',
  }
}
