'use client'

import { Scale } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import type { SpendIntegrityResult, PlaneConflictResult, BilledContextResult } from '@/lib/diagnostics/reconcile'
import { outcomeNoun } from '@/config/outcome-nouns'
import { formatMoney } from '@/lib/utils/format-currency'

const STATUS_COLOR: Record<string, string> = {
  aligned: 'var(--success)', minor_drift: 'var(--warning)', mismatch: 'var(--trust-low)',
  meta_over: 'var(--warning)', meta_under: 'var(--trust-low)', unknown: 'var(--text-tertiary)',
}

// Human-readable pill labels — the raw status tokens (meta_over, minor_drift, …) are internal enum
// values, never shown to the user bare.
const STATUS_LABEL: Record<string, string> = {
  aligned: 'Aligned', minor_drift: 'Minor drift', mismatch: 'Mismatch',
  meta_over: 'Meta counted more', meta_under: 'Meta counted fewer', unknown: 'Unknown',
}
const statusLabel = (s: string) => STATUS_LABEL[s] ?? s.replace(/_/g, ' ')

function money(n: number | null): string {
  return n == null ? '—' : formatMoney(n, { maximumFractionDigits: 0 })
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span className="inline-flex items-center rounded-full text-[11px] font-semibold" style={{ height: 20, padding: '0 8px', background: `${color}1f`, border: `1px solid ${color}`, color }}>
      {text}
    </span>
  )
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="text-[13px] tabular-nums text-right" style={{ color: 'var(--text-primary)' }}>
        {value}{sub && <span className="text-[11px] ml-1" style={{ color: 'var(--text-tertiary)' }}>{sub}</span>}
      </span>
    </div>
  )
}

export function ReconciliationSection({ integrity, money: m, billed, attributionLabel }: {
  integrity: SpendIntegrityResult
  money: PlaneConflictResult
  billed: BilledContextResult
  attributionLabel: string
}) {
  // Pre-live / no-delivery zero-state: nothing has spent, GA has no paid-channel telemetry, and there's no
  // lifetime billing either — so the three cards would be a wall of "$0 / — / —" null rows. Show an
  // honest "nothing to reconcile yet" instead.
  const nothingToReconcile = integrity.windowSpend < 1 && !m.available && (billed.lifetimeBilled == null || billed.lifetimeBilled < 1)
  if (nothingToReconcile) {
    return (
      <div className="card-base">
        <EmptyState
          icon={Scale}
          tone="info"
          title="Nothing to reconcile yet"
          description="This compares Meta's reported numbers against GA4 once ads deliver."
        />
      </div>
    )
  }

  return (
    <div className="grid gap-3 md:grid-cols-3">
      {/* Spend integrity */}
      <div className="card-base p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Spend integrity</h3>
          <Pill text={statusLabel(integrity.status)} color={STATUS_COLOR[integrity.status]} />
        </div>
        <Row label="Account insights" value={money(integrity.windowSpend)} />
        <Row label="Rolled-up report" value={money(integrity.reportSpend)} sub={integrity.reportVariancePct != null ? `${integrity.reportVariancePct.toFixed(1)}%` : undefined} />
        <Row label="Total across campaigns" value={money(integrity.campaignSpend)} sub={integrity.campaignVariancePct != null ? `${integrity.campaignVariancePct.toFixed(1)}%` : undefined} />
        <p className="text-[11px] pt-1" style={{ color: 'var(--text-tertiary)' }}>{integrity.note}</p>
      </div>

      {/* Plane conflict: two ESTIMATES, neither of them money */}
      <div className="card-base p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Plane conflict <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>(Meta modelled vs GA telemetry — neither is business truth)</span></h3>
          <Pill text={statusLabel(m.direction)} color={STATUS_COLOR[m.direction] ?? STATUS_COLOR.unknown} />
        </div>
        <Row label="Meta paid estimate" value={money(m.metaEstimatedValue)} />
        <Row label="GA paid event value (telemetry)" value={money(m.ga4PaidEventValue)} sub={m.variancePct != null ? `${m.variancePct > 0 ? '+' : ''}${m.variancePct.toFixed(0)}%` : undefined} />
        {m.ga4OrganicEventValue != null && <Row label="GA4 organic (context)" value={money(m.ga4OrganicEventValue)} />}
        <Row label="Per-campaign UTM coverage" value={m.attributionCoverage != null ? `${(m.attributionCoverage * 100).toFixed(0)}%` : '—'} />
        <p className="text-[11px] pt-1" style={{ color: 'var(--text-tertiary)' }}>{m.note}</p>
      </div>

      {/* Billed context */}
      <div className="card-base p-4 space-y-2">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Billed (lifetime)</h3>
        <Row label="Meta billed" value={money(billed.lifetimeBilled)} />
        <Row label="Tracked insights" value={money(billed.lifetimeTracked)} />
        <Row label="Coverage" value={billed.coveragePct != null ? `${billed.coveragePct.toFixed(0)}%` : '—'} />
        <Row label="Spend cap" value={billed.spendCap != null ? money(billed.spendCap) : 'none'} />
        <p className="text-[11px] pt-1" style={{ color: 'var(--text-tertiary)' }}>{billed.note}</p>
      </div>

      <p className="md:col-span-3 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        Meta conversion figures use <strong style={{ color: 'var(--text-secondary)' }}>{attributionLabel}</strong> modelled attribution. The outcome ledger is the business record; GA4 is session-channel confirmation telemetry. Neither attribution plane proves causality or paid value without the exact {outcomeNoun({ plural: false })}-id join.
      </p>
    </div>
  )
}
