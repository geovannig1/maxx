'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Image as ImageIcon } from 'lucide-react'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorState } from '@/components/ui/error-state'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useGlobalControls } from '@/lib/use-global-controls'
import { buildPerformanceDrilldownHref } from '@/lib/performance/presets'
import { accountTimezoneShortName } from '@/config/timezone-label'
import { formatMoney } from '@/lib/utils/format-currency'

interface CreativeMetrics {
  spend: number
  hook_rate: number | null
  early_view_source: string
  retention_p25_rate: number | null
  retention_p50_rate: number | null
  completion_rate: number | null
  thruplay_rate: number | null
  retention_denominator: string
  video_start_coverage: string
}

interface CreativeRow {
  ad_id: string
  ad_name: string
  status: string
  thumbnail_url?: string | null
  creative?: {
    name: string | null
    format: string | null
    primaryText: string | null
    headline: string | null
  } | null
  metrics_status: 'available' | 'unavailable'
  metrics: CreativeMetrics | null
  diagnostic?: { label?: string; reason?: string } | null
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : `${value.toFixed(1)}%`
}

function copyExcerpt(value: string | null | undefined, maxLength = 140): string {
  if (!value) return 'Unavailable'
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value
}

export function CreativePerformance() {
  const { range, setRange, ready } = useGlobalControls()
  const [rows, setRows] = useState<CreativeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const params = new URLSearchParams({ from: range.from, to: range.to })
      const response = await fetch(`/api/ads?${params}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('creative_read_unavailable')
      const body = await response.json() as { ads?: CreativeRow[] }
      setRows(body.ads ?? [])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [range.from, range.to])

  useEffect(() => {
    if (!ready) return
    let active = true
    void Promise.resolve().then(() => { if (active) return load() })
    return () => { active = false }
  }, [load, ready])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Creative"
        icon={ImageIcon}
        subtitle="Ad-level creative delivery and retention evidence for the exact selected dates."
        controls={<DateRangeControl value={range} onChange={setRange} className="md:hidden" />}
      />
      <div className="rounded-lg px-4 py-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <p className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{range.from} → {range.to} {accountTimezoneShortName()}</p>
        <p className="text-[14px] leading-relaxed mt-1" style={{ color: 'var(--text-tertiary)' }}>
          Early view and retention milestones are descriptive. They do not prove fatigue or authorize a budget change. Multi-day reach and frequency stay unavailable without a native Meta period read.
        </p>
      </div>

      {loading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-52 rounded-lg" />)}</div>
      ) : error ? (
        <ErrorState title="Couldn't load creative performance" onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ImageIcon} title="No creative delivery in this window" description="Choose another closed-day range or verify the Meta ad sync." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const metrics = row.metrics
            return (
              <article key={row.ad_id} className="rounded-lg p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)' }}>
                <div className="mb-4 flex h-40 items-center justify-center overflow-hidden rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  {row.thumbnail_url ? (
                    // This URL is read-only creative evidence returned by Meta's synced asset inventory.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.thumbnail_url} alt={`Creative preview for ${row.ad_name}`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-center" style={{ color: 'var(--text-tertiary)' }}>
                      <ImageIcon aria-hidden="true" className="size-6" />
                      <span className="text-[12px]">Creative preview unavailable</span>
                    </div>
                  )}
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{row.ad_name}</p>
                    <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Meta ad ID {row.ad_id} · {row.status}</p>
                  </div>
                  <span className="text-[12px] rounded-full px-2 py-1" style={{ color: 'var(--text-secondary)', background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                    {row.metrics_status === 'available' ? 'Measured' : 'Unavailable'}
                  </span>
                </div>
                <div className="mt-4 space-y-2 rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                  <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Creative format:</span> {row.creative?.format ?? 'Unavailable'}
                    {row.creative?.name ? ` · ${row.creative.name}` : ''}
                  </p>
                  <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Primary text:</span> {copyExcerpt(row.creative?.primaryText)}
                  </p>
                  <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Headline:</span> {copyExcerpt(row.creative?.headline, 90)}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4">
                  {[
                    ['Spend', metrics ? `${formatMoney(metrics.spend)}` : 'Unavailable'],
                    ['Early view', percent(metrics?.hook_rate)],
                    ['Retention 25%', percent(metrics?.retention_p25_rate)],
                    ['Retention 50%', percent(metrics?.retention_p50_rate)],
                    ['Completion', percent(metrics?.completion_rate)],
                    ['ThruPlay', percent(metrics?.thruplay_rate)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="section-label text-[12px]">{label}</p>
                      <p className="text-[14px] font-semibold tabular-nums mt-1" style={{ color: 'var(--text-primary)' }}>{value}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[12px] leading-relaxed mt-4" style={{ color: 'var(--text-tertiary)' }}>
                  Source: Meta ad daily warehouse · Date: {range.from} → {range.to} · Early-view source: {metrics?.early_view_source ?? 'Unavailable'} · Retention denominator: {metrics?.retention_denominator ?? 'Unavailable'} ({metrics?.video_start_coverage ?? 'unavailable'} coverage)
                </p>
                <Link
                  href={buildPerformanceDrilldownHref('/performance/ads', 'creative', range, { ad: row.ad_id })}
                  className="mt-4 inline-flex min-h-11 items-center rounded-lg px-3 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  style={{ color: 'var(--accent)', background: 'var(--accent-dim)', border: '1px solid var(--border-focus)' }}
                >
                  View ad details
                </Link>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
