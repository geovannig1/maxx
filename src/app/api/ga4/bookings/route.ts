import { createClient } from '@/lib/supabase/server'
import { getGa4Bookings } from '@/lib/ga4/client'
import { metricProvenance } from '@/lib/metrics/provenance'
import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { apiErrorResponse } from '@/lib/security/api-error'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

// Test/preview endpoint for the GA confirmation-event read (attribution TELEMETRY — the outcome ledger is the
// business booking truth). NOTE: getGa4Bookings is BLENDED (all
// channels, incl. organic) — so the response is explicitly labeled (23B/23C) to prevent any consumer
// from rendering it as a paid figure.
// GET /api/ga4/bookings?start=7daysAgo&end=yesterday  (GA4 relative dates or YYYY-MM-DD)
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const activeAccount = await resolveOnlyActiveAccount()
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }

  const sp = req.nextUrl.searchParams
  const start = sp.get('start') ?? '7daysAgo'
  const end = sp.get('end') ?? 'yesterday'

  try {
    const result = await getGa4Bookings(start, end)
    const label = metricProvenance(undefined, { blended: true })
    // Labeled blended so it can never be mistaken for paid/ad-attributed revenue.
    return Response.json({
      ...result,
      ad_account_id: activeAccount.account.id,
      provenance: label.short,
      provenance_note: label.long,
    })
  } catch (err) {
    return apiErrorResponse('GET /api/ga4/bookings', 'GA4_BOOKINGS_QUERY_FAILED', err)
  }
}
