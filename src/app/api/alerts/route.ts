import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { projectDiagnosticAlert } from '@/lib/authority/diagnostic-surface'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

// GET /api/alerts
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  // Accept both `resolved` (page convention) and `is_resolved` (DB convention)
  const resolvedParam = sp.get('resolved') ?? sp.get('is_resolved')
  const severity = sp.get('severity')
  const type = sp.get('type')
  const page = Math.max(1, parseInt(sp.get('page') ?? '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(sp.get('page_size') ?? '50', 10)))

  const adminClient = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(adminClient)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account found'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }

  let query = adminClient
    .from('alerts')
    .select(
      'id, alert_type, severity, title, message, alert_date, detected_at, is_resolved, ' +
      'entity_level, meta_campaign_id, meta_adset_id, meta_ad_id, ' +
      'metric_name, metric_value, threshold_value, baseline_value, ' +
      'why_it_matters, recommended_actions, amount_at_risk, action_label, action_url',
      { count: 'exact' }
    )
    .eq('ad_account_id', activeAccount.account.id)
    .order('amount_at_risk', { ascending: false, nullsFirst: false })
    .order('severity', { ascending: true })
    .order('detected_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1)

  if (resolvedParam !== null) {
    query = query.eq('is_resolved', resolvedParam === 'true')
  }
  if (severity) query = query.eq('severity', severity)
  if (type) query = query.eq('alert_type', type)

  const { data, error, count } = await query

  if (error) {
    return apiErrorResponse('GET /api/alerts', 'ALERTS_READ_FAILED', error, 500)
  }

  return Response.json({ alerts: (data ?? []).map((row) => projectDiagnosticAlert(row as unknown as Record<string, unknown>)), total: count ?? 0 })
}
