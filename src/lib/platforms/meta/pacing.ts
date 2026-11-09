import { META_GRAPH_BASE } from './api-version'
import { fetchMetaGraph } from './client'

// Intraday pacing reads for GET /api/sync/midday, moved unchanged from that route.
// Each follows paging.next to the end. The credential is resolved by fetchMetaGraph from
// META_ACCESS_TOKEN (trimmed), exactly as the route resolved it before.

/** Today's spend row for one campaign, as Meta returns it (spend is a decimal string). */
export interface TodayCampaignSpend {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  date_start?: string
  date_stop?: string
}

/** An active campaign's daily budget, as Meta returns it (minor currency units, decimal string). */
export interface ActiveCampaignBudget {
  id: string
  name?: string
  daily_budget?: string
}

/** An active ad set's daily budget, as Meta returns it (minor currency units, decimal string). */
export interface ActiveAdSetBudget {
  id: string
  campaign_id?: string
  daily_budget?: string
}

interface GraphPage<T> {
  data?: T[]
  paging?: { next?: string }
  error?: { message: string; code: number }
}

export type TodayCampaignSpendResult =
  | { ok: true; rows: TodayCampaignSpend[] }
  | { ok: false; error: { message: string; code: number } }

/** Every campaign's spend today. A Graph error on any page is returned (not thrown); a transport
 * failure throws. */
export async function fetchTodayCampaignSpend(accountId: string): Promise<TodayCampaignSpendResult> {
  const insightsUrl = new URL(
    `${META_GRAPH_BASE}/act_${accountId}/insights`
  )
  insightsUrl.searchParams.set('date_preset', 'today')
  insightsUrl.searchParams.set('level', 'campaign')
  insightsUrl.searchParams.set('fields', 'campaign_id,campaign_name,spend')
  insightsUrl.searchParams.set('limit', '200')

  // Follow pagination so accounts with many campaigns aren't silently truncated.
  const insightRows: TodayCampaignSpend[] = []
  let nextInsightsUrl: string | undefined = insightsUrl.toString()
  while (nextInsightsUrl) {
    const insightsRes = await fetchMetaGraph(nextInsightsUrl, {})
    const insightsJson = (await insightsRes.json()) as GraphPage<TodayCampaignSpend>
    if (insightsJson.error) {
      return { ok: false, error: insightsJson.error }
    }
    insightRows.push(...(insightsJson.data ?? []))
    nextInsightsUrl = insightsJson.paging?.next
  }
  return { ok: true, rows: insightRows }
}

/** Best-effort: never throws. Returns every row read before a Graph error or transport failure ended
 * paging, so a failure on page N keeps pages 1..N-1. */
export async function fetchActiveCampaignBudgets(accountId: string): Promise<ActiveCampaignBudget[]> {
  const rows: ActiveCampaignBudget[] = []
  try {
    const campaignsUrl = new URL(
      `${META_GRAPH_BASE}/act_${accountId}/campaigns`
    )
    campaignsUrl.searchParams.set('fields', 'id,name,daily_budget')
    campaignsUrl.searchParams.set('effective_status', '["ACTIVE"]')
    campaignsUrl.searchParams.set('limit', '100')

    let nextCampaignsUrl: string | undefined = campaignsUrl.toString()
    while (nextCampaignsUrl) {
      const campaignsRes = await fetchMetaGraph(nextCampaignsUrl, {})
      const campaignsJson = (await campaignsRes.json()) as GraphPage<ActiveCampaignBudget>
      if (campaignsJson.error) break
      rows.push(...(campaignsJson.data ?? []))
      nextCampaignsUrl = campaignsJson.paging?.next
    }
  } catch {
    // Budget fetch is best-effort — keep the rows already read
  }
  return rows
}

/** A Graph error ends paging and returns the rows read so far; a transport failure throws, so the
 * caller can discard a partial ad-set read. */
export async function fetchActiveAdSetBudgets(accountId: string): Promise<ActiveAdSetBudget[]> {
  const adsetsUrl = new URL(
    `${META_GRAPH_BASE}/act_${accountId}/adsets`
  )
  adsetsUrl.searchParams.set('fields', 'id,campaign_id,daily_budget')
  adsetsUrl.searchParams.set('effective_status', '["ACTIVE"]')
  adsetsUrl.searchParams.set('limit', '200')

  const rows: ActiveAdSetBudget[] = []
  let nextAdsetsUrl: string | undefined = adsetsUrl.toString()
  while (nextAdsetsUrl) {
    const adsetsRes = await fetchMetaGraph(nextAdsetsUrl, {})
    const adsetsJson = (await adsetsRes.json()) as GraphPage<ActiveAdSetBudget>
    if (adsetsJson.error) break
    rows.push(...(adsetsJson.data ?? []))
    nextAdsetsUrl = adsetsJson.paging?.next
  }
  return rows
}
