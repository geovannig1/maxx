import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

const querySchema = z.object({
  account_id: z.string().min(1),
  entity_level: z.enum(['account', 'campaign', 'adset', 'ad']),
  date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  entity_id: z.string().optional(),
  group_by: z.enum(['day', 'week', 'month']).optional().default('day'),
})

interface InsightAggregates {
  total_spend: number
  total_leads: number
  total_bookings: number
  total_impressions: number
  total_clicks: number
  avg_cpl: number | null
  avg_ctr: number | null
  avg_cpm: number | null
}

// GET /api/insights
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams

  const parsed = querySchema.safeParse({
    account_id: sp.get('account_id'),
    entity_level: sp.get('entity_level'),
    date_start: sp.get('date_start'),
    date_end: sp.get('date_end'),
    entity_id: sp.get('entity_id') ?? undefined,
    group_by: sp.get('group_by') ?? 'day',
  })

  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join(', ')
    return Response.json({ error: `Validation failed: ${issues}` }, { status: 400 })
  }

  const { account_id, entity_level, date_start, date_end, entity_id, group_by } = parsed.data

  const adminClient = getAdminClient()

  const activeAccount = await resolveOnlyActiveAccount(adminClient)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }
  // A caller cannot select another tenant/account through this otherwise service-role-backed route.
  if (account_id !== activeAccount.account.accountId) {
    return Response.json({ error: 'Account not found' }, { status: 404 })
  }

  const accountUuid = activeAccount.account.id

  // Fetch raw insights rows
  let query = adminClient
    .from('daily_insights')
    .select('*')
    .eq('ad_account_id', accountUuid)
    .eq('entity_level', entity_level)
    .gte('date_start', date_start)
    .lte('date_stop', date_end)
    .order('date_start', { ascending: true })

  if (entity_id) {
    if (entity_level === 'campaign') query = query.eq('campaign_id', entity_id)
    else if (entity_level === 'adset') query = query.eq('adset_id', entity_id)
    else if (entity_level === 'ad') query = query.eq('ad_id', entity_id)
  }

  const { data: rows, error } = await query

  if (error) {
    return apiErrorResponse('GET /api/insights', 'INSIGHTS_READ_FAILED', error, 500)
  }

  const insights = rows ?? []

  // Build time-bucketed data
  type Bucket = {
    period: string
    spend: number
    leads: number
    bookings: number
    impressions: number
    clicks: number
  }

  const buckets = new Map<string, Bucket>()

  for (const row of insights) {
    // 'YYYY-MM-DD' parses at UTC midnight — bucket with UTC methods (the codebase's date discipline).
    // LOCAL getDay/getDate on a UTC-parsed date shifts week/month buckets a day early on any tz behind UTC.
    const d = new Date(row.date_start)
    let periodKey: string

    if (group_by === 'week') {
      // ISO week start (Monday)
      const day = d.getUTCDay()
      const diff = (day === 0 ? -6 : 1 - day)
      const monday = new Date(d)
      monday.setUTCDate(d.getUTCDate() + diff)
      periodKey = monday.toISOString().slice(0, 10)
    } else if (group_by === 'month') {
      periodKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    } else {
      periodKey = row.date_start
    }

    if (!buckets.has(periodKey)) {
      buckets.set(periodKey, {
        period: periodKey,
        spend: 0, leads: 0, bookings: 0, impressions: 0, clicks: 0,
      })
    }

    const b = buckets.get(periodKey)!
    b.spend += row.spend ?? 0
    b.leads += row.leads ?? 0
    b.bookings += row.bookings ?? 0
    b.impressions += row.impressions ?? 0
    b.clicks += row.clicks ?? 0
  }

  // Rates recomputed from SUMMED totals (never the mean of daily rates, which mis-weights low-volume
  // days). ctr is a percent (clicks÷impressions×100); cpm = spend per 1k impressions; cpl = spend÷leads.
  const data = [...buckets.values()].map(({ period, spend, leads, bookings, impressions, clicks }) => ({
    period,
    spend,
    leads,
    bookings,
    impressions,
    clicks,
    cpl: leads > 0 ? spend / leads : null,
    ctr: impressions > 0 ? (clicks * 100) / impressions : null,
    cpm: impressions > 0 ? (spend * 1000) / impressions : null,
  }))

  // Compute overall aggregates across all rows
  const totals = insights.reduce(
    (acc, row) => {
      acc.total_spend += row.spend ?? 0
      acc.total_leads += row.leads ?? 0
      acc.total_bookings += row.bookings ?? 0
      acc.total_impressions += row.impressions ?? 0
      acc.total_clicks += row.clicks ?? 0
      return acc
    },
    {
      total_spend: 0, total_leads: 0, total_bookings: 0, total_impressions: 0, total_clicks: 0,
    }
  )

  const aggregates: InsightAggregates = {
    total_spend: totals.total_spend,
    total_leads: totals.total_leads,
    total_bookings: totals.total_bookings,
    total_impressions: totals.total_impressions,
    total_clicks: totals.total_clicks,
    // Recomputed from summed totals (not the mean of daily rates).
    avg_cpl: totals.total_leads > 0 ? totals.total_spend / totals.total_leads : null,
    avg_ctr: totals.total_impressions > 0 ? (totals.total_clicks * 100) / totals.total_impressions : null,
    avg_cpm: totals.total_impressions > 0 ? (totals.total_spend * 1000) / totals.total_impressions : null,
  }

  return Response.json({ data, aggregates })
}
