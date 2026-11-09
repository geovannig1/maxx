'use client'

import { useRouter, usePathname } from 'next/navigation'
import type { TrafficSource } from '@/lib/ga4/client'

// Complete / Paid / Organic source selector for the dashboard. URL-driven (?source=) so the server page
// re-renders source-scoped. Preserves the current date-range params. "Complete" is the default (no param).
const OPTIONS: { value: TrafficSource; label: string; hint: string }[] = [
  { value: 'complete', label: 'Complete', hint: 'All-source business totals plus traffic and ad delivery' },
  { value: 'paid', label: 'Paid', hint: 'GA paid-channel telemetry plus Meta delivery; not paid outcomes' },
  { value: 'organic', label: 'Organic', hint: 'GA non-paid channel telemetry; not ledger revenue' },
]

export function SourceToggle({ value, params }: { value: TrafficSource; params: { range?: string; from?: string; to?: string } }) {
  const router = useRouter()
  const pathname = usePathname()

  function go(v: TrafficSource) {
    const qs = new URLSearchParams()
    if (params.range) qs.set('range', params.range)
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    if (v !== 'complete') qs.set('source', v)
    const q = qs.toString()
    router.replace(`${pathname}${q ? `?${q}` : ''}`, { scroll: false })
  }

  return (
    <div className="inline-flex rounded-lg p-0.5" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
      {OPTIONS.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => go(o.value)}
            title={o.hint}
            className="rounded-md text-[12px] font-semibold transition-colors"
            style={{
              height: 28, padding: '0 12px',
              background: active ? 'rgba(99,102,241,0.22)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-secondary)',
              border: active ? '1px solid var(--border-focus)' : '1px solid transparent',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
