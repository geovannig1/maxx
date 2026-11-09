'use client'

import { cn } from '@/lib/utils'
import { computePacing, type PacingStatus } from '@/lib/insights/pacing'
import { formatMoney } from '@/lib/utils/format-currency'

const STATUS_COLOR: Record<PacingStatus, string> = {
  under: 'var(--warning)',
  on: 'var(--success)',
  over: 'var(--danger)',
  none: 'var(--text-tertiary)',
}

const STATUS_LABEL: Record<PacingStatus, string> = {
  under: 'Under',
  on: 'On pace',
  over: 'Over',
  none: '—',
}

/** Compact pace pill for a table cell: "62% Under" coloured by status. */
export function PaceCell({ spend, dailyBudget, days, daysDelivering }: { spend: number; dailyBudget: number | null | undefined; days: number; daysDelivering?: number | null }) {
  const p = computePacing(spend, dailyBudget, days, daysDelivering)
  if (p.status === 'none') return <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>—</span>
  const color = STATUS_COLOR[p.status]
  return (
    <span className="inline-flex items-center gap-1.5 text-sm tabular-nums font-medium" style={{ color }} title={`Spent ${formatMoney(spend, { maximumFractionDigits: 0 })} of ~${formatMoney(p.expected, { maximumFractionDigits: 0 })} expected (budget × days)`}>
      {p.pct.toFixed(0)}%
      <span className="text-[10px] font-medium" style={{ opacity: 0.8 }}>{STATUS_LABEL[p.status]}</span>
    </span>
  )
}

/** Fuller pacing bar for the detail panel. */
export function PaceBar({ spend, dailyBudget, days, daysDelivering }: { spend: number; dailyBudget: number | null | undefined; days: number; daysDelivering?: number | null }) {
  const p = computePacing(spend, dailyBudget, days, daysDelivering)
  if (p.status === 'none') {
    return <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No ad-set daily budget set — budget may live at the campaign level (CBO).</p>
  }
  const color = STATUS_COLOR[p.status]
  const barPct = Math.min(p.pct, 100)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: 'var(--text-secondary)' }}>${spend.toFixed(0)} of ~${p.expected.toFixed(0)} expected</span>
        <span style={{ color }}>{p.pct.toFixed(0)}% · {STATUS_LABEL[p.status]}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
        <div className={cn('h-full rounded-full transition-all')} style={{ width: `${barPct}%`, background: color }} />
      </div>
      <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Expected = daily budget × {days} day{days !== 1 ? 's' : ''} in range.</p>
    </div>
  )
}
