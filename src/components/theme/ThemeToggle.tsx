'use client'

import { useTheme } from 'next-themes'
import { useSyncExternalStore } from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match system', Icon: Monitor },
] as const

const subscribeHydration = () => () => {}
/** Keep the initial server/client selection identical before showing the browser's saved theme. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false)

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-0.5 rounded-full p-0.5"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = hydrated && theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className="flex h-6 w-6 items-center justify-center rounded-full transition-colors"
            style={{
              background: selected ? 'var(--bg-surface)' : 'transparent',
              color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
              boxShadow: selected ? 'var(--shadow-card)' : 'none',
            }}
          >
            <Icon size={13} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
