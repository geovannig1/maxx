'use client'

import { cn } from '@/lib/utils'
import { DATE_PRESETS, type DatePresetKey } from '@/lib/date-range'

// Pure helpers live in @/lib/date-range so SERVER components can use them too. Re-exported here for
// existing client importers (campaigns/adsets/ads/tests) that pull them from this path.
export { DATE_PRESETS, resolveDatePreset, type DatePresetKey, type ResolvedRange } from '@/lib/date-range'

export function DateRangePicker({
  value,
  onChange,
  className,
}: {
  value: DatePresetKey
  onChange: (key: DatePresetKey) => void
  className?: string
}) {
  return (
    <div
      className={cn('flex items-center gap-1 p-1 rounded-lg', className)}
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
      role="group"
      aria-label="Date range"
    >
      {DATE_PRESETS.map((p) => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          title={p.title}
          aria-pressed={value === p.key}
          className="px-3 py-1.5 rounded-md text-xs font-medium transition-all"
          style={value === p.key ? { background: 'var(--bg-overlay)', color: 'var(--text-primary)' } : { color: 'var(--text-tertiary)' }}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
