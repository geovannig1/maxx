import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { aggregateMetrics, INSIGHT_METRIC_COLUMNS, publicEntityMetrics, type EntityMetrics } from '@/lib/metrics/aggregate'
import { NextRequest } from 'next/server'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export const runtime = 'nodejs'

function unavailable(code: string, message: string): Response {
  return Response.json({ error: message, code }, { status: 503 })
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const dateStart = sp.get('from') ?? sp.get('date_start')
  const dateEnd = sp.get('to') ?? sp.get('date_end')
  const status = sp.get('status')

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const responseStatus = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account found'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status: responseStatus })
  }
  const adAccountId = activeAccount.account.id

  let query = db.from('campaigns')
    .select('id, campaign_id, campaign_name, status, effective_status, objective, daily_budget, lifetime_budget, start_time, stop_time')
    .eq('ad_account_id', adAccountId)
    .order('created_at', { ascending: false })
  if (status && status !== 'all') query = query.eq('status', status)

  const { data: rawCampaigns, error } = await query
  if (error) {
    return unavailable(
      'CAMPAIGNS_READ_UNAVAILABLE',
      'Campaign performance is unavailable because the scoped campaign read failed.',
    )
  }

  const campaigns = (rawCampaigns ?? []) as Array<Record<string, unknown>>
  if (campaigns.length === 0) return Response.json({ campaigns: [], total: 0 })

  // Aggregate insights — full metric set via the shared aggregator (sums + rates from totals).
  const campaignUuids = campaigns.map((c) => c.id as string)
  const rowsByCampaign = new Map<string, Array<Record<string, unknown>>>()

  if (dateStart && dateEnd && campaignUuids.length > 0) {
    const { data: insights, error: insightsError } = await db
      .from('daily_insights')
      .select(`campaign_id, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', adAccountId)
      .in('campaign_id', campaignUuids)
      .eq('entity_level', 'campaign')
      .gte('date_start', dateStart)
      .lte('date_stop', dateEnd)
    if (insightsError) {
      return unavailable(
        'CAMPAIGN_INSIGHTS_READ_UNAVAILABLE',
        'Campaign performance is unavailable because the scoped insight read failed.',
      )
    }

    for (const r of (insights ?? []) as Array<Record<string, unknown>>) {
      const id = r.campaign_id as string
      if (!rowsByCampaign.has(id)) rowsByCampaign.set(id, [])
      rowsByCampaign.get(id)!.push(r)
    }
  }

  const result = campaigns.map((c) => {
    const rows = rowsByCampaign.get(c.id as string)
    const metrics: EntityMetrics | null = rows?.length ? publicEntityMetrics(aggregateMetrics(rows)) : null
    // Days the campaign actually delivered (spend > 0) — honest pacing denominator (parity with the
    // adsets route; a campaign launched mid-range must not read "under-pacing" for pre-launch days).
    const daysDelivering = (rows ?? []).filter((r) => Number(r.spend ?? 0) > 0).length
    return {
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name ?? c.campaign_id,
      status: c.effective_status ?? c.status ?? 'UNKNOWN',
      objective: c.objective ?? null,
      daily_budget: c.daily_budget ?? null,
      days_delivering: daysDelivering,
      lifetime_budget: c.lifetime_budget ?? null,
      start_time: c.start_time ?? null,
      stop_time: c.stop_time ?? null,
      metrics_status: metrics ? 'available' : 'unavailable',
      metrics,
    }
  })

  return Response.json({ campaigns: result, total: result.length })
}
