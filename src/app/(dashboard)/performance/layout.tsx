'use client'

import { Suspense } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Activity, Target, Layers, Image as ImageIcon, PieChart } from 'lucide-react'
import { buildPerformanceDrilldownHref, type PerformancePresetKey } from '@/lib/performance/presets'
import { resolveRange } from '@/lib/date-range'

// The Performance destination shell (cockpit IA): the Meta drill spine + creative/segment lenses as
// TABS under one route, instead of separate nav items. Each tab is a route segment rendering its
// existing page (so the drilldown campaign→adset→ad and every page's own controls stay intact). This
// slim tab bar sits above each page's own header — no duplicate "Performance" title.
const TABS: Array<{ label: string; href: string; icon: typeof Activity; preset: PerformancePresetKey }> = [
  { label: 'Account',   href: '/performance',           icon: Activity, preset: 'results' },
  { label: 'Campaigns', href: '/performance/campaigns', icon: Target, preset: 'results' },
  { label: 'Ad Sets',   href: '/performance/adsets',    icon: Layers, preset: 'delivery' },
  { label: 'Ads',       href: '/performance/ads',       icon: ImageIcon, preset: 'funnel' },
  // Segments carries placement, age, gender, device and region — the entire demographic and
  // placement layer, and the biggest single gap against the external audit this console replaces.
  // It was reachable ONLY by pressing Cmd-K and knowing the word "Segments", while /experiments (a
  // page whose whole content is a refusal) held a primary sidebar slot. One line restores it.
  { label: 'Segments',  href: '/performance/segments',  icon: PieChart, preset: 'results' },
  // Creative left this tab bar when it became a top-level destination (`/creative`). A tab says
  // "inside Performance"; it is a sibling now. It stays LINKED from the hierarchy nav and the
  // preset strip below, so nothing became harder to reach — only differently parented.
]

function PerformanceNavigation() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  if (pathname === '/performance') return null
  const range = resolveRange({
    range: searchParams.get('range') ?? undefined,
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  }, '1m')
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map((t) => {
          const active = t.href === '/performance'
            ? pathname === '/performance'
            : pathname === t.href || pathname.startsWith(t.href + '/')
          const Icon = t.icon
          return (
            <Link
              key={t.href}
              href={buildPerformanceDrilldownHref(t.href, t.preset, range)}
              className="inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
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
  )
}

export default function PerformanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      {/* Search-param consumers stay behind a boundary so static route shells remain buildable. */}
      <Suspense fallback={<div className="min-h-11" aria-label="Loading performance navigation" />}>
        <PerformanceNavigation />
      </Suspense>
      {children}
    </div>
  )
}
