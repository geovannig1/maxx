import { createClient } from '@/lib/supabase/server'
import { buildAnomalyReport } from '@/lib/diagnostics/anomaly-report'
import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

// GET /api/diagnostics/anomalies?from=&to=
// Explains which efficiency metrics worsened vs the prior equal-length window, decomposing each into the
// arithmetic driver (numerator vs denominator) and the campaign that drove it — each with a trust score.
// Body lives in lib/diagnostics/anomaly-report.ts (shared with the MCP diagnosis tools).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const from = sp.get('from') ?? sp.get('date_start')
  const to = sp.get('to') ?? sp.get('date_end')
  if (!from || !to) return Response.json({ error: 'from and to are required' }, { status: 400 })

  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }

  try {
    return Response.json(await buildAnomalyReport({ from, to, adAccountId: activeAccount.account.id }))
  } catch (error) {
    return apiErrorResponse('GET /api/diagnostics/anomalies', 'ANOMALY_REPORT_FAILED', error, 500)
  }
}
