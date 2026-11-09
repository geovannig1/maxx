import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import type { ReportFinding } from '@/lib/reporting/contracts'
import { ReportMetricValue } from './MetricValue'

export function FindingsPanel({ findings, expanded = false }: { findings: ReportFinding[]; expanded?: boolean }) {
  const visible = expanded ? findings : findings.slice(0, 3)
  return <section aria-label={expanded ? 'All seven reporting checks' : 'What deserves a closer look'} className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--accent)' }}>Automatic review</p>
        <h2 className="mt-1 text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>{expanded ? 'All seven reporting checks' : 'What deserves a closer look'}</h2>
      </div>
      {!expanded && <Link href={findings.find(f => f.area === 'coverage')?.href ?? '/reports'} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium" style={{ color: 'var(--accent)' }}>See every check <ArrowUpRight size={16} /></Link>}
    </div>
    <div className={expanded ? 'grid gap-3 lg:grid-cols-2' : 'grid gap-3 xl:grid-cols-3'}>
      {visible.map((finding, index) => <article key={finding.id} className="rounded-xl border p-4 print:break-inside-avoid" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border)' }}>
        <div className="flex items-start gap-3"><span className="text-xs tabular-nums pt-1" style={{ color: 'var(--text-tertiary)' }}>{String(index + 1).padStart(2, '0')}</span>
          <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{finding.title}</h3></div>
        <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>{expanded ? finding.detail : finding.summary ?? finding.detail}</p>
        {!expanded && finding.summary && <details className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
          <summary className="inline-flex min-h-11 cursor-pointer items-center underline">Read full observation</summary>
          <p className="pb-2">{finding.detail}</p>
        </details>}
        {expanded && finding.metrics.length > 0 && <div className="my-2 grid grid-cols-2 gap-2">
          {finding.metrics.map(metric => <div key={metric.current.claimId}><p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{metric.label}</p><ReportMetricValue metric={metric} compact /></div>)}
        </div>}
        <Link href={finding.href} className="mt-2 inline-flex min-h-11 items-center gap-1 text-sm font-medium" style={{ color: 'var(--accent)' }}>Inspect evidence <ArrowUpRight size={14} /></Link>
      </article>)}
    </div>
  </section>
}
