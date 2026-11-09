import type { SupabaseClient } from '@supabase/supabase-js'
import { CAMPAIGN_SPEND_TOLERANCE } from '@/lib/analytics/campaign-roas'

/**
 * Material setting categories from the `ad_setup_decisions` documented vocabulary. `setting_category` is FREE
 * TEXT with no check constraint, so unknown values match nothing and cannot prove continuity.
 */
export const MATERIAL_SETTING_CATEGORIES = [
  'objective', 'conversion_event', 'optimization_event', 'attribution_window',
  'budget', 'bid_strategy',
  'audience', 'geo', 'age_gender', 'placements', 'advantage_plus', 'retargeting', 'exclusions',
  'schedule',
] as const

/** Our synced copy must be recent enough to have observed a change. */
const MAX_SYNC_AGE_HOURS_FOR_CONTINUITY = 48

/**
 * Prove — or fail to prove — that the configuration responsible for the evaluated spend did not
 * materially change between the start of the earliest evaluated period and now.
 *
 * This is deliberately conservative and account-cohort-scoped: every ad that carried spend must
 * resolve through fresh ad-set and campaign metadata, and the ad-level spend must reconcile to the
 * account denominator. A visible change returns false; an incomplete view returns null.
 */
export async function proveStructuralContinuity(
  db: SupabaseClient,
  adAccountDbId: string,
  periods: Array<{ start: string; end: string }>,
): Promise<boolean | null> {
  if (periods.length === 0) return null
  const sinceDate = periods.map((period) => period.start).sort()[0]!
  const since = new Date(`${sinceDate}T00:00:00Z`).toISOString()
  const fresh = (value: unknown) =>
    value != null
    && Date.now() - new Date(value as string).getTime() <= MAX_SYNC_AGE_HOURS_FOR_CONTINUITY * 3_600_000

  try {
    let accountSpend = 0
    let adLevelSpend = 0
    let sawAccountRow = false
    const cohortAdIds = new Set<string>()
    const pageSize = 1000

    for (const period of periods) {
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await db
          .from('daily_insights').select('entity_level, ad_id, spend')
          .eq('ad_account_id', adAccountDbId)
          .gte('date_start', period.start).lte('date_start', period.end)
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1)
        if (error) throw new Error(`daily_insights: ${error.message}`)
        const rows = data ?? []
        for (const row of rows) {
          const spend = Number(row.spend ?? 0)
          if (row.entity_level === 'account') {
            sawAccountRow = true
            accountSpend += spend
          }
          if (row.entity_level === 'ad') {
            adLevelSpend += spend
            if (spend > 0 && row.ad_id) cohortAdIds.add(String(row.ad_id))
          }
        }
        if (rows.length < pageSize) break
      }
    }

    if (!sawAccountRow) return null
    if (accountSpend > 0) {
      const relativeDifference = Math.abs(adLevelSpend - accountSpend) / accountSpend
      if (relativeDifference > CAMPAIGN_SPEND_TOLERANCE) return null
    } else if (adLevelSpend > 0) {
      return null
    }
    if (cohortAdIds.size === 0) return null

    const { data: adRows, error: adError } = await db
      .from('ads').select('id, adset_id, campaign_id, meta_updated_time, last_synced_at')
      .eq('ad_account_id', adAccountDbId).in('id', [...cohortAdIds])
    if (adError) throw new Error(`ads: ${adError.message}`)
    const ads = adRows ?? []
    if (ads.length !== cohortAdIds.size) return null

    const adsetIds = [...new Set(ads.map((ad) => ad.adset_id).filter(Boolean))].map(String)
    if (adsetIds.length === 0) return null

    const { data: adsetRows, error: adsetError } = await db
      .from('adsets').select('id, campaign_id, meta_updated_time, last_synced_at, last_sig_edit_ts')
      .eq('ad_account_id', adAccountDbId).in('id', adsetIds)
    if (adsetError) throw new Error(`adsets: ${adsetError.message}`)
    const adsets = adsetRows ?? []
    if (adsets.length !== adsetIds.length) return null

    const campaignIds = [...new Set(adsets.map((adset) => adset.campaign_id).filter(Boolean))].map(String)
    if (campaignIds.length === 0) return null

    const { data: campaignRows, error: campaignError } = await db
      .from('campaigns').select('id, meta_updated_time, last_synced_at')
      .eq('ad_account_id', adAccountDbId).in('id', campaignIds)
    if (campaignError) throw new Error(`campaigns: ${campaignError.message}`)
    const campaigns = campaignRows ?? []
    if (campaigns.length !== campaignIds.length) return null

    const relevant = [...ads, ...adsets, ...campaigns]
    for (const row of relevant) {
      if (!fresh(row.last_synced_at) || row.meta_updated_time == null) return null
    }
    for (const row of relevant) {
      if (new Date(row.meta_updated_time as string).toISOString() >= since) return false
    }
    for (const adset of adsets) {
      const timestamp = (adset as { last_sig_edit_ts?: string | null }).last_sig_edit_ts
      if (timestamp && new Date(timestamp).toISOString() >= since) return false
    }

    const { data: executedRows, error: executedError } = await db
      .from('change_requests').select('id')
      .eq('ad_account_id', adAccountDbId).eq('status', 'executed')
      .gte('executed_at', since).limit(1)
    if (executedError) throw new Error(`change_requests: ${executedError.message}`)
    if ((executedRows ?? []).length > 0) return false

    const { data: setupRows, error: setupError } = await db
      .from('ad_setup_decisions').select('id').eq('ad_account_id', adAccountDbId)
      .in('setting_category', [...MATERIAL_SETTING_CATEGORIES])
      .gte('action_taken_date', sinceDate).limit(1)
    if (setupError) throw new Error(`ad_setup_decisions: ${setupError.message}`)
    if ((setupRows ?? []).length > 0) return false

    return true
  } catch {
    return null
  }
}
