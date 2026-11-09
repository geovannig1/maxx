import { roundMoney } from '@/lib/utils/format-currency'
import { logToolError } from '@/lib/security/api-error'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { nyDaysAgo } from '@/lib/utils/date-utils'

interface BreakdownSegment {
  breakdown_value: string
  spend: number
  leads: number | null
  meta_bookings_estimate: number | null
  ctr: number | null
  cpl: number | null
  meta_cpa_estimate: number | null
  outcome_status: 'available' | 'unavailable'
}

interface AudienceBreakdownResult {
  status: 'available'
  breakdown_type: string
  date_range: { from: string; to: string }
  segments: BreakdownSegment[]
  action_authority_tier: 'diagnostic_only'
  prescriptions: []
  note: string
}

function unavailableAudienceBreakdown(errorCode: string, reason: string) {
  return {
    status: 'unavailable' as const,
    error_code: errorCode,
    unavailable_reason: reason,
    action_authority_tier: 'diagnostic_only' as const,
    prescriptions: [] as [],
    segments: [] as BreakdownSegment[],
  }
}

export async function getAudienceBreakdown(args: {
  breakdown_type?: 'age' | 'gender' | 'publisher_platform' | 'device_platform'
  campaign_id?: string
  days?: number
  limit?: number
}): Promise<object> {
  const {
    breakdown_type = 'age',
    campaign_id,
    days = 30,
    limit = 50,
  } = args

  const supabase = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(supabase)
  if (!activeAccount.ok) {
    return unavailableAudienceBreakdown(
      activeAccountErrorCode(activeAccount.reason),
      `Audience breakdown is unavailable because active account ownership is ${activeAccount.reason}.`,
    )
  }

  // Compute date range (account timezone): until = yesterday, since = until - (days-1)
  const until = new Date(nyDaysAgo(1) + 'T00:00:00Z')
  const since = new Date(nyDaysAgo(days) + 'T00:00:00Z')

  const dateFrom = since.toISOString().split('T')[0]
  const dateTo = until.toISOString().split('T')[0]

  let query = supabase
    .from('insight_breakdowns')
    .select('breakdown_value, spend, impressions, clicks, leads, bookings, ctr, meta_entity_id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('breakdown_type', breakdown_type)
    .gte('date_start', dateFrom)
    .lte('date_start', dateTo)

  if (campaign_id) {
    query = query.eq('meta_entity_id', campaign_id)
  }

  const { data, error } = await query

  if (error) {
    return unavailableAudienceBreakdown(
      'AUDIENCE_BREAKDOWN_READ_UNAVAILABLE',
      logToolError('get_audience_breakdown', 'AUDIENCE_BREAKDOWN_READ_UNAVAILABLE', error),
    )
  }

  const rows = (data ?? []) as Array<{
    breakdown_value: string
    spend: number
    impressions: number
    clicks: number
    leads: number | null
    bookings: number | null
    ctr: number | null
    meta_entity_id: string
  }>

  // Aggregate by breakdown_value. All rates are recomputed from SUMMED clicks/impressions/spend/leads/
  // bookings — never the mean of daily rates (which mis-weights low-volume days).
  const agg = new Map<string, {
    spend: number
    leads: number
    bookings: number
    clicks: number
    impressions: number
    outcomesComplete: boolean
  }>()

  for (const row of rows) {
    const key = row.breakdown_value
    if (!agg.has(key)) {
      agg.set(key, {
        spend: 0, leads: 0, bookings: 0, clicks: 0, impressions: 0,
        outcomesComplete: true,
      })
    }
    const a = agg.get(key)!
    a.spend += Number(row.spend ?? 0)
    const leads = row.leads === null ? Number.NaN : Number(row.leads)
    const bookings = row.bookings === null ? Number.NaN : Number(row.bookings)
    if (!Number.isFinite(leads) || leads < 0 || !Number.isFinite(bookings) || bookings < 0) {
      a.outcomesComplete = false
    } else {
      a.leads += leads
      a.bookings += bookings
    }
    a.clicks += Number(row.clicks ?? 0)
    a.impressions += Number(row.impressions ?? 0)
  }

  // Descriptive delivery only. Meta's breakdown bookings are modelled attribution estimates, so this
  // tool names them as such and never compares them with a business target or turns them into direction.
  const segments: BreakdownSegment[] = []
  for (const [breakdownValue, a] of agg) {
    const leads = a.outcomesComplete ? a.leads : null
    const bookings = a.outcomesComplete ? a.bookings : null
    const cpl = leads !== null && leads > 0 ? a.spend / leads : null
    const metaCpaEstimate = bookings !== null && bookings > 0 ? a.spend / bookings : null
    const ctr = a.impressions > 0 ? (a.clicks * 100) / a.impressions : null
    segments.push({
      breakdown_value: breakdownValue,
      spend: roundMoney(a.spend),
      leads,
      meta_bookings_estimate: bookings,
      ctr: ctr !== null ? Math.round(ctr * 10000) / 10000 : null,
      cpl: cpl !== null ? roundMoney(cpl) : null,
      meta_cpa_estimate: metaCpaEstimate !== null ? roundMoney(metaCpaEstimate) : null,
      outcome_status: a.outcomesComplete ? 'available' : 'unavailable',
    })
  }

  // Spend-descending is a descriptive delivery view, not a winner/best-audience ranking.
  segments.sort((a, b) => b.spend - a.spend || a.breakdown_value.localeCompare(b.breakdown_value))

  const result: AudienceBreakdownResult = {
    status: 'available',
    breakdown_type,
    date_range: { from: dateFrom, to: dateTo },
    segments: segments.slice(0, limit),
    action_authority_tier: 'diagnostic_only',
    prescriptions: [],
    note:
      'Descriptive Meta delivery breakdown only. meta_bookings_estimate and meta_cpa_estimate are modelled attribution, not exact paid outcomes. ' +
      'Null outcomes are unavailable, never zero. Do not infer targeting, exclusion, budget allocation, or setup changes from this response.',
  }

  return result
}
