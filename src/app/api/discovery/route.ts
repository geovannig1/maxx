import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { COMPETITOR_DIAGNOSTIC_NOTE, projectCompetitorAdRecord } from '@/lib/competitors/diagnostic-projection'
import { NextRequest } from 'next/server'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { searchParams } = new URL(req.url)
  const savedOnly = searchParams.get('saved') === 'true'
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.`, status: 'unavailable', ads: [] },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  const { data: sources, error: sourceError } = await db
    .from('competitor_sources')
    .select('id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)

  if (sourceError) return apiErrorResponse('discovery', 'competitor_sources_read_failed', sourceError, 500, { status: 'unavailable', ads: [] })

  const sourceIds = (sources ?? []).map((source) => String(source.id))
  if (sourceIds.length === 0) {
    return Response.json({
      status: 'available', action_authority_tier: 'diagnostic_only', prescriptions: [],
      ads: [], total: 0, note: COMPETITOR_DIAGNOSTIC_NOTE,
    })
  }

  let query = db
    .from('competitor_ads')
    .select(`
      id, competitor_id, ad_archive_id, ad_creative_bodies, ad_snapshot_url,
      page_name, estimated_days_running, impression_range, is_active,
      is_saved, saved_at, user_notes, ai_analysis, created_at,
      competitor_sources(id, name)
    `)
    .in('competitor_id', sourceIds)
    .order('estimated_days_running', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (savedOnly) {
    query = query.eq('is_saved', true)
  } else {
    query = query.eq('is_active', true)
  }

  const { data, error, count } = await query
  if (error) return apiErrorResponse('discovery', 'competitor_ads_read_failed', error)

  const ads = ((data ?? []) as Array<Record<string, unknown>>).map(projectCompetitorAdRecord)
  return Response.json({
    status: 'available', action_authority_tier: 'diagnostic_only', prescriptions: [],
    ads, total: count ?? ads.length, note: COMPETITOR_DIAGNOSTIC_NOTE,
  })
}
