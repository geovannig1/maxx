import { createClient } from '@/lib/supabase/server'
import { buildReconciliationReport } from '@/lib/diagnostics/reconciliation-report'
import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { apiErrorResponse } from '@/lib/security/api-error'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

// GET /api/diagnostics/reconciliation?from=&to=
// The "prove the numbers" endpoint: Meta-internal spend integrity, a Meta-modelled-vs-GA-telemetry plane
// truth, lifetime billed context, the attribution-window label, and an overall trust score.
// Body lives in lib/diagnostics/reconciliation-report.ts (shared with the MCP diagnosis tools).
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
    return Response.json(await buildReconciliationReport({ from, to, adAccountId: activeAccount.account.id }))
  } catch (e) {
    if (e instanceof Error && e.message === 'Ad account not found') {
      return Response.json({ error: 'Ad account not found' }, { status: 404 })
    }
    return apiErrorResponse('GET /api/diagnostics/reconciliation', 'RECONCILIATION_FAILED', e)
  }
}
