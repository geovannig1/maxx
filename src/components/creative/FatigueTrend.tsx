'use client'

import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend } from 'recharts'
import { format, parseISO } from 'date-fns'

export interface TrendPoint {
  date: string
  spend: number
  impressions: number
  ctr: number | null
  frequency: number | null
  /** hold_rate is RETIRED (it was thruplays/p25 and could exceed 100%). */
  early_view_rate: number | null
  retention_p25_rate: number | null
  completion_rate: number | null
  /** null on days that predate the truthful video contract — excluded from the series. */
  video_contract: string | null
  cpl: number | null
}

function fmtDate(d: string): string {
  try { return format(parseISO(d), 'MMM d') } catch { return d }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function TrendTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-hover)', borderRadius: 7, color: 'var(--text-primary)', padding: '8px 12px' }}>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>{fmtDate(label)}</p>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ fontSize: 12, color: p.color }}>
          {p.name}: {p.value === null ? '—' : p.dataKey === 'frequency' ? p.value.toFixed(2) : `${p.value.toFixed(1)}%`}
        </p>
      ))}
    </div>
  )
}

/**
 * Fatigue over time — frequency climbing while hold rate slips is the canonical "this creative is
 * burning out" signal. Two axes: frequency (left) and hold rate % (right).
 */
export function FatigueTrend({ points }: { points: TrendPoint[] }) {
  // Days without the rev_i contract held p25-derived values; they are EXCLUDED, not plotted as 0.
  const contractPoints = points.filter((p) => p.video_contract === 'rev_i')
  const excludedDays = points.length - contractPoints.length
  const usable = contractPoints.filter((p) => p.frequency !== null || p.retention_p25_rate !== null)
  if (usable.length < 2) {
    return (
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        Not enough daily history to plot a fatigue trend yet (needs at least two days in range).
        {excludedDays > 0 && ` ${excludedDays} day(s) predate the truthful video contract and are excluded — their video metrics are unavailable, not zero.`}
      </p>
    )
  }

  return (
    <div style={{ height: 170 }}>
      {excludedDays > 0 && (
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {excludedDays} day(s) predate the truthful video contract and are excluded — their video
          metrics are unavailable, not zero.
        </p>
      )}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }} axisLine={false} tickLine={false} dy={6} />
          <YAxis yAxisId="freq" tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
          <YAxis yAxisId="hold" orientation="right" tickFormatter={(v) => `${v}%`} tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }} axisLine={false} tickLine={false} width={34} />
          <Tooltip content={<TrendTooltip />} cursor={{ stroke: 'var(--accent)', strokeWidth: 1, strokeDasharray: '4 4' }} />
          <Legend wrapperStyle={{ fontSize: 10, color: 'var(--text-secondary)' }} iconType="plainline" />
          <Line yAxisId="freq" type="monotone" dataKey="frequency" name="Frequency" stroke="var(--warning)" strokeWidth={2} dot={false} connectNulls />
          <Line yAxisId="hold" type="monotone" dataKey="retention_p25_rate" name="Retention 25% (of video LENGTH)" stroke="var(--success)" strokeWidth={2} dot={false} connectNulls />
          <Line yAxisId="hold" type="monotone" dataKey="completion_rate" name="Completion %" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
