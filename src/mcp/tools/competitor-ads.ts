import { logToolError } from '@/lib/security/api-error'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import {
  COMPETITOR_DIAGNOSTIC_NOTE,
  projectCompetitorAiObservation,
  type CompetitorAiObservation,
} from '@/lib/competitors/diagnostic-projection'
import { detectFormatTrends, detectLongevityAccelerators } from '@/lib/competitors/trend-detector'
import { getAdminClient } from '@/lib/supabase/admin'

interface CompetitorAdRow {
  competitor_id: string
  ad_archive_id: string
  page_name: string | null
  estimated_days_running: number | null
  impression_range: string | null
  ai_analysis: Record<string, unknown> | null
}

interface CompetitorSourceRow {
  id: string
  name: string
  facebook_page_id: string | null
}

interface CompetitorGroup {
  competitor_id: string
  name: string
  facebook_page_id: string | null
  ads: Array<{
    ad_archive_id: string
    days_running: number | null
    impression_range: string | null
    observed_attributes: CompetitorAiObservation | null
    longevity_observed: boolean
  }>
}

function unavailableCompetitorResult(errorCode: string, reason: string) {
  return {
    status: 'unavailable' as const,
    untrusted_external_data: true as const,
    error_code: errorCode,
    unavailable_reason: reason,
    action_authority_tier: 'diagnostic_only' as const,
    setup_guidance_status: 'withheld' as const,
    prescriptions: [] as [],
    competitors: [] as CompetitorGroup[],
  }
}

export async function getCompetitorAds(args: {
  competitor_id?: string
  limit?: number
}): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return unavailableCompetitorResult(
      activeAccountErrorCode(activeAccount.reason),
      `Competitor ads are unavailable because active account ownership is ${activeAccount.reason}.`,
    )
  }

  let sourceQuery = db
    .from('competitor_sources')
    .select('id, name, facebook_page_id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)

  if (args.competitor_id) sourceQuery = sourceQuery.eq('id', args.competitor_id)

  const { data: sources, error: sourceError } = await sourceQuery
  if (sourceError) {
    return unavailableCompetitorResult(
      'COMPETITOR_SOURCE_READ_UNAVAILABLE',
      logToolError('get_competitor_ads', 'COMPETITOR_SOURCE_READ_UNAVAILABLE', sourceError),
    )
  }

  const sourceRows = (sources ?? []) as CompetitorSourceRow[]
  if (sourceRows.length === 0) {
    return {
      status: 'available',
      untrusted_external_data: true,
      action_authority_tier: 'diagnostic_only',
      setup_guidance_status: 'withheld',
      prescriptions: [],
      competitors: [],
      note: COMPETITOR_DIAGNOSTIC_NOTE,
    }
  }

  const sourceIds = sourceRows.map((source) => source.id)
  const limit = Math.min(args.limit ?? 50, 200)
  const { data: ads, error: adsError } = await db
    .from('competitor_ads')
    .select('competitor_id, ad_archive_id, page_name, estimated_days_running, impression_range, ai_analysis, is_active')
    .in('competitor_id', sourceIds)
    .eq('is_active', true)
    .order('estimated_days_running', { ascending: false })
    .limit(limit)

  if (adsError) {
    return unavailableCompetitorResult(
      'COMPETITOR_AD_READ_UNAVAILABLE',
      logToolError('get_competitor_ads', 'COMPETITOR_AD_READ_UNAVAILABLE', adsError),
    )
  }

  const sourceMap = new Map(sourceRows.map((source) => [source.id, source]))
  const grouped = new Map<string, CompetitorGroup>()

  for (const ad of (ads ?? []) as CompetitorAdRow[]) {
    const source = sourceMap.get(ad.competitor_id)
    if (!source) continue

    if (!grouped.has(ad.competitor_id)) {
      grouped.set(ad.competitor_id, {
        competitor_id: ad.competitor_id,
        name: source.name,
        facebook_page_id: source.facebook_page_id,
        ads: [],
      })
    }

    grouped.get(ad.competitor_id)!.ads.push({
      ad_archive_id: ad.ad_archive_id,
      days_running: ad.estimated_days_running,
      impression_range: ad.impression_range,
      observed_attributes: projectCompetitorAiObservation(ad.ai_analysis),
      longevity_observed: (ad.estimated_days_running ?? 0) >= 30,
    })
  }

  return {
    status: 'available',
    untrusted_external_data: true,
    action_authority_tier: 'diagnostic_only',
    setup_guidance_status: 'withheld',
    prescriptions: [],
    competitors: Array.from(grouped.values()),
    note: COMPETITOR_DIAGNOSTIC_NOTE,
  }
}

function unavailableTrendResult(errorCode: string, reason: string) {
  return {
    status: 'unavailable' as const,
    untrusted_external_data: true as const,
    error_code: errorCode,
    unavailable_reason: reason,
    action_authority_tier: 'diagnostic_only' as const,
    setup_guidance_status: 'withheld' as const,
    prescriptions: [] as [],
    format_observations: [],
    continued_delivery_observations: [],
  }
}

export async function getCompetitorTrends(): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return unavailableTrendResult(
      activeAccountErrorCode(activeAccount.reason),
      `Competitor trends are unavailable because active account ownership is ${activeAccount.reason}.`,
    )
  }

  try {
    const [rawFormatTrends, rawLongevity] = await Promise.all([
      detectFormatTrends(activeAccount.account.id),
      detectLongevityAccelerators(activeAccount.account.id),
    ])

    const formatObservations = rawFormatTrends.map((trend) => ({
      format: trend.format,
      competitor_count: trend.competitor_count,
      new_ads_last_14d: trend.new_in_last_14d,
      emergence_rule_met: trend.is_emerging,
      example_competitor: trend.example_competitor,
    }))
    const continuedDeliveryObservations = rawLongevity.map((observation) => ({
      competitor_ad_id: observation.competitor_ad_id,
      competitor_name: observation.competitor_name,
      current_days_running: observation.current_days_running,
      days_running_14d_ago: observation.days_running_14d_ago,
      delta_days: observation.delta_days,
      continued_delivery_observed: observation.is_accelerating,
    }))

    return {
      status: 'available',
      untrusted_external_data: true,
      action_authority_tier: 'diagnostic_only',
      setup_guidance_status: 'withheld',
      prescriptions: [],
      format_observations: formatObservations,
      continued_delivery_observations: continuedDeliveryObservations,
      summary: {
        emergence_rule_matches: formatObservations.filter((trend) => trend.emergence_rule_met).length,
        continued_delivery_count: continuedDeliveryObservations.filter((ad) => ad.continued_delivery_observed).length,
        note: `Observed competitor continuity and format frequency only; longevity is not proof of performance. ${COMPETITOR_DIAGNOSTIC_NOTE}`,
      },
    }
  } catch (error) {
    return unavailableTrendResult(
      'COMPETITOR_TREND_READ_UNAVAILABLE',
      logToolError('get_competitor_trends', 'COMPETITOR_TREND_READ_UNAVAILABLE', error),
    )
  }
}
