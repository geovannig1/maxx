'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Calendar, ChevronDown } from 'lucide-react'
import { DATE_PRESETS, resolveDatePreset, type DatePresetKey } from '@/lib/date-range'
import { cn } from '@/lib/utils'

// Date-range control: quick presets (1D/1W/1M/MTD/QTD/YTD) PLUS two From/To date inputs for picking an
// arbitrary range. Clicking a preset fills from/to; editing a date input switches to a 'custom' range.
// Controlled — the parent owns the value (state on client pages, URL on server pages via UrlDateRangeControl).
// `compact` renders a single trigger + popover instead of the full inline row — used in the Topbar,
// where the inline variant is too wide and wraps the header onto a second line.

export interface DateRangeValue {
  preset: DatePresetKey | 'custom'
  from: string // YYYY-MM-DD
  to: string // YYYY-MM-DD
}

const inputStyle: CSSProperties = {
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  padding: '5px 8px',
  minHeight: '44px',
  colorScheme: 'light',
}

/** Short human label for the active range: preset title, or the custom dates. */
function rangeLabel(value: DateRangeValue): string {
  if (value.preset !== 'custom') {
    return DATE_PRESETS.find((p) => p.key === value.preset)?.title ?? value.preset.toUpperCase()
  }
  const short = (d: string) => {
    try {
      return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    } catch { return d }
  }
  return `${short(value.from)} – ${short(value.to)}`
}

function RangeFields({ value, onChange }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void }) {
  const lastClosedDate = resolveDatePreset('1d').to
  const fromMax = value.to && value.to < lastClosedDate ? value.to : lastClosedDate
  const setPreset = (k: DatePresetKey) => {
    const r = resolveDatePreset(k)
    onChange({ preset: k, from: r.from, to: r.to })
  }

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1 p-1 rounded-lg"
        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
        role="group"
        aria-label="Date range presets"
      >
        {DATE_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            title={p.title}
            aria-pressed={value.preset === p.key}
            className="min-h-11 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
            style={value.preset === p.key ? { background: 'var(--bg-surface)', color: 'var(--text-primary)', boxShadow: 'var(--shadow-card)' } : { color: 'var(--text-tertiary)' }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          aria-label="From date"
          className="min-w-0 flex-1"
          value={value.from}
          max={fromMax}
          onChange={(e) => e.target.value && onChange({ preset: 'custom', from: e.target.value, to: value.to })}
          style={inputStyle}
        />
        <span style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>→</span>
        <input
          type="date"
          aria-label="To date"
          className="min-w-0 flex-1"
          value={value.to}
          min={value.from || undefined}
          max={lastClosedDate}
          onChange={(e) => e.target.value && onChange({ preset: 'custom', from: value.from, to: e.target.value })}
          style={inputStyle}
        />
      </div>
    </>
  )
}

export function DateRangeControl({
  value,
  onChange,
  className,
  compact = false,
}: {
  value: DateRangeValue
  onChange: (v: DateRangeValue) => void
  className?: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Compact popover: close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!compact) {
    return (
      <div className={cn('flex items-center gap-2 flex-wrap', className)}>
        <RangeFields value={value} onChange={onChange} />
      </div>
    )
  }

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="date-range-popover"
        title="Change the date range (applies across pages)"
        className="flex items-center gap-1.5 rounded-lg text-xs font-medium transition-colors"
        style={{
          minHeight: '44px', padding: '0 10px', whiteSpace: 'nowrap',
          background: open ? 'var(--bg-subtle)' : 'var(--bg-surface)',
          border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer',
        }}
      >
        <Calendar style={{ width: '13px', height: '13px', flexShrink: 0 }} />
        {rangeLabel(value)}
        <ChevronDown style={{ width: '12px', height: '12px', flexShrink: 0, opacity: 0.7 }} />
      </button>
      {open && (
        <div
          id="date-range-popover"
          role="dialog"
          aria-labelledby="date-range-title"
          className="absolute right-0 mt-1.5 flex flex-col gap-2 p-3 rounded-xl"
          style={{
            top: '100%', zIndex: 60, width: 'min(340px, calc(100vw - 32px))',
            background: 'var(--bg-overlay)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-panel)',
          }}
        >
          <h2 id="date-range-title" className="sr-only">Date range</h2>
          <RangeFields value={value} onChange={onChange} />
        </div>
      )}
    </div>
  )
}
