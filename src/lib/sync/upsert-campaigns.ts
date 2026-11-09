import { getAdminClient } from '@/lib/supabase/admin'
import type { MetaCampaign } from '@/types/meta-api'

export async function upsertCampaigns(
  adAccountDbId: string,
  campaigns: MetaCampaign[]
): Promise<number> {
  if (campaigns.length === 0) return 0

  const supabase = getAdminClient()
  const now = new Date().toISOString()

  const rows = campaigns.map((c) => {
    // c.daily_budget/lifetime_budget are ALREADY dollars (converted in fetch-campaigns.ts).
    // Do NOT divide by 100 again — that stored every budget at 1/100 of its true value.
    const dailyBudgetDollars = c.daily_budget ? parseFloat(c.daily_budget) : null
    const lifetimeBudgetDollars = c.lifetime_budget ? parseFloat(c.lifetime_budget) : null

    const specialAdCategory =
      Array.isArray(c.special_ad_categories) && c.special_ad_categories.length > 0
        ? c.special_ad_categories[0]
        : 'NONE'

    return {
      ad_account_id: adAccountDbId,
      campaign_id: c.id,
      campaign_name: c.name ?? null,
      objective: c.objective ?? null,
      status: c.status ?? 'ACTIVE',
      effective_status: c.effective_status ?? null,
      buying_type: c.buying_type ?? null,
      special_ad_category: specialAdCategory,
      daily_budget: dailyBudgetDollars,
      lifetime_budget: lifetimeBudgetDollars,
      start_time: c.start_time ?? null,
      stop_time: c.stop_time ?? null,
      meta_created_time: c.created_time ?? null,
      meta_updated_time: c.updated_time ?? null,
      last_synced_at: now,
    }
  })

  const { data, error } = await supabase
    .from('campaigns')
    .upsert(rows, {
      onConflict: 'campaign_id',
      ignoreDuplicates: false,
    })
    .select('id')

  if (error) {
    throw new Error(`upsertCampaigns failed: ${error.message}`)
  }

  return data?.length ?? 0
}
