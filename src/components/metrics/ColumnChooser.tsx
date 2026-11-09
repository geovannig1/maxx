'use client'

import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal, RotateCcw } from 'lucide-react'
import { metricsForLevel, type EntityLevel } from '@/lib/metrics/catalog'

// Column visibility dropdown for the entity tables. Self-contained (button + click-outside panel) to
// avoid coupling to a menu library; lists every metric available at this entity level.
export function ColumnChooser({
  level,
  isVisible,
  onToggle,
  onReset,
}: {
  level: EntityLevel
  isVisible: (key: string) => boolean
  onToggle: (key: string) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const defs = metricsForLevel(level)

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const shownCount = defs.filter((d) => isVisible(d.key)).length

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg text-xs transition-colors"
        style={{
          height: 32, padding: '0 12px',
          background: open ? 'var(--accent-dim)' : 'var(--bg-input)',
          border: `1px solid ${open ? 'var(--accent)' : 'var(--border)'}`,
          color: open ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        Columns
        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{shownCount}</span>
      </button>

      {open && (
        <div
          className="absolute right-0 z-50 mt-1.5 w-60 rounded-lg shadow-2xl overflow-hidden"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
            <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Metrics</span>
            <button onClick={onReset} className="flex items-center gap-1 text-[10px] transition-colors" style={{ color: 'var(--text-tertiary)' }} title="Reset to defaults">
              <RotateCcw className="w-3 h-3" /> Reset
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {defs.map((d) => {
              const on = isVisible(d.key)
              return (
                <button
                  key={d.key}
                  onClick={() => onToggle(d.key)}
                  className="flex items-center gap-2.5 w-full px-3 py-1.5 text-left transition-colors hover:bg-[var(--border)]"
                  title={d.description}
                >
                  <span
                    className="flex items-center justify-center rounded shrink-0"
                    style={{
                      width: 15, height: 15,
                      background: on ? 'var(--accent)' : 'transparent',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      color: '#fff', fontSize: 10, lineHeight: 1,
                    }}
                  >
                    {on ? '✓' : ''}
                  </span>
                  <span className="text-xs" style={{ color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{d.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
