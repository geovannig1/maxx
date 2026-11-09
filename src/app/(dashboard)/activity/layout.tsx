'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { History } from 'lucide-react'

// Activity is the retrospective owner loop: decision, separate manual implementation, observation, outcome.
const TABS = [
  { label: 'Lifecycle timeline', href: '/activity/change-log', icon: History },
]

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/')
          const Icon = t.icon
          return (
            <Link
              key={t.href}
              href={t.href}
              className="inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors"
              style={{
                minHeight: 44, padding: '0 14px',
                background: active ? 'var(--accent-dim)' : 'var(--bg-input)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                color: active ? 'var(--accent)' : 'var(--text-secondary)', textDecoration: 'none',
              }}
            >
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </Link>
          )
        })}
      </div>
      {children}
    </div>
  )
}
