import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaAd } from '@/types/meta-api'

export function buildAdRow(
  ad: MetaAd,
  ctx: {
    adAccountDbId: string
    campaignDbId: string
    adsetDbId: string
    now: string
  },
) {
  const deliverySubStatusReadAvailable = ad.delivery_sub_status_read_available === true
  const destinationUrlReadAvailable = ad.destination_url_read_available === true
  return {
    ad_account_id: ctx.adAccountDbId,
    campaign_id: ctx.campaignDbId,
    adset_id: ctx.adsetDbId,
    creative_id: null,
    meta_creative_id: ad.creative?.id ?? null,
    ad_id: ad.id,
    ad_name: ad.name ?? null,
    status: ad.status ?? null,
    effective_status: ad.effective_status ?? null,
    // Ad-level destination is authoritative when Graph supplies it. Creative fallback is resolved
    // later by the setup projection and is kept separate from this observation.
    destination_url: destinationUrlReadAvailable ? (ad.destination_url ?? null) : null,
    destination_url_read_available: destinationUrlReadAvailable,
    destination_url_synced_at: destinationUrlReadAvailable ? ctx.now : null,
    url_tags: ad.url_tags ?? null,
    review_feedback: ad.review_feedback ?? null,
    issues_info: ad.issues_info ?? null,
    tracking_specs: ad.tracking_specs ?? null,
    conversion_specs: ad.conversion_specs ?? null,
    delivery_sub_status: deliverySubStatusReadAvailable ? (ad.delivery_sub_status ?? null) : null,
    delivery_sub_status_read_available: deliverySubStatusReadAvailable,
    delivery_sub_status_synced_at: deliverySubStatusReadAvailable ? ctx.now : null,
    meta_created_time: ad.created_time ?? null,
    meta_updated_time: ad.updated_time ?? null,
    last_synced_at: ctx.now,
  }
}

export function preserveDestinationOnUnavailableRead<
  T extends { destination_url: string | null; destination_url_read_available: boolean },
>(row: T): Omit<T, 'destination_url'> | T {
  if (row.destination_url_read_available) return row
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => key !== 'destination_url'),
  ) as Omit<T, 'destination_url'>
}

export async function upsertAds(
  adAccountDbId: string,
  ads: MetaAd[]
): Promise<number> {
  if (ads.length === 0) return 0

  const supabase = getAdminClient()
  const now = new Date().toISOString()

  // Collect unique meta IDs to look up DB UUIDs
  const metaCampaignIds = [...new Set(ads.map((a) => a.campaign_id).filter(Boolean))]
  const metaAdsetIds = [...new Set(ads.map((a) => a.adset_id).filter(Boolean))]

  const campaignIdMap = new Map<string, string>()
  const adsetIdMap = new Map<string, string>()

  if (metaCampaignIds.length > 0) {
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('id, campaign_id')
      .in('campaign_id', metaCampaignIds)

    if (error) {
      throw new Error(`upsertAds: campaign lookup failed: ${error.message}`)
    }
    for (const c of campaigns ?? []) {
      campaignIdMap.set(c.campaign_id as string, c.id as string)
    }
  }

  if (metaAdsetIds.length > 0) {
    const { data: adsets, error } = await supabase
      .from('adsets')
      .select('id, adset_id')
      .in('adset_id', metaAdsetIds)

    if (error) {
      throw new Error(`upsertAds: adset lookup failed: ${error.message}`)
    }
    for (const a of adsets ?? []) {
      adsetIdMap.set(a.adset_id as string, a.id as string)
    }
  }

  const rows = ads
    .map((ad) => {
      const campaignDbId = campaignIdMap.get(ad.campaign_id ?? '')
      const adsetDbId = adsetIdMap.get(ad.adset_id ?? '')

      if (!campaignDbId || !adsetDbId) {
        console.warn(
          `[Sync] upsertAds: missing FK for ad ${ad.id} ` +
          `(campaign=${ad.campaign_id} → ${campaignDbId ?? 'NOT FOUND'}, ` +
          `adset=${ad.adset_id} → ${adsetDbId ?? 'NOT FOUND'}), skipping`
        )
        return null
      }

      return buildAdRow(ad, { adAccountDbId, campaignDbId, adsetDbId, now })
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (rows.length === 0) return 0

  const partitions = [
    rows.filter((row) => row.destination_url_read_available),
    rows.filter((row) => !row.destination_url_read_available)
      .map(preserveDestinationOnUnavailableRead),
  ].filter((partition) => partition.length > 0)
  let written = 0
  for (const partition of partitions) {
    const { data, error } = await supabase
      .from('ads')
      .upsert(partition, { onConflict: 'ad_id', ignoreDuplicates: false })
      .select('id')
    if (error) throw new Error(`upsertAds failed: ${error.message}`)
    written += data?.length ?? 0
  }
  return written
}
