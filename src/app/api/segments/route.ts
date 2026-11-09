import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { aggregateMetrics, type EntityMetrics } from '@/lib/metrics/aggregate'
import { breakdownTypeFor, prettifySegmentValue } from '@/lib/segments/dimensions'
import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

// GET /api/segments?dimension=platform|placement|device|age|gender|region&from=&to=
// Aggregates insight_breakdowns rows for one dimension across the window. Rates are recomputed from
// summed totals via the shared aggregator — same math as the entity tables (breakdowns carry no
// reach/frequency/video, so those EntityMetrics fields stay 0/null and are not displayed).
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const dimension = sp.get('dimension') ?? 'platform'
  const dateStart = sp.get('from') ?? sp.get('date_start')
  const dateEnd = sp.get('to') ?? sp.get('date_end')

  const breakdownType = breakdownTypeFor(dimension)
  if (!breakdownType) return Response.json({ error: `Unknown dimension "${dimension}"` }, { status: 400 })
  if (!dateStart || !dateEnd) return Response.json({ error: 'from and to are required' }, { status: 400 })

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }
  const { data: rows, error } = await db
    .from('insight_breakdowns')
    .select('breakdown_value, spend, impressions, clicks, leads, bookings')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('breakdown_type', breakdownType)
    .gte('date_start', dateStart)
    .lte('date_start', dateEnd)

  if (error) {
    return Response.json({
      error: 'Segment performance is unavailable because the scoped breakdown read failed.',
      code: 'SEGMENTS_READ_UNAVAILABLE',
    }, { status: 503 })
  }

  const byValue = new Map<string, Array<Record<string, unknown>>>()
  for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
    const v = (r.breakdown_value as string) ?? 'unknown'
    if (!byValue.has(v)) byValue.set(v, [])
    byValue.get(v)!.push(r)
  }

  const segments = [...byValue.entries()].map(([value, segRows]) => {
    const metrics: EntityMetrics = aggregateMetrics(segRows)
    return { value, label: prettifySegmentValue(value), metrics_status: 'available', metrics }
  })

  segments.sort((a, b) => b.metrics.spend - a.metrics.spend)

  const totals = segments.length > 0
    ? aggregateMetrics((rows ?? []) as Array<Record<string, unknown>>)
    : null

  return Response.json({
    dimension,
    segments,
    totals,
    metrics_status: totals ? 'available' : 'unavailable',
    total: segments.length,
  })
}
