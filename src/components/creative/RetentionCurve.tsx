'use client'

import { AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts'

export interface RetentionCurveProps {
  impressions: number
  p25: number
  /** Video STARTS when Meta returned a count; null otherwise. Never p25. */
  videoPlays?: number | null
  /** Which real Meta field the early-view rate came from, or 'unavailable'. */
  earlyViewSource?: 'video_play_actions' | 'video_continuous_2_sec' | 'unavailable' | null
  p50: number
  p75: number
  p100: number
  thruplays: number
  avgPlayTime: number | null
  hookRate: number | null
  holdRate: number | null
  thruplayRate: number | null
}

function pct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)}%`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CurveTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hover)', borderRadius: 7, color: 'var(--text-primary)', padding: '8px 12px' }}>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 3 }}>Watched {p.stage}</p>
      <p style={{ fontSize: 13, fontWeight: 600 }}>{p.pct.toFixed(1)}% of 25%-viewers</p>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{p.count.toLocaleString()} views</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}>
      <p className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</p>
      <p className="text-sm font-bold tabular-nums mt-0.5" style={{ color: 'var(--text-primary)' }}>{value}</p>
    </div>
  )
}

/**
 * Video retention among engaged viewers. The line is anchored at the 25% quartile (= 100% of
 * 25%-viewers). Meta's batch insights expose NO 3s-play count, and `video_3s_views`
 * p25 is a RETENTION MILESTONE (25% of video LENGTH), never a hook. Impression-anchored rates
 * nothing is implied beyond what's captured.
 */
export function RetentionCurve(props: RetentionCurveProps) {
  const { impressions, p25, p50, p75, p100, avgPlayTime, hookRate, thruplayRate } = props
  const earlyViewSource = props.earlyViewSource ?? 'unavailable'
  // Retention is share of STARTS when a start count exists; impressions otherwise. The denominator
  // is NAMED below so it matches aggregateMetrics exactly rather than being implied.
  const retentionDenominator = props.videoPlays && props.videoPlays > 0 ? props.videoPlays : impressions
  const retentionBasis = props.videoPlays && props.videoPlays > 0 ? 'video starts' : 'impressions'
  const retention25 = retentionDenominator > 0 ? (p25 / retentionDenominator) * 100 : null

  if (!p25 || p25 === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        No video retention data for this creative (it may be an image ad, or video metrics haven&apos;t synced).
      </p>
    )
  }

  const rel = (v: number) => (p25 > 0 ? (v / p25) * 100 : 0)
  const data = [
    { stage: '25%', pct: 100, count: p25 },
    { stage: '50%', pct: rel(p50), count: p50 },
    { stage: '75%', pct: rel(p75), count: p75 },
    { stage: '100%', pct: rel(p100), count: p100 },
  ]
  // Completion is share of STARTS when a start count exists; impressions otherwise, and the
  // denominator is stated rather than assumed.
  const completionDenominator = props.videoPlays && props.videoPlays > 0 ? props.videoPlays : impressions
  const completion = completionDenominator > 0 ? (p100 / completionDenominator) * 100 : null
  const completionBasis = props.videoPlays && props.videoPlays > 0 ? 'video starts' : 'impressions'

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        {/* The label claimed p25 was a 3-second hook, which it is not, and printed
            the RETIRED Hold metric (thruplays/p25, able to exceed 100%). Early view is shown with
            its REAL source, or "unavailable" when Meta returned no early-view field. */}
        <Stat
          label={earlyViewSource === 'video_play_actions' ? 'Early view (video starts)'
               : earlyViewSource === 'video_continuous_2_sec' ? 'Early view (continuous 2s)'
               : 'Early view'}
          value={hookRate !== null ? pct(hookRate) : 'unavailable'}
        />
        <Stat label="Retention 25% (of length)" value={pct(retention25)} />
        <Stat label="ThruPlay" value={pct(thruplayRate)} />
        <Stat label="Avg watch" value={avgPlayTime === null ? '—' : `${avgPlayTime.toFixed(1)}s`} />
      </div>

      <div style={{ height: 150 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="retentionGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--success)" stopOpacity={0.28} />
                <stop offset="95%" stopColor="var(--success)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="stage" tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} axisLine={false} tickLine={false} dy={6} />
            <YAxis tickFormatter={(v) => `${v}%`} domain={[0, 100]} tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }} axisLine={false} tickLine={false} width={38} />
            <Tooltip content={<CurveTooltip />} cursor={{ stroke: 'var(--success)', strokeWidth: 1, strokeDasharray: '4 4' }} />
            <Area type="monotone" dataKey="pct" stroke="var(--success)" strokeWidth={2} fill="url(#retentionGradient)" dot={{ r: 3, fill: 'var(--success)', stroke: 'var(--bg-surface)', strokeWidth: 1.5 }} activeDot={{ r: 4 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
        Milestones are % of the video&apos;s LENGTH, shown relative to the 25% milestone. {completion !== null && `${completion.toFixed(2)}% of ${completionBasis} reached 100%. `}
        Curve anchors at the 25% milestone. Meta&apos;s batch insights report no three-second play, so
        p25 is NOT a hook — it is the share reaching 25% of the video&apos;s LENGTH. Milestone and
        completion rates below are over {retentionBasis}.
      </p>
    </div>
  )
}
