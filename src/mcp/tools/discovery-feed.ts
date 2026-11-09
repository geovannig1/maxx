import { logToolError } from '@/lib/security/api-error'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import {
  COMPETITOR_DIAGNOSTIC_NOTE,
  projectCompetitorAiObservation,
} from '@/lib/competitors/diagnostic-projection'
import { getAdminClient } from '@/lib/supabase/admin'

interface DiscoveryAdRow {
  id: string
  ad_archive_id: string
  competitor_id: string
  page_name: string | null
  estimated_days_running: number | null
  impression_range: string | null
  is_saved: boolean
  ai_analysis: Record<string, unknown> | null
  created_at: string
}

function unavailableDiscoveryFeed(errorCode: string, reason: string) {
  return {
    status: 'unavailable' as const,
    untrusted_external_data: true as const,
    error_code: errorCode,
    unavailable_reason: reason,
    action_authority_tier: 'diagnostic_only' as const,
    setup_guidance_status: 'withheld' as const,
    prescriptions: [] as [],
    total: 0,
    ads: [],
  }
}

export async function getDiscoveryFeed(args: {
  min_days_running?: number
  saved_only?: boolean
  limit?: number
}): Promise<object> {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return unavailableDiscoveryFeed(
      activeAccountErrorCode(activeAccount.reason),
      `Discovery is unavailable because active account ownership is ${activeAccount.reason}.`,
    )
  }

  const { data: sources, error: sourceError } = await db
    .from('competitor_sources')
    .select('id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)

  if (sourceError) {
    return unavailableDiscoveryFeed(
      'COMPETITOR_SOURCE_READ_UNAVAILABLE',
      logToolError('get_discovery_feed', 'COMPETITOR_SOURCE_READ_UNAVAILABLE', sourceError),
    )
  }

  const sourceIds = (sources ?? []).map((source) => String(source.id))
  if (sourceIds.length === 0) {
    return {
      status: 'available',
      untrusted_external_data: true,
      action_authority_tier: 'diagnostic_only',
      setup_guidance_status: 'withheld',
      prescriptions: [],
      total: 0,
      longevity_observation_count: 0,
      ads: [],
      note: COMPETITOR_DIAGNOSTIC_NOTE,
    }
  }

  const limit = Math.min(args.limit ?? 30, 100)
  let query = db
    .from('competitor_ads')
    .select('id, ad_archive_id, competitor_id, page_name, estimated_days_running, impression_range, is_saved, ai_analysis, created_at')
    .in('competitor_id', sourceIds)
    .order('estimated_days_running', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (args.saved_only) query = query.eq('is_saved', true)
  else query = query.eq('is_active', true)
  if (args.min_days_running) query = query.gte('estimated_days_running', args.min_days_running)

  const { data, error } = await query
  if (error) {
    return unavailableDiscoveryFeed(
      'COMPETITOR_AD_READ_UNAVAILABLE',
      logToolError('get_discovery_feed', 'COMPETITOR_AD_READ_UNAVAILABLE', error),
    )
  }

  const ads = (data ?? []) as DiscoveryAdRow[]

  return {
    status: 'available',
    untrusted_external_data: true,
    action_authority_tier: 'diagnostic_only',
    setup_guidance_status: 'withheld',
    prescriptions: [],
    total: ads.length,
    longevity_observation_count: ads.filter((ad) => (ad.estimated_days_running ?? 0) >= 30).length,
    ads: ads.map((ad) => ({
      id: ad.id,
      competitor_id: ad.competitor_id,
      competitor: ad.page_name,
      days_running: ad.estimated_days_running,
      is_saved: ad.is_saved,
      observed_attributes: projectCompetitorAiObservation(ad.ai_analysis),
      impression_range: ad.impression_range,
      longevity_observed: (ad.estimated_days_running ?? 0) >= 30,
    })),
    note: COMPETITOR_DIAGNOSTIC_NOTE,
  }
}
