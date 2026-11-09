import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaCreative } from '@/types/meta-api'

export async function upsertCreatives(
  adAccountDbId: string,
  creatives: MetaCreative[]
): Promise<number> {
  if (creatives.length === 0) return 0

  const supabase = getAdminClient()
  const now = new Date().toISOString()

  const rows = creatives.map((c) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkData = (c.object_story_spec as any)?.link_data ?? {}
    return {
      ad_account_id: adAccountDbId,
      creative_id: c.id,
      creative_name: c.name ?? null,
      body: c.body ?? null,
      title: c.title ?? null,
      description: linkData?.description ?? c.description ?? null,
      call_to_action_type: c.call_to_action_type ?? null,
      link_url: linkData?.link ?? c.link_url ?? null,
      // url_tags = the UTM/tracking query string Meta appends to the destination. Captured so GA4
      // attribution coverage is auditable (empty = GA4 can't tie purchases to this campaign).
      url_tags: c.url_tags ?? (linkData?.url_tags as string | undefined) ?? null,
      display_url: linkData?.display_url ?? null,
      instagram_permalink_url: c.instagram_permalink_url ?? null,
      asset_type: c.object_type ?? null,
      image_url: c.image_url ?? null,
      image_hash: c.image_hash ?? null,
      video_id: c.video_id ?? null,
      thumbnail_url: c.thumbnail_url ?? null,
      child_attachments: linkData?.child_attachments ?? null,
      object_story_spec: c.object_story_spec ?? null,
      asset_feed_spec: c.asset_feed_spec ?? null,
      meta_created_time: c.created_time ?? null,
      last_synced_at: now,
    }
  })

  const { data, error } = await supabase
    .from('creatives')
    .upsert(rows, {
      onConflict: 'creative_id',
      ignoreDuplicates: false,
    })
    .select('id')

  if (error) {
    throw new Error(`upsertCreatives failed: ${error.message}`)
  }

  return data?.length ?? 0
}

export async function linkCreativesToAds(adAccountDbId: string): Promise<void> {
  const supabase = getAdminClient()

  // Fetch all ads for this account that have a meta creative_id in their tracking/conversion specs
  // We need to join via the meta creative ID stored in ads vs creatives.creative_id
  // The approach: fetch ads with their meta creative reference, then update creative_id FK

  // Meta stores the creative reference on the ad as ad.creative.id
  // Since we stored it as null during upsert, we need to look up via a join.
  // The ads table doesn't store meta_creative_id directly in the schema.
  // We use a raw SQL approach via rpc or we do it in two steps:
  // 1) fetch creatives for this account (meta_creative_id → db_uuid)
  // 2) for each creative, find ads where we can match

  // Since the schema doesn't store meta_creative_id on ads directly, we rely on
  // the fact that upsertAds was called with ad.creative?.id accessible via MetaAd.
  // To make linkCreativesToAds work standalone, we use a Supabase RPC / raw SQL.

  // The `link_creatives_to_ads()` function takes no parameters — it links
  // all accounts by joining on ad_account_id within the table.
  const { error } = await supabase.rpc('link_creatives_to_ads')

  if (error) {
    // If the RPC doesn't exist yet, fall back to a best-effort JS join
    if (error.code === 'PGRST202' || error.message?.includes('does not exist')) {
      await linkCreativesToAdsFallback(adAccountDbId)
      return
    }
    throw new Error(`linkCreativesToAds RPC failed: ${error.message}`)
  }
}

async function linkCreativesToAdsFallback(adAccountDbId: string): Promise<void> {
  const supabase = getAdminClient()

  // Fetch all creatives for this account: meta creative_id → DB uuid
  const { data: creatives, error: creativeErr } = await supabase
    .from('creatives')
    .select('id, creative_id')
    .eq('ad_account_id', adAccountDbId)

  if (creativeErr) {
    throw new Error(`linkCreativesToAds fallback: creatives fetch failed: ${creativeErr.message}`)
  }

  if (!creatives || creatives.length === 0) return

  const creativeMap = new Map<string, string>()
  for (const c of creatives) {
    creativeMap.set(c.creative_id as string, c.id as string)
  }

  // Fetch ads that still have creative_id = null for this account
  const { data: ads, error: adsErr } = await supabase
    .from('ads')
    .select('id, ad_id')
    .eq('ad_account_id', adAccountDbId)
    .is('creative_id', null)

  if (adsErr) {
    throw new Error(`linkCreativesToAds fallback: ads fetch failed: ${adsErr.message}`)
  }

  if (!ads || ads.length === 0) return

  // We cannot determine the creative from the ads table alone without the meta creative ID.
  // This fallback is a no-op if the RPC doesn't exist; the RPC should be created in migrations.
  // Log a warning so it's visible.
  console.warn(
    `[Sync] linkCreativesToAds: RPC not available, ${ads.length} ads still have creative_id=null. ` +
    `Create the link_creatives_to_ads RPC in Supabase to enable this feature.`
  )
}
