import { projectFlagSurface } from '@/lib/authority/diagnostic-surface'
import { getSupabaseClient } from '@/mcp/lib/supabase'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

/**
 * READ-TIME AUTHORITY RESOLUTION — STRUCTURAL, not linguistic.
 *
 * The previous version called `assertsMoneyAuthority()` on each stored string
 * and downgraded the ones that "looked like" instructions. That made a phrase matcher the live safety
 * decision: anything it failed to recognise passed through as approved advice. Detecting English is
 * not evidence validation.
 *
 * Now: a flag with no ActionDecision at or above the policy floor is diagnostic-only BY STRUCTURE,
 * whatever its wording. Since nothing writes ActionDecisions for flags yet, every flag resolves
 * legacy — which is the correct and safe answer, and it is reached without reading a word of prose.
 * The phrase check survives only as an observability warning on rows that already resolved diagnostic.
 */
const resolveFlagAuthority = <T extends Record<string, unknown>>(rows: T[]) => rows.map(projectFlagSurface)

export async function getWinnerLoserFlags(args: {
  flag_type?: string
  audience_type?: string
  window_days?: number
  limit?: number
}) {
  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    throw new Error(`getWinnerLoserFlags unavailable: active account ${activeAccount.reason}`)
  }
  const supabase = getSupabaseClient()
  const limit = Math.min(args.limit ?? 30, 100)

  let query = supabase
    .from('flags')
    .select('flag_date, window_days, entity_level, meta_campaign_id, meta_adset_id, meta_ad_id, flag_type, confidence, audience_type, reason, recommended_action, watch_next, spend_in_window, cpa_in_window, ctr_in_window, frequency_in_window, evidence')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
    .order('flag_date', { ascending: false })
    .limit(limit)

  if (args.flag_type) query = query.eq('flag_type', args.flag_type)
  if (args.audience_type) query = query.eq('audience_type', args.audience_type)
  if (args.window_days) query = query.eq('window_days', args.window_days)

  const { data, error } = await query
  if (error) throw new Error(`getWinnerLoserFlags failed: ${error.message}`)

  const flags = resolveFlagAuthority((data ?? []) as Array<Record<string, unknown>>)
  return {
    total: flags.length,
    flags,
    action_authority: 'Every `recommended_action` here is DIAGNOSTIC. Flags are computed from Meta-MODELLED conversions, which cannot tie spend to outcomes, so no budget scale, cut or pause is authorised on them however clear a flag looks. Use them to decide what to INVESTIGATE.',
    summary: {
      winners: data?.filter((f: { flag_type: string }) => f.flag_type === 'winner').length ?? 0,
      losers: data?.filter((f: { flag_type: string }) => f.flag_type === 'loser').length ?? 0,
      scale_candidates: data?.filter((f: { flag_type: string }) => f.flag_type === 'scale_candidate').length ?? 0,
      watchlist: data?.filter((f: { flag_type: string }) => f.flag_type === 'watchlist').length ?? 0,
      creative_refresh: data?.filter((f: { flag_type: string }) => f.flag_type === 'creative_refresh').length ?? 0,
      too_early: data?.filter((f: { flag_type: string }) => f.flag_type === 'too_early').length ?? 0,
    },
  }
}

export async function getScaleCandidates(args: { limit?: number }) {
  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    throw new Error(`getScaleCandidates unavailable: active account ${activeAccount.reason}`)
  }
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('flags')
    .select('flag_date, window_days, entity_level, meta_campaign_id, meta_adset_id, meta_ad_id, audience_type, reason, recommended_action, watch_next, spend_in_window, cpa_in_window, frequency_in_window, confidence')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
    .eq('flag_type', 'scale_candidate')
    .order('flag_date', { ascending: false })
    .limit(Math.min(args.limit ?? 20, 50))

  if (error) throw new Error(`getScaleCandidates failed: ${error.message}`)
  // Same normalization: this entry point returns SCALE candidates, which is exactly the shape that
  // must never carry an imperative on modelled evidence.
  return {
    total: data?.length ?? 0,
    scale_candidates: resolveFlagAuthority((data ?? []) as Array<Record<string, unknown>>),
    action_authority: 'DIAGNOSTIC ONLY. "scale_candidate" is a flag TYPE, not an authorisation: these rest on Meta-MODELLED conversions and no budget increase is authorised on them. Interaction-cohort evidence is required for that and does not exist for this account.',
  }
}

export async function getWatchlist(args: { limit?: number }) {
  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    throw new Error(`getWatchlist unavailable: active account ${activeAccount.reason}`)
  }
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('flags')
    .select('flag_date, window_days, entity_level, meta_campaign_id, meta_adset_id, meta_ad_id, audience_type, reason, recommended_action, watch_next, spend_in_window, cpa_in_window, frequency_in_window, confidence')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
    .in('flag_type', ['watchlist', 'creative_refresh'])
    .order('flag_date', { ascending: false })
    .limit(Math.min(args.limit ?? 20, 50))

  if (error) throw new Error(`getWatchlist failed: ${error.message}`)
  // This returned stored rows DIRECTLY, so raw legacy prose reached the model
  // as current authority while the two sibling entry points resolved theirs. Same resolver, same
  // structural rule — no sink may treat stored English as authority.
  return {
    total: data?.length ?? 0,
    watchlist: resolveFlagAuthority((data ?? []) as Array<Record<string, unknown>>),
    action_authority: 'DIAGNOSTIC ONLY. Watchlist rows rest on Meta-MODELLED conversions and carry no ActionDecision, so no budget scale, cut or pause is authorised on them.',
  }
}
