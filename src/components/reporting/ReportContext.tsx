'use client'

import type { ReportingContext } from '@/lib/reporting/contracts'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { useGlobalControls } from '@/lib/use-global-controls'

export function ReportContext({ context, failed = false, frozen = false, compact = false }: { context: ReportingContext | null; failed?: boolean; frozen?: boolean; compact?: boolean }) {
  const { range, setRange, ready } = useGlobalControls()
  const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (compact) return <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-2">
    <h1 className="sr-only">Overview</h1>
    <p className="min-w-0 text-sm text-[var(--text-secondary)]" title={context ? `${context.account.metaAccountId} · ${context.currency} · ${context.timezone}` : undefined}>{context ? context.account.name ?? 'Reporting account' : failed ? 'Reporting account unavailable' : 'Resolving reporting account…'}</p>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-secondary)]">
      {ready && !frozen ? <div className="print:hidden"><DateRangeControl value={range} onChange={setRange} compact /></div>
        : context && <p>{context.range.from} – {context.range.to}</p>}
      {context && <p title={`${context.comparison.from} – ${context.comparison.to} · ${context.timezone} · ${context.currency}`}>vs {shortDate(context.comparison.from)} – {shortDate(context.comparison.to)}</p>}
    </div>
  </header>
  return <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-[var(--border)] pb-4 text-xs text-[var(--text-secondary)]">
    <div className="space-y-1 tabular-nums">
      <p className="font-medium text-[var(--text-primary)]">{context ? `${context.account.name ?? 'Reporting account'} · ${context.account.metaAccountId}` : failed ? 'Reporting account unavailable' : 'Resolving reporting account…'}</p>
      {context && <><p>{context.range.from} – {context.range.to} · {context.timezone} · {context.currency}</p>
        <p>Compared with {context.comparison.from} – {context.comparison.to}</p></>}
    </div>
    {ready && !frozen && <div className="ml-auto print:hidden"><DateRangeControl value={range} onChange={setRange} compact /></div>}
  </div>
}
