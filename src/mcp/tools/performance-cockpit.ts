import { loadPerformanceCockpitData } from '@/lib/cockpit/builder'
import { resolveClosedDateRange } from '@/lib/dashboard/closed-date-range'
import { checkRateLimit } from '../lib/rate-limit'
import { getSupabaseClient } from '../lib/supabase'

/** Canonical Maxx/MCP read path for the same immutable claims rendered by the owner cockpit. */
export async function getPerformanceCockpit(args: {
  start_date?: string
  end_date?: string
}) {
  checkRateLimit('get_performance_cockpit')
  const range = resolveClosedDateRange(args.start_date, args.end_date)
  const cockpit = await loadPerformanceCockpitData({
    range: { from: range.start, to: range.end },
    db: getSupabaseClient(),
  })
  return cockpit
}
