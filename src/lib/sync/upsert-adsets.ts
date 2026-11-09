import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaAdSet } from '@/types/meta-api'

function epochToIso(sec: number | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return null
  return new Date(sec * 1000).toISOString()
}

/**
 * PURE: one Meta ad set → one `adsets` row.
 *
 * `targeting_optimization_types` is a SIBLING ad-set field, not part of the targeting spec. It
 * reports what Meta ACTUALLY relaxed at delivery, which is better evidence than the configured
 * expansion state carried inside `targeting` (targeting_automation.advantage_audience on modern ad
 * sets, targeting_optimization: "expansion_all" on legacy ones).
 *
 * ⚠️ The `adsets` targeting columns must exist BEFORE this code deploys: PostgREST rejects the entire upsert
 * when a body key has no matching column (PGRST204), and this runs as step 3 of an unguarded chain.
 *
 * Null when absent — an empty array would assert "Meta relaxed nothing", which is a different
 * claim from "Meta told us nothing".
 */
export function buildAdsetRow(
  a: MetaAdSet,
  ctx: { adAccountDbId: string; campaignDbId: string; now: string },
) {
  // budgets/bid are ALREADY dollars (converted in fetch-adsets.ts). Do NOT divide again.
  const dailyBudgetDollars = a.daily_budget ? parseFloat(a.daily_budget) : null
  const lifetimeBudgetDollars = a.lifetime_budget ? parseFloat(a.lifetime_budget) : null
  const bidAmountDollars = a.bid_amount ? parseFloat(a.bid_amount) : null
  const deliverySubStatusReadAvailable = a.delivery_sub_status_read_available === true

  return {
    ad_account_id: ctx.adAccountDbId,
    campaign_id: ctx.campaignDbId,
    adset_id: a.id,
    adset_name: a.name ?? null,
    status: a.status ?? null,
    effective_status: a.effective_status ?? null,
    optimization_goal: a.optimization_goal ?? null,
    learning_stage: a.learning_stage_info?.status ?? null,
    // Learning-exit progress gauge (attribution-scoped; resets on significant edits — see the column comment).
    learning_conversions: a.learning_stage_info?.conversions ?? null,
    last_sig_edit_ts: epochToIso(a.learning_stage_info?.last_sig_edit_ts),
    billing_event: a.billing_event ?? null,
    destination_type: a.destination_type ?? null,
    promoted_object: a.promoted_object ?? null,
    // Omission remains NULL. Never substitute Meta's platform default because the configured
    // attribution window is a material setup fact and defaults can change.
    attribution_spec: a.attribution_spec ?? null,
    targeting: a.targeting ?? null,
    targeting_optimization_types: a.targeting_optimization_types ?? null,
    delivery_sub_status: deliverySubStatusReadAvailable ? (a.delivery_sub_status ?? null) : null,
    delivery_sub_status_read_available: deliverySubStatusReadAvailable,
    delivery_sub_status_synced_at: deliverySubStatusReadAvailable ? ctx.now : null,
    daily_budget: dailyBudgetDollars,
    lifetime_budget: lifetimeBudgetDollars,
    bid_amount: bidAmountDollars,
    bid_strategy: a.bid_strategy ?? null,
    start_time: a.start_time ?? null,
    end_time: a.end_time ?? null,
    meta_created_time: a.created_time ?? null,
    meta_updated_time: a.updated_time ?? null,
    last_synced_at: ctx.now,
    // Stamp targeting freshness ONLY when this fetch actually carried a targeting spec.
    // last_synced_at advances on every sync whether or not targeting was refetched, so a stale
    // spec could look fresh; the audience resolver freezes on an unknown/stale targeting age and
    // must be given the targeting-specific timestamp, not the generic one.
    ...(a.targeting ? { targeting_last_synced_at: ctx.now } : {}),
  }
}

export async function upsertAdSets(
  adAccountDbId: string,
  adSets: MetaAdSet[]
): Promise<number> {
  if (adSets.length === 0) return 0

  const supabase = getAdminClient()
  const now = new Date().toISOString()

  // Collect all unique meta campaign IDs we need to look up
  const metaCampaignIds = [...new Set(adSets.map((a) => a.campaign_id).filter(Boolean))]

  // Fetch campaign UUID map: meta campaign_id → DB uuid
  const campaignIdMap = new Map<string, string>()
  if (metaCampaignIds.length > 0) {
    const { data: campaigns, error: campErr } = await supabase
      .from('campaigns')
      .select('id, campaign_id')
      .in('campaign_id', metaCampaignIds)

    if (campErr) {
      throw new Error(`upsertAdSets: campaign lookup failed: ${campErr.message}`)
    }

    for (const camp of campaigns ?? []) {
      campaignIdMap.set(camp.campaign_id as string, camp.id as string)
    }
  }

  const rows = adSets
    .map((a) => {
      const campaignDbId = campaignIdMap.get(a.campaign_id ?? '')
      if (!campaignDbId) {
        console.warn(`[Sync] upsertAdSets: no campaign found for meta campaign_id=${a.campaign_id}, skipping adset ${a.id}`)
        return null
      }

      return buildAdsetRow(a, { adAccountDbId, campaignDbId, now })
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  if (rows.length === 0) return 0

  const { data, error } = await supabase
    .from('adsets')
    .upsert(rows, {
      onConflict: 'adset_id',
      ignoreDuplicates: false,
    })
    .select('id')

  if (error) {
    throw new Error(`upsertAdSets failed: ${error.message}`)
  }

  return data?.length ?? 0
}
