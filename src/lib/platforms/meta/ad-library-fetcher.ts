import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { META_GRAPH_BASE } from '@/lib/platforms/meta/api-version'
import { fetchMetaGraph } from '@/lib/platforms/meta/client'
import { redactSnapshotUrl } from '@/lib/competitors/snapshot-url'
import { resolveAdLibraryCountries } from '@/lib/platforms/meta/ad-library-countries'

const AD_LIBRARY_URL = `${META_GRAPH_BASE}/ads_archive`

interface AdLibraryAd {
  id: string
  ad_creative_bodies?: string[]
  ad_creative_link_captions?: string[]
  ad_creative_link_descriptions?: string[]
  ad_snapshot_url?: string
  ad_delivery_start_time?: string
  ad_delivery_stop_time?: string
  impressions?: { lower_bound: string; upper_bound: string }
  spend?: { lower_bound: string; upper_bound: string }
  page_id?: string
  page_name?: string
}

interface AdLibraryResponse {
  data: AdLibraryAd[]
  paging?: {
    cursors?: { before: string; after: string }
    next?: string
  }
  error?: { message: string; code: number }
}

function calcDaysRunning(
  startTime: string | undefined,
  stopTime: string | undefined
): number | null {
  if (!startTime) return null
  const start = new Date(startTime)
  const end = stopTime ? new Date(stopTime) : new Date()
  const diffMs = end.getTime() - start.getTime()
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)))
}

function isActiveAd(stopTime: string | undefined): boolean {
  if (!stopTime) return true
  return new Date(stopTime) > new Date()
}

function formatRange(lower?: string, upper?: string): string | null {
  if (!lower && !upper) return null
  if (lower === upper || !upper) return lower ?? null
  return `${lower}-${upper}`
}

export async function fetchCompetitorAds(
  competitorId: string,
  facebookPageId: string
): Promise<number> {
  const accessToken = process.env.META_ACCESS_TOKEN
  if (!accessToken) {
    console.warn('[AdLibraryFetcher] META_ACCESS_TOKEN not set')
    return 0
  }

  const countries = await resolveAdLibraryCountries(accessToken)
  if (!countries) {
    console.warn('[AdLibraryFetcher] META_AD_LIBRARY_COUNTRIES is not a list of ISO 3166-1 alpha-2 codes; search skipped')
    return 0
  }

  const params = new URLSearchParams({
    ad_type: 'ALL',
    ad_reached_countries: JSON.stringify(countries),
    search_page_ids: JSON.stringify([facebookPageId]),
    fields: [
      'id',
      'ad_creative_bodies',
      'ad_creative_link_captions',
      'ad_creative_link_descriptions',
      'ad_snapshot_url',
      'ad_delivery_start_time',
      'ad_delivery_stop_time',
      'impressions',
      'spend',
      'page_id',
      'page_name',
    ].join(','),
    limit: '50',
  })

  let nextUrl: string | undefined = `${AD_LIBRARY_URL}?${params.toString()}`
  const allAds: AdLibraryAd[] = []

  while (nextUrl && allAds.length < 200) {
    let resp: Response
    try {
      resp = await fetchMetaGraph(nextUrl, {}, accessToken)
    } catch (err) {
      console.error('[AdLibraryFetcher] Network error', err)
      break
    }

    let json: AdLibraryResponse
    try {
      json = (await resp.json()) as AdLibraryResponse
    } catch {
      console.error('[AdLibraryFetcher] Failed to parse response')
      break
    }

    if (json.error) {
      console.error('[AdLibraryFetcher] API error', json.error)
      break
    }

    if (Array.isArray(json.data)) {
      allAds.push(...json.data)
    }

    nextUrl = json.paging?.next
  }

  if (allAds.length === 0) return 0

  const db = getAdminClient()

  const rows = allAds.map((ad) => ({
    competitor_id: competitorId,
    ad_archive_id: ad.id,
    page_id: ad.page_id ?? facebookPageId,
    page_name: ad.page_name ?? null,
    ad_creative_bodies: ad.ad_creative_bodies ?? null,
    ad_creative_link_captions: ad.ad_creative_link_captions ?? null,
    ad_creative_link_descriptions: ad.ad_creative_link_descriptions ?? null,
    // Meta embeds the access token in this URL; store it without the token.
    ad_snapshot_url: redactSnapshotUrl(ad.ad_snapshot_url),
    ad_delivery_start_time: ad.ad_delivery_start_time ?? null,
    ad_delivery_stop_time: ad.ad_delivery_stop_time ?? null,
    is_active: isActiveAd(ad.ad_delivery_stop_time),
    estimated_days_running: calcDaysRunning(
      ad.ad_delivery_start_time,
      ad.ad_delivery_stop_time
    ),
    impression_range: formatRange(
      ad.impressions?.lower_bound,
      ad.impressions?.upper_bound
    ),
    spend_range: formatRange(ad.spend?.lower_bound, ad.spend?.upper_bound),
    updated_at: new Date().toISOString(),
  }))

  const { error } = await db
    .from('competitor_ads')
    .upsert(rows, { onConflict: 'ad_archive_id' })

  if (error) {
    console.error('[AdLibraryFetcher] Upsert error', error)
    return 0
  }

  return rows.length
}
