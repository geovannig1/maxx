import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { yesterday } from '@/lib/utils/date-utils'
import { NextRequest } from 'next/server'
import { accountTimezone } from '@/config/business-config'

export const runtime = 'nodejs'

// GET /api/daypart?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns a daypart snapshot only when its stored evidence window exactly matches the selection.
// Response: { data: Array<{ hour, day, cpa, spend, bookings }> }
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const from = req.nextUrl.searchParams.get('from')
  const to = req.nextUrl.searchParams.get('to')
  const isoDate = /^\d{4}-\d{2}-\d{2}$/
  if (!from || !to || !isoDate.test(from) || !isoDate.test(to) || from > to || to > yesterday()) {
    return Response.json({ code: 'INVALID_DAYPART_WINDOW', error: 'Day-part evidence requires an exact closed-day window.' }, { status: 400 })
  }

  const db = getAdminClient()
  const active = await resolveOnlyActiveAccount(db)
  if (!active.ok) {
    return Response.json({
      error: 'Day-part evidence requires exactly one active ad account.',
      code: activeAccountErrorCode(active.reason),
    }, { status: activeAccountErrorStatus(active.reason) })
  }

  const { data: rows, error } = await db
    .from('daypart_insights')
    .select('hour_of_day, day_of_week, spend, bookings, cpa')
    .eq('ad_account_id', active.account.id)
    .eq('date_range_start', from)
    .eq('date_range_end', to)

  if (error) return Response.json({ error: 'Day-part evidence is temporarily unavailable.' }, { status: 503 })

  // Group/average by hour_of_day + day_of_week
  type Bucket = {
    spend_sum: number
    bookings_sum: number
  }

  const buckets = new Map<string, Bucket>()

  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const hour = r.hour_of_day as number
    const day = r.day_of_week as number
    const key = `${day}-${hour}`

    if (!buckets.has(key)) {
      buckets.set(key, { spend_sum: 0, bookings_sum: 0 })
    }

    const b = buckets.get(key)!
    b.spend_sum += Number(r.spend ?? 0)
    b.bookings_sum += Number(r.bookings ?? 0)
  }

  const data = Array.from(buckets.entries()).map(([key, b]) => {
    const [day, hour] = key.split('-').map(Number)
    return {
      hour,
      day,
      spend: b.spend_sum,
      bookings: b.bookings_sum,
      cpa: b.bookings_sum > 0 ? b.spend_sum / b.bookings_sum : null,
    }
  })

  return Response.json({
    data,
    window: { from, to, timezone: accountTimezone() },
    availability: data.length > 0 ? 'available' : 'unavailable',
    ...(data.length === 0 ? { blocker: 'exact_daypart_snapshot_unavailable' } : {}),
  })
}
