'use client'

import { useState } from 'react'
import { format, subDays, startOfMonth } from 'date-fns'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { CalendarIcon } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { cn } from '@/lib/utils'

interface DateRangePickerProps {
  value: DateRange
  onChange: (range: DateRange) => void
}

type Preset = {
  label: string
  range: () => DateRange
}

const PRESETS: Preset[] = [
  {
    label: 'Yesterday',
    range: () => {
      const d = subDays(new Date(), 1)
      return { from: d, to: d }
    },
  },
  {
    label: 'Last 7d',
    range: () => ({
      from: subDays(new Date(), 7),
      to: subDays(new Date(), 1),
    }),
  },
  {
    label: 'Last 14d',
    range: () => ({
      from: subDays(new Date(), 14),
      to: subDays(new Date(), 1),
    }),
  },
  {
    label: 'Last 30d',
    range: () => ({
      from: subDays(new Date(), 30),
      to: subDays(new Date(), 1),
    }),
  },
  {
    label: 'MTD',
    range: () => ({
      from: startOfMonth(new Date()),
      to: subDays(new Date(), 1),
    }),
  },
]

function formatDateRange(range: DateRange): string {
  if (!range.from) return 'Select range'
  if (!range.to || range.from.getTime() === range.to.getTime()) {
    return format(range.from, 'MMM d, yyyy')
  }
  if (range.from.getFullYear() === range.to.getFullYear()) {
    return `${format(range.from, 'MMM d')} – ${format(range.to, 'MMM d, yyyy')}`
  }
  return `${format(range.from, 'MMM d, yyyy')} – ${format(range.to, 'MMM d, yyyy')}`
}

export function DateRangePicker({ value, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)

  function applyPreset(preset: Preset) {
    onChange(preset.range())
    setOpen(false)
  }

  function isPresetActive(preset: Preset): boolean {
    const r = preset.range()
    return (
      value.from?.toDateString() === r.from?.toDateString() &&
      value.to?.toDateString() === r.to?.toDateString()
    )
  }

  return (
    <div className="flex items-center gap-2">
      {/* Quick presets */}
      <div className="hidden sm:flex items-center gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => applyPreset(preset)}
            className={cn(
              'px-2.5 py-1.5 rounded text-xs font-medium transition-colors',
              isPresetActive(preset)
                ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-700/50'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)]'
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* Custom calendar */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-overlay)] hover:text-[var(--text-primary)] transition-colors">
          <CalendarIcon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{formatDateRange(value)}</span>
          <span className="sm:hidden">Custom</span>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 border-[var(--border)]" style={{ background: 'var(--bg-elevated)' }} align="end">
          {/* Mobile presets */}
          <div className="sm:hidden flex flex-wrap gap-1 p-3 border-b border-[var(--border)]">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                onClick={() => applyPreset(preset)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs font-medium',
                  isPresetActive(preset)
                    ? 'bg-indigo-600/20 text-indigo-300'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)]'
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Calendar
            mode="range"
            selected={value}
            onSelect={(range) => {
              if (range) {
                onChange(range)
                if (range.from && range.to) setOpen(false)
              }
            }}
            numberOfMonths={2}
            disabled={{ after: subDays(new Date(), 1) }}
            className="p-3"
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
