'use client'

import { getMetricStatus, getTargetLanguage, type MetricKey, type EvalContext, type MetricStatus } from '@/lib/targets/target-ranges'
import { cn } from '@/lib/utils'

// A status chip that classifies a metric value against its CONFIGURABLE target range — Healthy / Watch
// / Critical / Needs-data / Estimate-only — instead of a single pass/fail number. The native tooltip
// explains *why* the status (the band + min-data + confidence), so users never have to guess.

// Status colors use the design-system status triples (CSS vars, AA on white) — never dark Tailwind
// tokens (text-emerald-300 etc.), which wash out on a light surface. Estimate-only borrows the warning/
// Meta-estimate hue since it's a provenance caveat, not a value judgment.
const STATUS_META: Record<MetricStatus, { label: string; style: React.CSSProperties }> = {
  excellent: { label: 'Excellent', style: { background: 'var(--success-bg)', color: 'var(--success)', borderColor: 'var(--success-border)' } },
  healthy: { label: 'Healthy', style: { background: 'var(--success-bg)', color: 'var(--success)', borderColor: 'var(--success-border)' } },
  watch: { label: 'Watch', style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' } },
  critical: { label: 'Critical', style: { background: 'var(--danger-bg)', color: 'var(--danger)', borderColor: 'var(--danger-border)' } },
  needs_data: { label: 'Needs data', style: { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', borderColor: 'var(--border)' } },
  estimate_only: { label: 'Estimate only', style: { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning-border)' } },
  // A money metric with no owner target: the chip asks for one instead of judging the value.
  no_target: { label: 'Set a target', style: { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', borderColor: 'var(--border)' } },
  // Tertiary, not disabled, ink: this chip carries readable text. StatusChip reuses this
  // style for provisional bands, where it renders "Ref: Excellent" — and the "—" itself
  // means "no value", which is content. Disabled ink only clears the 3:1 non-text bar.
  unknown: { label: '—', style: { background: 'var(--bg-subtle)', color: 'var(--text-tertiary)', borderColor: 'var(--border)' } },
}

/** Text color (CSS var) for a metric status — for coloring compact numbers like table pills. */
export function metricStatusColor(status: MetricStatus): string {
  switch (status) {
    case 'excellent':
    case 'healthy': return 'var(--success)'
    case 'watch': return 'var(--warning)'
    case 'critical': return 'var(--danger)'
    case 'estimate_only': return 'var(--warning)'
    default: return 'var(--text-tertiary)' // needs_data / no_target / unknown
  }
}

/** Renders a band chip from an already-known status string (e.g. a stored recommendation's
 *  target_status), without recomputing — used where the original evidence context isn't available. */
export function StatusChip({ status, title, className }: { status: string; title?: string; className?: string }) {
  const meta = STATUS_META[status as MetricStatus] ?? STATUS_META.unknown
  const provisional = title?.startsWith('PROVISIONAL diagnostic reference') === true
  return (
    <span
      title={title}
      style={provisional ? STATUS_META.unknown.style : meta.style}
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none', title ? 'cursor-help' : '', className)}
    >
      {provisional ? `Ref: ${meta.label}` : meta.label}
    </span>
  )
}

export function RangeBadge({
  metric,
  value,
  context,
  className,
}: {
  metric: MetricKey
  value: number | null
  context?: EvalContext
  className?: string
}) {
  const ev = getMetricStatus(metric, value, context ?? {})
  return <StatusChip status={ev.status} title={getTargetLanguage(metric, ev)} className={className} />
}
