import { ownerOnly } from '@/lib/auth/require-owner'
import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { aggregateMetrics, emptyMetrics, INSIGHT_METRIC_COLUMNS, publicEntityMetrics, type EntityMetrics } from '@/lib/metrics/aggregate'
import { getCreativeDiagnostic, type CreativeDiagnostic } from '@/lib/creative/verdict'
import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

function unavailable(code: string, message: string, status = 503) {
  return Response.json({ error: message, code }, { status })
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  // Accept both from/to (page convention) and date_start/date_end
  const dateStart = sp.get('from') ?? sp.get('date_start')
  const dateEnd = sp.get('to') ?? sp.get('date_end')
  const status = sp.get('status')
  const adsetMetaId = sp.get('adset') // drill-down: only this ad set's ads

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    const code = activeAccountErrorCode(activeAccount.reason)
    const statusCode = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return unavailable(code, 'Ad performance is unavailable because active-account ownership could not be resolved.', statusCode)
  }
  const adAccountId = activeAccount.account.id

  // Resolve the drill-down parent (Meta adset_id → adsets.id) before filtering.
  let adsetDbId: string | null = null
  if (adsetMetaId) {
    const { data: as, error: adsetError } = await db
      .from('adsets')
      .select('id')
      .eq('ad_account_id', adAccountId)
      .eq('adset_id', adsetMetaId)
      .maybeSingle()
    if (adsetError) return unavailable('ADSET_READ_UNAVAILABLE', 'Ad performance is unavailable because the scoped ad-set read failed.')
    if (!as?.id) return Response.json({ ads: [], total: 0 })
    adsetDbId = as.id as string
  }

  let query = db
    .from('ads')
    .select('id, ad_id, ad_name, status, effective_status, meta_creative_id, issues_info, review_feedback, created_at')
    .eq('ad_account_id', adAccountId)
    .order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)
  if (adsetDbId) query = query.eq('adset_id', adsetDbId)

  const { data: rawAds, error } = await query
  if (error) return unavailable('ADS_READ_UNAVAILABLE', 'Ad performance is unavailable because the scoped ad read failed.')

  const ads = (rawAds ?? []) as Array<Record<string, unknown>>
  if (ads.length === 0) return Response.json({ ads: [], total: 0 })

  // Fetch presentation-only creative context from Meta's synced asset inventory.
  const metaCreativeIds = [...new Set(ads.map((a) => a.meta_creative_id as string).filter(Boolean))]
  const creativeMap = new Map<string, {
    name: string | null
    format: string | null
    primaryText: string | null
    headline: string | null
    thumbnailUrl: string | null
  }>()
  if (metaCreativeIds.length > 0) {
    const { data: creatives, error: creativesError } = await db
      .from('creatives')
      .select('creative_id, creative_name, asset_type, body, title, thumbnail_url, image_url')
      .eq('ad_account_id', adAccountId)
      .in('creative_id', metaCreativeIds)
    if (creativesError) return unavailable('CREATIVE_READ_UNAVAILABLE', 'Ad performance is unavailable because the scoped creative read failed.')
    for (const c of (creatives ?? []) as Array<Record<string, unknown>>) {
      creativeMap.set(c.creative_id as string, {
        name: (c.creative_name as string | null) ?? null,
        format: (c.asset_type as string | null) ?? null,
        primaryText: (c.body as string | null) ?? null,
        headline: (c.title as string | null) ?? null,
        thumbnailUrl: (c.thumbnail_url ?? c.image_url) as string | null,
      })
    }
  }

  // Aggregate ad-level insights via the shared aggregator (same math as campaigns / ad-sets).
  const adUuids = ads.map((a) => a.id as string)
  const rowsByAd = new Map<string, Array<Record<string, unknown>>>()

  // Inclusive day count reported alongside descriptive delivery evidence.
  const parsedWindowDays = dateStart && dateEnd
    ? Math.round((Date.parse(dateEnd) - Date.parse(dateStart)) / 86_400_000) + 1
    : 0
  const windowDays = Number.isFinite(parsedWindowDays) && parsedWindowDays > 0 ? parsedWindowDays : 0

  if (dateStart && dateEnd && adUuids.length > 0) {
    const { data: insights, error: insightsError } = await db
      .from('daily_insights')
      .select(`ad_id, ${INSIGHT_METRIC_COLUMNS}`)
      .eq('ad_account_id', adAccountId)
      .in('ad_id', adUuids)
      .eq('entity_level', 'ad')
      .gte('date_start', dateStart)
      .lte('date_stop', dateEnd)
    if (insightsError) return unavailable('AD_INSIGHTS_READ_UNAVAILABLE', 'Ad performance is unavailable because the scoped insight read failed.')

    for (const r of (insights ?? []) as Array<Record<string, unknown>>) {
      const id = r.ad_id as string
      if (!rowsByAd.has(id)) rowsByAd.set(id, [])
      rowsByAd.get(id)!.push(r)
    }
  }

  const result = ads.map((ad) => {
    const rows = rowsByAd.get(ad.id as string)
    const metrics: EntityMetrics | null = rows?.length ? publicEntityMetrics(aggregateMetrics(rows)) : null
    const diagnosticMetrics = metrics ?? emptyMetrics()
    const diagnostic: CreativeDiagnostic = getCreativeDiagnostic({
      ctr: diagnosticMetrics.ctr,
      frequency: diagnosticMetrics.frequency,
      earlyViewRate: diagnosticMetrics.hook_rate,
      earlyViewSource: diagnosticMetrics.early_view_source,
      thruplayRate: diagnosticMetrics.thruplay_rate,
      retentionP25Rate: diagnosticMetrics.retention_p25_rate,
      retentionDenominator: diagnosticMetrics.retention_denominator,
      videoStartCoverage: diagnosticMetrics.video_start_coverage,
      derivedMetricWarningCount: diagnosticMetrics.derived_metric_warning_count,
      impressions: diagnosticMetrics.impressions,
      windowDays,
    })
    return {
      ad_id: ad.ad_id,
      ad_name: ad.ad_name ?? ad.ad_id,
      status: ad.effective_status ?? ad.status ?? 'UNKNOWN',
      effective_status: ad.effective_status ?? null,
      issues_info: ad.issues_info ?? null,
      review_feedback: ad.review_feedback ?? null,
      thumbnail_url: ad.meta_creative_id ? (creativeMap.get(ad.meta_creative_id as string)?.thumbnailUrl ?? null) : null,
      creative: ad.meta_creative_id ? (() => {
        const creative = creativeMap.get(ad.meta_creative_id as string)
        return {
          name: creative?.name ?? null,
          format: creative?.format ?? null,
          primaryText: creative?.primaryText ?? null,
          headline: creative?.headline ?? null,
        }
      })() : null,
      metrics_status: metrics ? 'available' : 'unavailable',
      metrics,
      diagnostic,
    }
  })

  return Response.json({ ads: result, total: result.length })
}
