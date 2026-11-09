import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { apiErrorResponse } from '@/lib/security/api-error'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      status: 'UNAVAILABLE',
      code: activeAccountErrorCode(activeAccount.reason),
      error: 'Expert signals are unavailable because one active account could not be resolved.',
    }, { status })
  }
  const adAccountId = activeAccount.account.id

  const [sourcesResult, insightsResult] = await Promise.all([
    db.from('expert_sources')
      .select('id, name, platform, url, description, relevance_notes, is_active, last_checked_at')
      .eq('ad_account_id', adAccountId)
      .eq('is_active', true)
      .order('name'),
    db.from('expert_insights')
      .select('id, source_id, published_at, title, summary, applies_to_account, why_it_applies, review_status, applicable_area, confidence, expires_at, expert_sources(name, platform)')
      .eq('ad_account_id', adAccountId)
      .order('published_at', { ascending: false })
      .limit(30),
  ])
  if (sourcesResult.error || insightsResult.error) {
    return apiErrorResponse(
      'GET /api/signals',
      'EXPERT_SIGNAL_READ_UNAVAILABLE',
      sourcesResult.error ?? insightsResult.error,
      503,
      { status: 'UNAVAILABLE' },
    )
  }

  return Response.json({ sources: sourcesResult.data ?? [], insights: insightsResult.data ?? [] })
}
