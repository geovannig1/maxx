import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { computeVideoMetrics } from '@/lib/creative/video-metrics'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'

export const runtime = 'nodejs'

// Daily series for ONE ad — powers the "fatigue over time" trend in the Creative Lab panel.
// Kept separate from /api/ads so the list payload stays lean; fetched only when a panel opens.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const metaAdId = sp.get('ad_id')
  const dateStart = sp.get('from') ?? sp.get('date_start')
  const dateEnd = sp.get('to') ?? sp.get('date_end')
  if (!metaAdId || !dateStart || !dateEnd) {
    return Response.json({ error: 'ad_id, from and to are required' }, { status: 400 })
  }

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }

  // Map Meta ad_id → internal ads.id (daily_insights keys on the internal uuid).
  const { data: adRow, error: adError } = await db
    .from('ads')
    .select('id')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('ad_id', metaAdId)
    .maybeSingle()
  if (adError) return apiErrorResponse('GET /api/ads/trend', 'AD_READ_FAILED', adError, 500)
  if (!adRow) return Response.json({ points: [] })

  const { data: rows, error } = await db
    .from('daily_insights')
    // Derive the video series from RAW honest fields and carry the contract flag. hold_rate
    // is retired (it was thruplays/p25 and could exceed 100%); legacy rows without a contract are LABELLED, never
    // silently mixed into a series with contract-bearing ones.
    .select('date_start, spend, impressions, clicks, frequency, cost_per_lead, video_metrics_contract, video_plays, video_continuous_2s_views, video_p25_watched, video_p100_watched, video_thru_plays, early_view_source')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('ad_id', adRow.id as string)
    .eq('entity_level', 'ad')
    .gte('date_start', dateStart)
    .lte('date_stop', dateEnd)
    .order('date_start', { ascending: true })

  if (error) return apiErrorResponse('GET /api/ads/trend', 'AD_TREND_READ_FAILED', error, 500)

  const points = (rows ?? []).map((r) => {
    const impressions = Number(r.impressions ?? 0)
    const clicks = Number(r.clicks ?? 0)
    // Legacy rows (no `video_metrics_contract`) held p25 in video_views and derived hook/hold from that
    // invalid proxy. They are marked so the chart can exclude or label them; their video series is
    // NULL rather than a recomputed guess.
    const trustworthy = r.video_metrics_contract === 'rev_i'
    const video = trustworthy
      ? computeVideoMetrics({
          impressions,
          videoPlays: r.video_plays != null ? Number(r.video_plays) : null,
          continuous2sViews: r.video_continuous_2s_views != null ? Number(r.video_continuous_2s_views) : null,
          p25: r.video_p25_watched != null ? Number(r.video_p25_watched) : null,
          p50: null, p75: null,
          p100: r.video_p100_watched != null ? Number(r.video_p100_watched) : null,
          thruplays: r.video_thru_plays != null ? Number(r.video_thru_plays) : null,
          avgWatchSeconds: null,
          durationSeconds: null,
        })
      : null
    return {
      date: r.date_start as string,
      spend: Number(r.spend ?? 0),
      impressions,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null, // true % from raw counts
      frequency: r.frequency != null ? Number(r.frequency) : null,
      /** Video metrics are only present on contract-bearing rows. */
      video_contract: trustworthy ? 'rev_i' : null,
      early_view_rate: video?.earlyView.value ?? null,
      early_view_source: trustworthy ? (r.early_view_source ?? 'unavailable') : null,
      retention_p25_rate: video?.retentionP25.value ?? null,
      completion_rate: video?.completion.value ?? null,
      thruplay_rate: video?.thruplayRate.value ?? null,
      retention_denominator: video ? (video.retentionDenominatorIsImpressions ? 'impressions' : 'video_starts') : null,
      cpl: r.cost_per_lead != null ? Number(r.cost_per_lead) : null,
    }
  })

  const excluded = points.filter((p) => p.video_contract === null).length
  return Response.json({
    points,
    video_series_note:
      excluded > 0
        ? `${excluded} of ${points.length} day(s) predate the truthful video contract — their video metrics are unavailable, NOT zero, and must be excluded from or labelled in any trend.`
        : null,
  })
}
