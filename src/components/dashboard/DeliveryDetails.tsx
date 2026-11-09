import { KpiCard } from '@/components/dashboard/KpiCard'
import { DaypartCard } from '@/components/dashboard/DaypartCard'
import { EmptyState } from '@/components/ui/empty-state'
import { Clock } from 'lucide-react'
import { computeDelta, type DeltaResult } from '@/lib/insights/compare'
import type { EntityMetrics } from '@/lib/metrics/aggregate'
import type { Ga4TrafficBucket, TrafficSource } from '@/lib/ga4/client'
import { outcomeNoun } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

// Tier 6 of Today — the collapsed "Delivery & traffic details" zone (owner decision: nothing lost, just
// folded). Engagement (8), Creative video (6), GA4 Traffic (6), and the Daypart heatmap — logic and
// labels unchanged from when they sat at the same weight as money; only relocated inside a server-rendered
// <details>. Presentational, server-rendered (no JS needed for the disclosure).

export function DeliveryDetails({
  showMeta,
  cmpLabel,
  dateLabel,
  source,
  sourceLabel,
  accountMetrics,
  accountMetricsPrev,
  accountDaily,
  trafficBucket,
  trafficBucketPrev,
  daypartCount,
}: {
  showMeta: boolean
  cmpLabel: string
  dateLabel: string
  source: TrafficSource
  sourceLabel: string
  accountMetrics: EntityMetrics
  accountMetricsPrev: EntityMetrics
  accountDaily: EntityMetrics[]
  trafficBucket: Ga4TrafficBucket | null
  trafficBucketPrev: Ga4TrafficBucket | null
  daypartCount: number
}) {
  // Sparkline series (one value per day across the selected window) for any account metric.
  const sparkFor = (key: keyof EntityMetrics): number[] => accountDaily.map((m) => Number(m[key] ?? 0))
  // Per-KPI period-over-period delta against the prior window.
  const accDelta = (key: keyof EntityMetrics, lowerIsBetter = false): DeltaResult | undefined =>
    computeDelta(accountMetrics[key] as number | null, accountMetricsPrev[key] as number | null, lowerIsBetter)
  // 100% completion rate (% of video views reaching the end) — derived, not a stored field.
  // video_views is video STARTS and may be NULL (Meta returned no count) — unavailable, never 0.
  const completionOf = (m: EntityMetrics): number | null =>
    m.video_views !== null && m.video_views > 0 ? (m.p100 / m.video_views) * 100 : null
  const completionRate = completionOf(accountMetrics)
  const completionSpark = accountDaily.map((m) => completionOf(m) ?? 0)
  const singleDailyPoint = accountDaily.length === 1
  const dailyFrequency = singleDailyPoint ? accountMetrics.frequency : null

  return (
    <details className="rounded-lg" style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', boxShadow: 'var(--shadow-card)' }}>
      <summary className="section-label cursor-pointer" style={{ padding: '14px 20px' }}>Delivery &amp; traffic details</summary>
      <div className="px-5 pb-5 space-y-6" style={{ borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
        {showMeta && (<>
        {/* Engagement (Meta) — captured in daily_insights, surfaced with period-over-period + sparklines. */}
        <div>
          <p className="section-label mb-3">Engagement — Meta (delivery + clicks) · Δ {cmpLabel}</p>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Impressions" value={accountMetrics.impressions.toLocaleString()} delta={accDelta('impressions')} subtitle="Meta" sparkline={sparkFor('impressions')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: 'Available when account insight read succeeds' }} />
            <KpiCard label="Peak daily reach" value={accountMetrics.reach.toLocaleString()} delta={accDelta('reach')} subtitle="highest daily Meta reach" sparkline={sparkFor('reach')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Peak daily only; no native all-days rollup', availability: 'Available when account insight read succeeds' }} />
            <KpiCard label="Daily frequency" value={dailyFrequency !== null ? dailyFrequency.toFixed(2) : 'unavailable'} delta={singleDailyPoint ? accDelta('frequency', true) : undefined} subtitle={singleDailyPoint ? 'single-day Meta frequency' : 'Daily frequency unavailable for multi-day selections'} sparkline={sparkFor('frequency')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: singleDailyPoint ? 'Single day' : 'Multi-day period', availability: singleDailyPoint ? 'Available' : 'Unavailable' }} />
            <KpiCard label="Clicks" value={accountMetrics.clicks.toLocaleString()} delta={accDelta('clicks')} subtitle="all clicks" sparkline={sparkFor('clicks')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: 'Available when account insight read succeeds' }} />
            <KpiCard label="CTR" value={accountMetrics.ctr !== null ? `${accountMetrics.ctr.toFixed(2)}%` : 'Unavailable'} delta={accDelta('ctr')} subtitle="clicks ÷ impressions" sparkline={sparkFor('ctr')} evidence={{ source: 'Computed from Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: accountMetrics.ctr !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="CPC" value={accountMetrics.cpc !== null ? `${formatMoney(accountMetrics.cpc)}` : 'Unavailable'} delta={accDelta('cpc', true)} subtitle="spend ÷ clicks" sparkline={sparkFor('cpc')} evidence={{ source: 'Computed from Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: accountMetrics.cpc !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="CPM" value={accountMetrics.cpm !== null ? `${formatMoney(accountMetrics.cpm)}` : 'Unavailable'} delta={accDelta('cpm', true)} subtitle="cost / 1k impr" sparkline={sparkFor('cpm')} evidence={{ source: 'Computed from Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: accountMetrics.cpm !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="Landing page views" value={accountMetrics.landing_page_views.toLocaleString()} delta={accDelta('landing_page_views')} subtitle="Meta estimate" sparkline={sparkFor('landing_page_views')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account', availability: 'Available when account insight read succeeds' }} />
          </div>
          {accountMetrics.impressions === 0 && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)', marginTop: '6px' }}>No ad delivery in this range — these populate once ads run.</p>
          )}
        </div>

        {/* Creative / video performance. Early-view, RETENTION MILESTONES (% of video length), ThruPlay
             and average watch time are four different measurements and are never mixed. */}
        <div>
          <p className="section-label mb-3">Creative Performance — Meta video (is the creative working?) · Δ {cmpLabel}</p>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <KpiCard label="Video starts" value={accountMetrics.video_views !== null ? accountMetrics.video_views.toLocaleString() : 'unavailable'} delta={accDelta('video_views')} subtitle={accountMetrics.video_views !== null ? 'video_play_actions' : 'no start count returned'} sparkline={sparkFor('video_views')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account video actions', availability: accountMetrics.video_views !== null ? 'Available' : 'Unavailable' }} />
            {/* NOT a 3-second hook: Meta's batch insights expose no 3s field. This is video STARTS
                (or continuous-2s views) over impressions, and 'unavailable' when neither came back. */}
            <KpiCard label="Early-view rate" value={accountMetrics.hook_rate !== null ? `${accountMetrics.hook_rate.toFixed(1)}%` : 'unavailable'} delta={accDelta('hook_rate')} subtitle={accountMetrics.hook_rate !== null ? 'video starts ÷ impressions' : 'no early-view field returned'} sparkline={sparkFor('hook_rate')} evidence={{ source: 'Computed from Meta video starts/impressions', date: dateLabel, scope: 'Selected ad account video actions', availability: accountMetrics.hook_rate !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="Retention — 25%" value={accountMetrics.retention_p25_rate !== null ? `${accountMetrics.retention_p25_rate.toFixed(1)}%` : 'unavailable'} subtitle={`reached 25% of video LENGTH ÷ ${accountMetrics.retention_denominator === 'video_starts' ? 'video starts' : 'impressions'}`} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account video actions', availability: accountMetrics.retention_p25_rate !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="Avg watch time" value={accountMetrics.avg_play_time !== null ? `${accountMetrics.avg_play_time.toFixed(1)}s` : 'Unavailable'} delta={accDelta('avg_play_time')} subtitle="per video view" sparkline={sparkFor('avg_play_time')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account video actions', availability: accountMetrics.avg_play_time !== null ? 'Available' : 'Unavailable' }} />
            <KpiCard label="ThruPlays" value={accountMetrics.thruplays.toLocaleString()} delta={accDelta('thruplays')} subtitle="15s / full plays" sparkline={sparkFor('thruplays')} evidence={{ source: 'Meta daily warehouse', date: dateLabel, scope: 'Selected ad account video actions', availability: 'Available when account insight read succeeds' }} />
            <KpiCard label="100% completion" value={completionRate !== null ? `${completionRate.toFixed(1)}%` : 'Unavailable'} delta={computeDelta(completionRate, completionOf(accountMetricsPrev), false)} subtitle="reached 100% of video length" sparkline={completionSpark} evidence={{ source: 'Computed from Meta video starts/completions', date: dateLabel, scope: 'Selected ad account video actions', availability: completionRate !== null ? 'Available' : 'Unavailable' }} />
          </div>
          <p className="text-xs" style={{ color: 'var(--text-tertiary)', marginTop: '6px' }}>Per-creative breakdown (retention curve, fatigue) lives on the Ads page.</p>
        </div>
        </>)}

        {/* Traffic — GA4, SOURCE-AWARE (Complete / Paid / Organic via channel groups). Range-driven. */}
        {trafficBucket ? (
          <div>
            <p className="section-label mb-3">Traffic — GA4 ({sourceLabel}) · Δ {cmpLabel}</p>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <KpiCard label="Page views" value={trafficBucket.pageViews.toLocaleString()} delta={computeDelta(trafficBucket.pageViews, trafficBucketPrev?.pageViews ?? null, false)} subtitle="GA4 · screenPageViews" evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: 'Available' }} />
              <KpiCard label="Sessions" value={trafficBucket.sessions.toLocaleString()} delta={computeDelta(trafficBucket.sessions, trafficBucketPrev?.sessions ?? null, false)} subtitle="GA4" evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: 'Available' }} />
              <KpiCard label="Users" value={trafficBucket.users.toLocaleString()} delta={computeDelta(trafficBucket.users, trafficBucketPrev?.users ?? null, false)} subtitle={source === 'complete' ? `GA4 · ${trafficBucket.newUsers.toLocaleString()} new` : 'GA4 · summed by channel (approx)'} evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: 'Available' }} />
              <KpiCard label="Engagement rate" value={trafficBucket.engagementRate !== null ? `${(trafficBucket.engagementRate * 100).toFixed(1)}%` : 'Unavailable'} delta={computeDelta(trafficBucket.engagementRate, trafficBucketPrev?.engagementRate ?? null, false)} subtitle="GA4 engaged sessions" evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: trafficBucket.engagementRate !== null ? 'Available' : 'Unavailable' }} />
              <KpiCard label="Avg session" value={trafficBucket.avgSessionDuration !== null ? `${trafficBucket.avgSessionDuration.toFixed(0)}s` : 'Unavailable'} delta={computeDelta(trafficBucket.avgSessionDuration, trafficBucketPrev?.avgSessionDuration ?? null, false)} subtitle="GA4 duration" evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: trafficBucket.avgSessionDuration !== null ? 'Available' : 'Unavailable' }} />
              <KpiCard label="Bounce rate" value={trafficBucket.bounceRate !== null ? `${(trafficBucket.bounceRate * 100).toFixed(1)}%` : 'Unavailable'} delta={computeDelta(trafficBucket.bounceRate, trafficBucketPrev?.bounceRate ?? null, true)} subtitle="GA4" evidence={{ source: 'GA4 traffic telemetry', date: dateLabel, scope: sourceLabel, availability: trafficBucket.bounceRate !== null ? 'Available' : 'Unavailable' }} />
            </div>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)', marginTop: '6px' }}>
              {source === 'complete' ? 'GA is the traffic-session record across all channels; the outcome source remains the business-outcome ledger.' : source === 'paid' ? `Sessions GA classified into paid channels. This is channel telemetry, not proof an ad caused a ${outcomeNoun({ plural: false })}.` : 'Sessions GA classified outside paid channels (organic, direct, referral, email).'}
            </p>
          </div>
        ) : source !== 'complete' ? (
          <p className="text-xs" style={{ color: 'var(--warning)' }}>GA4 unavailable — can&apos;t compute the {source} traffic split.</p>
        ) : null}

        {/* Daypart heatmap (Meta paid) — hidden in the Organic view. */}
        {showMeta && (daypartCount >= 7 ? (
          <DaypartCard />
        ) : (
          <div>
            <p className="section-label" style={{ marginBottom: '8px' }}>Best Hours — Last 60 Days</p>
            <EmptyState
              icon={Clock}
              title="Not enough data yet"
              description="After 30 days of active campaigns, Maxx will identify your best-performing time windows."
            />
          </div>
        ))}
      </div>
    </details>
  )
}
