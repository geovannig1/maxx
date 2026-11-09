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
  const campaignMetaId = sp.get('campaign') // drill-down: only this campaign's ad sets

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
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
  const adAccountId = activeAccount.account.id

  // Resolve the drill-down parent (Meta campaign_id → campaigns.id) before filtering.
  let campaignDbId: string | null = null
  if (campaignMetaId) {
    const { data: camp, error: campaignError } = await db
      .from('campaigns')
      .select('id')
      .eq('ad_account_id', adAccountId)
      .eq('campaign_id', campaignMetaId)
      .maybeSingle()
    if (campaignError) {
      return unavailable(
        'CAMPAIGN_READ_UNAVAILABLE',
        'Ad-set performance is unavailable because the scoped campaign read failed.',
      )
    }
    if (!camp?.id) return Response.json({ adsets: [], total: 0 })
    campaignDbId = camp.id as string
  }

  let query = db.from('adsets')
    .select('id, adset_id, adset_name, campaign_id, status, effective_status, daily_budget, optimization_goal, created_at')
    .eq('ad_account_id', adAccountId)
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (campaignDbId) query = query.eq('campaign_id', campaignDbId)

  const { data: rawAdsets, error } = await query
  if (error) {
    return unavailable(
      'ADSETS_READ_UNAVAILABLE',
      'Ad-set performance is unavailable because the scoped ad-set read failed.',
    )
  }

  const adsets = (rawAdsets ?? []) as Array<Record<string, unknown>>
  if (adsets.length === 0) return Response.json({ adsets: [], total: 0 })

  // Join campaign names
  const campaignDbIds = [...new Set(adsets.map((a) => a.campaign_id as string).filter(Boolean))]
  const campaignNameMap = new Map<string, string>()
  if (campaignDbIds.length > 0) {
    const { data: campaigns, error: campaignsError } = await db
      .from('campaigns')
      .select('id, campaign_name')
      .eq('ad_account_id', adAccountId)
      .in('id', campaignDbIds)
    if (campaignsError) {
      return unavailable(
        'CAMPAIGN_READ_UNAVAILABLE',
        'Ad-set performance is unavailable because the scoped campaign read failed.',
      )
    }
    for (const c of (campaigns ?? []) as Array<Record<string, unknown>>) {
      campaignNameMap.set(c.id as string, c.campaign_name as string ?? '—')
    }
  }

  // Aggregate insights — full metric set via the shared aggregator (sums + rates from totals).
  const adsetUuids = adsets.map((a) => a.id as string)
  const rowsByAdset = new Map<string, Array<Record<string, unknown>>>()

  if (dateStart && dateEnd && adsetUuids.length > 0) {
    const { data: insights, error: insightsError } = await db
      .from('daily_insights')
      .select(`adset_id, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', adAccountId)
      .in('adset_id', adsetUuids)
      .eq('entity_level', 'adset')
      .gte('date_start', dateStart)
      .lte('date_stop', dateEnd)
    if (insightsError) {
      return unavailable(
        'ADSET_INSIGHTS_READ_UNAVAILABLE',
        'Ad-set performance is unavailable because the scoped insight read failed.',
      )
    }

    for (const r of (insights ?? []) as Array<Record<string, unknown>>) {
      const id = r.adset_id as string
      if (!rowsByAdset.has(id)) rowsByAdset.set(id, [])
      rowsByAdset.get(id)!.push(r)
    }
  }

  const result = adsets.map((a) => {
    const rows = rowsByAdset.get(a.id as string)
    const metrics: EntityMetrics | null = rows?.length ? publicEntityMetrics(aggregateMetrics(rows)) : null
    // Days the ad set actually delivered (spend > 0) — the honest pacing denominator (a set launched
    // mid-range shouldn't read "under-pacing" for the days before it existed).
    const daysDelivering = (rows ?? []).filter((r) => Number(r.spend ?? 0) > 0).length
    return {
      adset_id: a.adset_id,
      adset_name: a.adset_name ?? a.adset_id,
      campaign_name: campaignNameMap.get(a.campaign_id as string) ?? '—',
      status: a.effective_status ?? a.status ?? 'UNKNOWN',
      daily_budget: a.daily_budget ?? null,
      days_delivering: daysDelivering,
      optimization_goal: a.optimization_goal ?? null,
      metrics_status: metrics ? 'available' : 'unavailable',
      metrics,
    }
  })

  return Response.json({ adsets: result, total: result.length })
}
