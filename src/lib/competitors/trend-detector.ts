import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday, nyDaysAgo } from '@/lib/utils/date-utils'

export interface FormatTrend {
  format: string
  competitor_count: number
  new_in_last_14d: number
  is_emerging: boolean
  example_competitor: string | null
  example_ad_body: string | null
}

export interface LongevityAccelerator {
  competitor_ad_id: string
  competitor_name: string
  ad_body_preview: string
  current_days_running: number
  days_running_14d_ago: number | null
  delta_days: number | null
  is_accelerating: boolean
}

async function getAccountCompetitorSources(adAccountId: string): Promise<Array<{ id: string; name: string }>> {
  const supabase = getAdminClient()
  const { data, error } = await supabase
    .from('competitor_sources')
    .select('id, name')
    .eq('ad_account_id', adAccountId)
    .eq('is_active', true)

  if (error) throw new Error(`Failed to fetch competitor_sources: ${error.message}`)
  return (data ?? []) as Array<{ id: string; name: string }>
}

export async function snapshotCompetitorAds(adAccountId: string): Promise<number> {
  const supabase = getAdminClient()
  const today = nyToday()
  const sources = await getAccountCompetitorSources(adAccountId)
  const sourceIds = sources.map((source) => source.id)
  if (sourceIds.length === 0) return 0

  const { data: ads, error } = await supabase
    .from('competitor_ads')
    .select('id, estimated_days_running, impression_range, spend_range')
    .in('competitor_id', sourceIds)
    .eq('is_active', true)

  if (error) throw new Error(`Failed to fetch competitor_ads: ${error.message}`)
  if (!ads || ads.length === 0) return 0

  const snapshots = ads.map((ad) => ({
    competitor_ad_id: ad.id,
    snapshot_date: today,
    estimated_days_running: ad.estimated_days_running,
    impression_range: ad.impression_range,
    spend_range: ad.spend_range,
    is_active: true,
  }))

  const { error: upsertError, data: upserted } = await supabase
    .from('competitor_ad_snapshots')
    .upsert(snapshots, { onConflict: 'competitor_ad_id,snapshot_date', ignoreDuplicates: false })
    .select('competitor_ad_id')

  if (upsertError) throw new Error(`Failed to upsert snapshots: ${upsertError.message}`)

  return upserted?.length ?? 0
}

export async function detectFormatTrends(adAccountId: string): Promise<FormatTrend[]> {
  const supabase = getAdminClient()
  const today14Str = nyDaysAgo(14)
  const sources = await getAccountCompetitorSources(adAccountId)
  const sourceIds = sources.map((source) => source.id)
  if (sourceIds.length === 0) return []
  const sourceNameMap = Object.fromEntries(sources.map((source) => [source.id, source.name]))

  const { data: ads, error } = await supabase
    .from('competitor_ads')
    .select('id, competitor_id, ad_creative_bodies, ai_analysis, ad_delivery_start_time, created_at')
    .in('competitor_id', sourceIds)
    .not('ai_analysis', 'is', null)
    .eq('is_active', true)

  if (error) throw new Error(`Failed to fetch competitor_ads: ${error.message}`)
  if (!ads || ads.length === 0) return []

  // Group by format
  const formatMap: Map<
    string,
    {
      competitorIds: Set<string>
      newCount: number
      exampleCompetitorName: string | null
      exampleAdBody: string | null
    }
  > = new Map()

  for (const ad of ads) {
    const analysis = ad.ai_analysis as Record<string, unknown> | null
    // Failed model output is stored as a marker so it is not retried; it is not an analysis.
    if (analysis?.analysis_status === 'invalid_model_output') continue
    const format = String(analysis?.format_guess ?? 'unknown')

    if (!formatMap.has(format)) {
      formatMap.set(format, {
        competitorIds: new Set(),
        newCount: 0,
        exampleCompetitorName: null,
        exampleAdBody: null,
      })
    }

    const entry = formatMap.get(format)!

    if (ad.competitor_id) entry.competitorIds.add(String(ad.competitor_id))

    const dateStr = ad.ad_delivery_start_time
      ? String(ad.ad_delivery_start_time).slice(0, 10)
      : String(ad.created_at ?? '').slice(0, 10)

    if (dateStr >= today14Str) {
      entry.newCount++
    }

    if (!entry.exampleCompetitorName && ad.competitor_id) {
      entry.exampleCompetitorName = sourceNameMap[String(ad.competitor_id)] ?? null
    }

    if (!entry.exampleAdBody) {
      const bodies = ad.ad_creative_bodies as string[] | null
      const first = bodies?.[0]
      if (first) {
        entry.exampleAdBody = first.slice(0, 200)
      }
    }
  }

  const results: FormatTrend[] = []

  for (const [format, entry] of formatMap.entries()) {
    const isEmerging = entry.newCount >= 2

    results.push({
      format,
      competitor_count: entry.competitorIds.size,
      new_in_last_14d: entry.newCount,
      is_emerging: isEmerging,
      example_competitor: entry.exampleCompetitorName,
      example_ad_body: entry.exampleAdBody,
    })
  }

  results.sort((a, b) => b.new_in_last_14d - a.new_in_last_14d)

  return results
}

export async function detectLongevityAccelerators(adAccountId: string): Promise<LongevityAccelerator[]> {
  const supabase = getAdminClient()
  const today = nyToday()
  const today14 = nyDaysAgo(14)
  const sources = await getAccountCompetitorSources(adAccountId)
  const sourceIds = sources.map((source) => source.id)
  if (sourceIds.length === 0) return []
  const sourceNameMap = Object.fromEntries(sources.map((source) => [source.id, source.name]))

  const { data: accountAds, error: accountAdsError } = await supabase
    .from('competitor_ads')
    .select('id, competitor_id, ad_creative_bodies')
    .in('competitor_id', sourceIds)

  if (accountAdsError) throw new Error(`Failed to fetch competitor_ads: ${accountAdsError.message}`)
  if (!accountAds || accountAds.length === 0) return []

  const adIds = accountAds.map((ad) => String(ad.id))
  const adDataMap = Object.fromEntries(accountAds.map((ad) => [String(ad.id), {
    competitor_id: ad.competitor_id as string | null,
    ad_creative_bodies: ad.ad_creative_bodies as string[] | null,
  }]))

  // Fetch today's snapshots
  const { data: todaySnaps, error: snapError } = await supabase
    .from('competitor_ad_snapshots')
    .select('competitor_ad_id, estimated_days_running')
    .eq('snapshot_date', today)
    .in('competitor_ad_id', adIds)

  if (snapError) throw new Error(`Failed to fetch today snapshots: ${snapError.message}`)
  if (!todaySnaps || todaySnaps.length === 0) return []

  const observedAdIds = todaySnaps.map((snapshot) => snapshot.competitor_ad_id)

  // Fetch 14-day-ago snapshots for the same ads
  const { data: oldSnaps } = await supabase
    .from('competitor_ad_snapshots')
    .select('competitor_ad_id, estimated_days_running')
    .eq('snapshot_date', today14)
    .in('competitor_ad_id', observedAdIds)

  const oldSnapMap: Record<string, number> = {}
  if (oldSnaps) {
    for (const s of oldSnaps) {
      oldSnapMap[String(s.competitor_ad_id)] = s.estimated_days_running
    }
  }

  const accelerators: LongevityAccelerator[] = todaySnaps.map((snap) => {
    const adId = String(snap.competitor_ad_id)
    const currentDays = snap.estimated_days_running as number
    const oldDays = oldSnapMap[adId] ?? null
    const deltaDays = oldDays !== null ? currentDays - oldDays : null
    const isAccelerating = deltaDays !== null && deltaDays > 7

    const adData = adDataMap[adId]
    const competitorName =
      adData?.competitor_id ? (sourceNameMap[String(adData.competitor_id)] ?? 'Unknown') : 'Unknown'

    const bodies = adData?.ad_creative_bodies
    const adBodyPreview = bodies?.[0]?.slice(0, 150) ?? ''

    return {
      competitor_ad_id: adId,
      competitor_name: competitorName,
      ad_body_preview: adBodyPreview,
      current_days_running: currentDays,
      days_running_14d_ago: oldDays,
      delta_days: deltaDays,
      is_accelerating: isAccelerating,
    }
  })

  // Sort by delta_days DESC (nulls last), then take top 10
  accelerators.sort((a, b) => {
    if (a.delta_days === null && b.delta_days === null) return 0
    if (a.delta_days === null) return 1
    if (b.delta_days === null) return -1
    return b.delta_days - a.delta_days
  })

  return accelerators.slice(0, 10)
}
