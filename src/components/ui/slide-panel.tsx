'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getTargetRange, type MetricKey } from '@/lib/targets/target-ranges'
import { formatMoney } from '@/lib/utils/format-currency'

interface SlidePanelProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: React.ReactNode
  width?: 'md' | 'lg'
}

export function SlidePanel({ open, onClose, title, subtitle, children, width = 'md' }: SlidePanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    const firstFocusable = panel?.querySelector<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    firstFocusable?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'Tab' || !panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    if (open) document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      triggerRef.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 backdrop-blur-sm"
        style={{ background: 'rgba(16,24,40,0.10)' }}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="slide-panel-title"
        className={cn(
          'fixed right-0 top-0 h-full z-50 flex w-full max-w-full flex-col shadow-2xl sm:max-w-[460px] transition-transform duration-250 ease-out',
          width === 'lg' ? 'sm:max-w-[560px]' : 'sm:max-w-[460px]',
          'translate-x-0'
        )}
        style={{
          background: 'var(--bg-elevated)',
          borderLeft: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-4 px-6 py-5 shrink-0"
          style={{
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div className="min-w-0">
            <h2
              id="slide-panel-title"
              className="leading-snug truncate"
              style={{ color: 'var(--text-primary)', fontSize: '15px', fontWeight: 600 }}
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 min-w-11 min-h-11 rounded-md flex items-center justify-center transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {children}
        </div>
      </div>
    </>
  )
}

// ── Reusable sub-components for panel content ──────────────────────────

export function PanelMetricGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-3">{children}</div>
}

export function PanelMetric({
  label,
  value,
  sub,
  highlight,
}: {
  label: string
  value: string
  sub?: string
  highlight?: 'good' | 'warn' | 'bad' | 'neutral'
}) {
  const valueColor =
    highlight === 'good' ? 'var(--success)'
    : highlight === 'warn' ? 'var(--warning)'
    : highlight === 'bad' ? 'var(--danger)'
    : undefined

  return (
    <div
      className="rounded-lg px-3 py-3 space-y-1"
      style={{ background: 'var(--bg-overlay)', border: '1px solid var(--border)' }}
    >
      <p className="section-label">{label}</p>
      <p
        className="text-lg font-bold tabular-nums"
        style={{ color: valueColor ?? 'var(--text-primary)' }}
      >
        {value}
      </p>
      {sub && <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{sub}</p>}
    </div>
  )
}

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="section-label">{title}</h3>
      {children}
    </div>
  )
}

// Reads the CONFIGURABLE range (same source RangeBadge uses) so the gauge agrees with the badge beside it
// and honors edited targets — instead of a hardcoded 60/90 that could show "under target" while the badge
// said "over" (audit: two-sources-of-truth). `metric` defaults to 'cpl' (what these panels feed it).
export function CpaBar({ cpa, metric = 'cpl' }: { cpa: number | null; metric?: MetricKey }) {
  const range = getTargetRange(metric)
  const target = range.healthy
  const nearLimit = range.watch
  // A money metric has no target until the owner sets one; the gauge asks for it instead.
  if (target === null || nearLimit === null) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: 'var(--text-tertiary)' }}>No target set</span>
        <span style={{ color: 'var(--text-tertiary)' }}>Set a target in Settings → Performance Targets</span>
      </div>
    )
  }
  if (cpa === null) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span style={{ color: 'var(--text-tertiary)' }}>vs {formatMoney(target)} target</span>
          <span style={{ color: 'var(--text-tertiary)' }}>No data</span>
        </div>
        <div className="h-2 rounded-full" style={{ background: 'var(--bg-overlay)' }} />
      </div>
    )
  }

  const pct = Math.min((cpa / (target * 2)) * 100, 100)
  const color = cpa <= target ? 'bg-emerald-500' : cpa <= nearLimit ? 'bg-amber-400' : 'bg-red-500'
  const label = cpa <= target ? 'Under target' : cpa <= nearLimit ? 'Near limit' : 'Over limit'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: 'var(--text-secondary)' }}>vs {formatMoney(target)} target</span>
        <span style={{ color: cpa <= target ? 'var(--success)' : cpa <= nearLimit ? 'var(--warning)' : 'var(--danger)' }}>
          {formatMoney(cpa)} — {label}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-end">
        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Target: {formatMoney(target)}</span>
      </div>
    </div>
  )
}

export function FrequencyBar({ frequency }: { frequency: number | null }) {
  if (frequency === null) return null

  const pct = Math.min((frequency / 5) * 100, 100)
  const color = frequency < 2.5 ? 'bg-emerald-500' : frequency < 3.5 ? 'bg-amber-400' : 'bg-red-500'
  const label = frequency < 2.5 ? 'Lower observed frequency' : frequency < 3.5 ? 'Diagnostic warning band' : 'High observed frequency'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span style={{ color: 'var(--text-secondary)' }}>Frequency</span>
        <span style={{ color: frequency < 2.5 ? 'var(--success)' : frequency < 3.5 ? 'var(--warning)' : 'var(--danger)' }}>
          {frequency.toFixed(1)} — {label}
        </span>
      </div>
      <div className="relative h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-overlay)' }}>
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        <span>0</span>
        <span className="text-amber-600">2.5</span>
        <span className="text-red-600">3.5</span>
        <span>5+</span>
      </div>
    </div>
  )
}
