import 'server-only'
import { roundMoney } from '@/lib/utils/format-currency'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday, nyDaysAgo } from '@/lib/utils/date-utils'
import { requireCapability } from '@/lib/platforms/registry'
import { loadAccountPlatform } from '@/lib/platforms/account-platform'
import { metaOutcomeEventName } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

export interface TrackingHealthResult {
  pixel_id: string
  pixel_name: string | null
  last_fired_iso: string | null
  last_fired_hours_ago: number | null
  is_firing: boolean
  browser_pixel_status: 'healthy' | 'critical' | 'unavailable' | 'unverified'
  dataset_capi_status: 'healthy' | 'warning' | 'critical' | 'unverified'
  outcome_events_last_7d: number
  outcome_events_prev_7d: number
  volume_drop_pct: number | null // negative = drop
  delivery_last_7d: number // ad spend in the last 7d; 0 = dormant (nothing to judge the pixel against)
  status: 'healthy' | 'warning' | 'critical' | 'unverified'
  dormant: boolean // true when there was no ad delivery in the window
  issues: string[]
}

export interface TrackingHealthSignals {
  isFiring: boolean
  outcomeEventsLast7: number
  outcomeEventsPrev7: number
  deliveryLast7: number // ad spend in the window; <= 0 means dormant
  volumeDropPct: number | null
  /** Whether the pixel is firing the configured outcome event SITE-WIDE (from pixel event_stats), independent of
   *  ad attribution. true = pixel alive; false = event absent site-wide; null = unknown. */
  pixelFiringSiteWide?: boolean | null
  /** Browser Pixel status read from Meta's pixel endpoint. This is separate from dataset/CAPI health. */
  pixelBrowserHealthUnavailable?: string | null
}

// PURE decision (audit Bug 1). On a DORMANT account (no ad delivery in the window), zero
// outcome events proves nothing about the pixel — there was simply no traffic — so it is
// UNVERIFIED, never "broken". The broken-pixel signals only apply once ads are actually delivering.
export function evaluateTrackingHealth(
  s: TrackingHealthSignals,
): { status: TrackingHealthResult['status']; issues: string[]; dormant: boolean } {
  // The configured Meta outcome event, AppointmentConfirmed unless NEXT_PUBLIC_META_OUTCOME_EVENT says otherwise.
  const event = metaOutcomeEventName()
  if (s.deliveryLast7 <= 0) {
    return {
      status: 'unverified',
      dormant: true,
      issues: [
        `Conversion tracking is UNVERIFIED (not broken) — there was no ad delivery in the last 7 days (no spend), so zero ${event} events is expected and says nothing about the pixel. Re-check once ads deliver, or test the pixel manually on the ${OW.one} confirmation page.`,
      ],
    }
  }
  const issues: string[] = []
  if (s.pixelBrowserHealthUnavailable) {
    issues.push(`Meta Pixel browser health is unavailable — ${s.pixelBrowserHealthUnavailable}. Warehouse ${OW.many} can prove business activity, but they do not prove the browser Pixel is firing.`)
    return { status: 'unverified', issues, dormant: false }
  } else if (s.isFiring === false) {
    issues.push('Pixel has not fired in over 24 hours despite active ad delivery — check pixel status.')
  }
  // Zero outcome events ATTRIBUTED to campaigns, with delivery > 0. This is only a broken-pixel
  // signal when the pixel isn't firing site-wide either. If it IS firing site-wide (pixelFiringSiteWide),
  // then ~0 attributed conversions is an ads-not-converting / attribution situation (rare event, cold
  // paid traffic) — a PERFORMANCE question, not a pixel to re-check. Mis-framing it as pixel-broken sent
  // the owner chasing a working pixel; route it to the performance diagnosis instead.
  let attributedZeroIsPerf = false
  if (s.outcomeEventsLast7 === 0) {
    if (s.pixelFiringSiteWide === true) {
      attributedZeroIsPerf = true
      issues.push(`Ads are delivering and the pixel IS firing site-wide, yet ~0 ${event} are ATTRIBUTED to campaigns. The site-wide firing is evidence the pixel itself is installed and working; what is unresolved is whether the ads are converting at all or the conversions are not being attributed. Diagnose performance (diagnose_ad_performance) before re-checking the pixel.`)
    } else {
      issues.push(`No ${event} events in the last 7 days despite active ad delivery — check the pixel on the confirmation page.`)
    }
  } else if (s.volumeDropPct !== null && s.volumeDropPct < -50) {
    issues.push(`${event} volume dropped ${Math.abs(Math.round(s.volumeDropPct))}% vs the prior week — check for pixel breakage.`)
  }
  // Critical only for a genuine pixel failure — never for the ads-not-converting (attribution) case.
  const critical = s.isFiring === false || (s.outcomeEventsLast7 === 0 && !attributedZeroIsPerf)
  const status: TrackingHealthResult['status'] = issues.length === 0 ? 'healthy' : critical ? 'critical' : 'warning'
  return { status, issues, dormant: false }
}

/** PURE. Whether pixel event stats show the configured outcome event firing site-wide (any source):
 *  true = fired, false = absent or zero, null = no stats to read. */
export function pixelFiresOutcomeEvent(
  eventStats: ReadonlyArray<{ event_name?: string; count?: number | string | null }> | undefined | null,
  eventName: string = metaOutcomeEventName(),
): boolean | null {
  if (!Array.isArray(eventStats)) return null
  const stat = eventStats.find((e) => e.event_name === eventName)
  return stat ? Number(stat.count ?? 0) > 0 : false
}

function browserPixelStatus(input: {
  unavailable: string | null
  isFiring: boolean
}): TrackingHealthResult['browser_pixel_status'] {
  if (input.unavailable) return 'unavailable'
  return input.isFiring ? 'healthy' : 'critical'
}

function datasetCapiStatus(input: {
  browserUnavailable: string | null
  outcomeEventsLast7: number
  deliveryLast7: number
  pixelFiringSiteWide: boolean | null
}): TrackingHealthResult['dataset_capi_status'] {
  if (input.browserUnavailable) return 'unverified'
  if (input.deliveryLast7 <= 0) return 'unverified'
  if (input.outcomeEventsLast7 > 0) return 'healthy'
  return input.pixelFiringSiteWide === true ? 'warning' : 'critical'
}

interface MetaPixelResponse {
  id?: string
  name?: string
  last_fired_time?: string
  event_stats?: Array<{
    event_name: string
    count?: number
  }>
  error?: {
    message: string
    code: number
  }
}

interface AlertInsert {
  ad_account_id: string
  alert_date: string
  entity_level: 'campaign' | 'ad'
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  alert_type: string
  severity: string
  title: string
  message: string
  metric_name: string
  metric_value: number | null
  threshold_value: number | null
  baseline_value: number | null
  is_resolved: boolean
  why_it_matters: string | null
  recommended_actions: string[] | null
  amount_at_risk: number | null
  action_label: string | null
  action_url: string | null
}

export async function checkTrackingHealth(
  adAccountDbId: string
): Promise<TrackingHealthResult> {
  const supabase = getAdminClient()
  const today = nyToday()

  // Default result to return on catastrophic failure
  const defaultResult: TrackingHealthResult = {
    pixel_id: '',
    pixel_name: null,
    last_fired_iso: null,
    last_fired_hours_ago: null,
    is_firing: false,
    browser_pixel_status: 'unverified',
    dataset_capi_status: 'unverified',
    outcome_events_last_7d: 0,
    outcome_events_prev_7d: 0,
    volume_drop_pct: null,
    delivery_last_7d: 0,
    status: 'critical',
    dormant: false,
    issues: ['Could not check tracking health — configuration error'],
  }

  try {
    // 1. Resolve pixel ID — env var takes priority, then DB
    let pixelId = process.env.META_PIXEL_ID ?? null

    if (!pixelId) {
      const { data: account } = await supabase
        .from('ad_accounts')
        .select('pixel_id')
        .eq('id', adAccountDbId)
        .maybeSingle()

      pixelId = (account?.pixel_id as string | null | undefined) ?? null
    }

    if (!pixelId) {
      const result: TrackingHealthResult = {
        ...defaultResult,
        issues: ['No pixel ID configured — set META_PIXEL_ID env var or run a sync to populate ad_accounts.pixel_id'],
      }
      return result
    }

    const accessToken = process.env.META_ACCESS_TOKEN?.trim()
    if (!accessToken) {
      return {
        ...defaultResult,
        pixel_id: pixelId,
        issues: ['META_ACCESS_TOKEN not configured — Meta pixel health is unavailable'],
      }
    }

    // 2. Call Meta API for pixel info
    let pixelName: string | null = null
    let lastFiredIso: string | null = null
    let lastFiredHoursAgo: number | null = null
    let isFiring = true
    // Is the pixel firing the configured outcome event SITE-WIDE (any source), from event_stats? Distinguishes a
    // genuinely broken pixel from "ads deliver but ~0 conversions attributed". null = couldn't tell.
    let pixelFiringSiteWide: boolean | null = null
    let pixelBrowserHealthUnavailable: string | null = null

    try {
      const pixelJson = (await requireCapability(await loadAccountPlatform(supabase, adAccountDbId), 'trackingHealth').fetchPixelStatus(pixelId)) as MetaPixelResponse
      if (!pixelJson || typeof pixelJson !== 'object') {
        throw new Error('Meta pixel endpoint returned a malformed response')
      }

      if (pixelJson.error) {
        console.warn(`[TrackingHealth] Meta pixel API error: ${pixelJson.error.message}`)
        pixelBrowserHealthUnavailable = pixelJson.error.message
        isFiring = false
      } else {
        pixelName = pixelJson.name ?? null
        lastFiredIso = pixelJson.last_fired_time ?? null

        // Site-wide firing of the booking event, from event_stats (independent of ad attribution).
        pixelFiringSiteWide = pixelFiresOutcomeEvent(pixelJson.event_stats)

        if (lastFiredIso) {
          const lastFiredDate = new Date(lastFiredIso)
          const now = new Date()
          lastFiredHoursAgo = (now.getTime() - lastFiredDate.getTime()) / (1000 * 60 * 60)

          if (lastFiredHoursAgo > 24) {
            isFiring = false
          }
        } else {
          // No last_fired_time at all — treat as not firing
          isFiring = false
        }
      }
    } catch (apiErr) {
      const message = apiErr instanceof Error ? apiErr.message : String(apiErr)
      console.warn('[TrackingHealth] Meta pixel API call failed:', message)
      pixelBrowserHealthUnavailable = message
      isFiring = false
    }

    // 3. Query daily_insights for the configured outcome event (bookings column) last 7d vs prev 7d
    const last7StartStr = nyDaysAgo(7)
    const prev7StartStr = nyDaysAgo(14)
    // last 7: [last7Start, today)
    // prev 7: [prev7Start, last7Start)

    const [last7Res, prev7Res] = await Promise.all([
      supabase
        .from('daily_insights')
        .select('bookings, spend')
        .eq('ad_account_id', adAccountDbId)
        .eq('entity_level', 'campaign')
        .gte('date_start', last7StartStr)
        .lt('date_start', today),
      supabase
        .from('daily_insights')
        .select('bookings')
        .eq('ad_account_id', adAccountDbId)
        .eq('entity_level', 'campaign')
        .gte('date_start', prev7StartStr)
        .lt('date_start', last7StartStr),
    ])

    const outcomeEventsLast7 = (last7Res.data ?? []).reduce(
      (s, r) => s + Number(r.bookings ?? 0),
      0
    )
    const outcomeEventsPrev7 = (prev7Res.data ?? []).reduce(
      (s, r) => s + Number(r.bookings ?? 0),
      0
    )

    // 4. Calculate volume drop
    let volumeDropPct: number | null = null
    if (outcomeEventsPrev7 > 0) {
      volumeDropPct = ((outcomeEventsLast7 - outcomeEventsPrev7) / outcomeEventsPrev7) * 100
    }

    // 5-6. Evaluate — a DORMANT account (no ad delivery in the window) is UNVERIFIED, not broken (Bug 1).
    const deliveryLast7 = (last7Res.data ?? []).reduce(
      (s, r) => s + Number((r as { spend?: number | null }).spend ?? 0),
      0
    )
    const evalResult = evaluateTrackingHealth({
      isFiring,
      outcomeEventsLast7,
      outcomeEventsPrev7,
      deliveryLast7,
      volumeDropPct,
      pixelFiringSiteWide,
      pixelBrowserHealthUnavailable,
    })

    const result: TrackingHealthResult = {
      pixel_id: pixelId,
      pixel_name: pixelName,
      last_fired_iso: lastFiredIso,
      last_fired_hours_ago: lastFiredHoursAgo !== null ? Math.round(lastFiredHoursAgo * 10) / 10 : null,
      is_firing: isFiring,
      browser_pixel_status: browserPixelStatus({
        unavailable: pixelBrowserHealthUnavailable,
        isFiring,
      }),
      dataset_capi_status: datasetCapiStatus({
        browserUnavailable: pixelBrowserHealthUnavailable,
        outcomeEventsLast7,
        deliveryLast7,
        pixelFiringSiteWide,
      }),
      outcome_events_last_7d: outcomeEventsLast7,
      outcome_events_prev_7d: outcomeEventsPrev7,
      volume_drop_pct: volumeDropPct !== null ? Math.round(volumeDropPct * 10) / 10 : null,
      delivery_last_7d: roundMoney(deliveryLast7),
      status: evalResult.status,
      dormant: evalResult.dormant,
      issues: evalResult.issues,
    }

    // 7. Store result in app_settings
    await supabase
      .from('app_settings')
      .upsert(
        {
          ad_account_id: adAccountDbId,
          key: 'tracking_health',
          value: JSON.stringify(result),
          setting_type: 'json',
          label: 'Tracking Health',
          description: 'Latest pixel and conversion tracking health check result',
        },
        { onConflict: 'ad_account_id,key' }
      )

    // 8. Insert alerts only for REAL issues — never for pure dormancy (Bug 1: no false pixel-broken alert).
    if (result.issues.length > 0 && !result.dormant && result.status !== 'unverified') {
      const alerts: AlertInsert[] = result.issues.map((issue) => ({
        ad_account_id: adAccountDbId,
        alert_date: today,
        entity_level: 'campaign',
        campaign_id: null,
        adset_id: null,
        ad_id: null,
        meta_campaign_id: null,
        meta_adset_id: null,
        meta_ad_id: null,
        alert_type: 'pixel_health',
        severity: result.status,
        title: result.status === 'critical' ? 'Pixel tracking critical issue detected' : 'Pixel tracking warning',
        message: issue,
        metric_name: 'appointment_confirmed',
        metric_value: outcomeEventsLast7,
        threshold_value: null,
        baseline_value: outcomeEventsPrev7 > 0 ? outcomeEventsPrev7 : null,
        is_resolved: false,
        why_it_matters: result.status === 'critical'
          ? 'Without a working pixel, Meta cannot optimize for conversions. You will be paying for clicks without the algorithm learning what a good conversion looks like, causing CPA to rise and ROAS to collapse.'
          : `A significant drop in ${metaOutcomeEventName()} events can indicate pixel drift, a broken ${OW.one} flow, or a code deployment that removed the tracking snippet.`,
        recommended_actions: [
          'Open Meta Events Manager and check the pixel status and recent events',
          `Test the pixel by going through the actual ${OW.one} flow end-to-end`,
          `Check if a recent code deployment changed the ${OW.one} confirmation page`,
          'Use Meta Pixel Helper browser extension to verify the event fires on the confirmation page',
        ],
        amount_at_risk: null,
        action_label: 'Open Events Manager',
        action_url: `https://business.facebook.com/events_manager2/list/pixel/${pixelId}/overview`,
      }))

      const { error: alertErr } = await supabase.from('alerts').insert(alerts)
      if (alertErr) {
        console.error('[TrackingHealth] Alert insert error:', alertErr.message)
      }
    }

    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[TrackingHealth] Fatal error:', message)
    return {
      ...defaultResult,
      issues: [`Tracking health check failed: ${message}`],
    }
  }
}
