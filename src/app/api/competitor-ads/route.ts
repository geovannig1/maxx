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

  const { searchParams } = req.nextUrl
  const competitorId = searchParams.get('competitor_id')
  const activeOnly = searchParams.get('active_only') !== 'false'

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: `Active account ownership is ${activeAccount.reason}.`, status: 'unavailable', ads: [] },
      { status: activeAccount.reason === 'unavailable' ? 500 : 409 },
    )
  }

  let sourceQuery = db
    .from('competitor_sources')
    .select('id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('is_active', true)
  if (competitorId) sourceQuery = sourceQuery.eq('id', competitorId)

  const { data: sources, error: sourceError } = await sourceQuery
  if (sourceError) return apiErrorResponse('GET /api/competitor-ads', 'COMPETITOR_SOURCES_READ_FAILED', sourceError, 500, { status: 'unavailable', ads: [] })

  const sourceIds = (sources ?? []).map((source) => String(source.id))
  if (sourceIds.length === 0) {
    return Response.json({
      status: 'available', action_authority_tier: 'diagnostic_only', prescriptions: [],
      ads: [], total: 0, note: COMPETITOR_DIAGNOSTIC_NOTE,
    })
  }

  let query = db
    .from('competitor_ads')
    .select('*')
    .in('competitor_id', sourceIds)
    .order('estimated_days_running', { ascending: false })

  if (activeOnly) {
    query = query.eq('is_active', true)
  }

  const { data: ads, error, count } = await query

  if (error) return apiErrorResponse('GET /api/competitor-ads', 'COMPETITOR_ADS_READ_FAILED', error, 500)

  const projectedAds = ((ads ?? []) as Array<Record<string, unknown>>).map(projectCompetitorAdRecord)
  return Response.json({
    status: 'available', action_authority_tier: 'diagnostic_only', prescriptions: [],
    ads: projectedAds, total: count ?? projectedAds.length, note: COMPETITOR_DIAGNOSTIC_NOTE,
  })
}
