import { TrendingUp, Minus, AlertTriangle } from 'lucide-react'
import { formatMoney } from '@/lib/utils/format-currency'

interface PacingCardProps {
  recentSpend: number
  daysOfData: number
  /** Σ active ad-set (or campaign) daily budgets, synced from Meta. Absent ⇒ no pacing verdict — a
   *  silent numeric default would re-introduce a hardcoded plan whenever the caller had no budget. */
  dailyBudgetTarget?: number
  /** Provenance label for the budget target. */
  budgetNote?: string
}

export function PacingCard({ recentSpend, daysOfData, dailyBudgetTarget, budgetNote }: PacingCardProps) {
  if (dailyBudgetTarget == null || dailyBudgetTarget <= 0) {
    return (
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', height: '100%', boxShadow: '0 1px 3px rgba(16,24,40,0.08)' }}>
        <p className="section-label">Spend Pacing</p>
        <p className="text-sm mt-3" style={{ color: 'var(--text-tertiary)' }}>
          No active synced daily budget — pacing has no target to compare against. Daily avg (7d): {formatMoney(daysOfData > 0 ? recentSpend / daysOfData : 0, { maximumFractionDigits: 0 })}/day.
        </p>
      </div>
    )
  }
  const dailyAvg    = daysOfData > 0 ? recentSpend / daysOfData : 0
  const today       = new Date()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const dayOfMonth  = today.getDate()
  const daysLeft    = daysInMonth - dayOfMonth
  const projected   = dailyAvg * daysInMonth
  const budget      = dailyBudgetTarget * daysInMonth
  const pct         = budget > 0 ? (projected / budget) * 100 : 0
  const barPct      = Math.min((projected / (budget * 1.4)) * 100, 100)
  const overspend   = projected > budget

  const barColor    = pct <= 100 ? 'var(--success)' : pct <= 120 ? 'var(--warning)' : 'var(--danger)'
  const status      = pct <= 95 ? 'Under pace' : pct <= 105 ? 'On pace' : pct <= 120 ? 'Slightly over' : 'Over budget'
  const statusColor = pct <= 95 ? 'var(--success)' : pct <= 105 ? 'var(--text-secondary)' : pct <= 120 ? 'var(--warning)' : 'var(--danger)'

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', height: '100%', boxShadow: '0 1px 3px rgba(16,24,40,0.08)' }}>
      <div className="flex items-center justify-between mb-4">
        <p className="section-label">
          Spend Pacing — {today.toLocaleString('en-US', { month: 'long' })}
        </p>
        <span style={{ fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px', color: statusColor }}>
          {pct > 105 ? <AlertTriangle className="w-3.5 h-3.5" /> : pct > 95 ? <Minus className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
          {status}
        </span>
      </div>

      {/* 2×2 grid — no overflow */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px', marginBottom: '16px' }}>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Daily avg (7d)</p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {formatMoney(dailyAvg, { maximumFractionDigits: 0 })}<span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-tertiary)' }}>/day</span>
          </p>
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Projected</p>
          <p style={{ fontSize: '20px', fontWeight: 700, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: overspend ? 'var(--danger)' : 'var(--text-primary)' }}>
            {formatMoney(projected, { maximumFractionDigits: 0 })}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Monthly budget</p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
            {formatMoney(budget, { maximumFractionDigits: 0 })}
          </p>
          {budgetNote && <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px', lineHeight: 1.3 }}>{budgetNote}</p>}
        </div>
        <div>
          <p style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>Days left</p>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{daysLeft}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="space-y-1">
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${barPct}%`, background: barColor }}
          />
        </div>
        <div className="flex justify-between" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
          <span>{formatMoney(0, { maximumFractionDigits: 0 })}</span>
          <span>{formatMoney(budget, { maximumFractionDigits: 0 })} budget</span>
        </div>
      </div>
    </div>
  )
}
