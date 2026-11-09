'use client'
import { resolveDisplayAuthority } from '@/lib/authority/legacy-cutover'

import { useState, useEffect } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { PageHeader } from '@/components/layout/PageHeader'
import { FlagBadge, type FlagType } from '@/components/ui/badges'
import { LowDataNotice } from '@/components/ui/LowDataNotice'
import { TrendingUp, TrendingDown, Eye, Clock, Zap, RefreshCw } from 'lucide-react'
import { READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'
import { formatMoney } from '@/lib/utils/format-currency'

interface Flag {
  id: string
  flag_date: string
  window_days: number
  entity_level: string
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  flag_type: string
  confidence: string
  audience_type: string
  reason: string
  recommended_action: string | null
  watch_next: string | null
  spend_in_window: number | null
  cpa_in_window: number | null
  ctr_in_window: number | null
  frequency_in_window: number | null
}

interface FlagSummary {
  winners: number
  losers: number
  scale_candidates: number
  watchlist: number
  creative_refresh: number
  too_early: number
}

const FLAG_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; cardStyle: React.CSSProperties; activeFilterStyle: React.CSSProperties }> = {
  winner: {
    label: 'Favorable signal',
    icon: TrendingUp,
    color: 'var(--success)',
    cardStyle:        { border: '1px solid var(--success-border)',  background: 'rgba(52,211,153,0.06)' },
    activeFilterStyle:{ border: '1px solid var(--success-border)',  background: 'rgba(52,211,153,0.06)',  color: 'var(--success)' },
  },
  loser: {
    label: 'Concerning signal',
    icon: TrendingDown,
    color: 'var(--danger)',
    cardStyle:        { border: '1px solid var(--danger-border)', background: 'rgba(248,113,113,0.06)' },
    activeFilterStyle:{ border: '1px solid var(--danger-border)', background: 'rgba(248,113,113,0.06)', color: 'var(--danger)' },
  },
  scale_candidate: {
    label: 'High-delivery signal',
    icon: Zap,
    color: 'var(--accent)',
    cardStyle:        { border: '1px solid var(--border-focus)',   background: 'var(--accent-dim)' },
    activeFilterStyle:{ border: '1px solid var(--border-focus)',   background: 'var(--accent-dim)',  color: 'var(--accent)' },
  },
  watchlist: {
    label: 'Watch signal',
    icon: Eye,
    color: 'var(--warning)',
    cardStyle:        { border: '1px solid var(--warning-border)',  background: 'rgba(251,191,36,0.06)' },
    activeFilterStyle:{ border: '1px solid var(--warning-border)',  background: 'rgba(251,191,36,0.06)',  color: 'var(--warning)' },
  },
  creative_refresh: {
    label: 'Fatigue signal',
    icon: RefreshCw,
    color: 'var(--trust-low)',
    cardStyle:        { border: '1px solid var(--warning-border)',  background: 'rgba(251,146,60,0.06)' },
    activeFilterStyle:{ border: '1px solid var(--warning-border)',  background: 'rgba(251,146,60,0.06)',  color: 'var(--trust-low)' },
  },
  too_early: {
    label: 'Too Early',
    icon: Clock,
    color: 'var(--text-tertiary)',
    cardStyle:        { border: '1px solid var(--border)',          background: 'var(--bg-surface)' },
    activeFilterStyle:{ border: '1px solid var(--border-hover)',    background: 'var(--bg-elevated)',     color: 'var(--text-secondary)' },
  },
}

const metricChipStyle: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--r-sm)',
  padding: '2px 8px',
  fontSize: '12px',
  fontVariantNumeric: 'tabular-nums',
}

export default function FlagsPage() {
  const [flags, setFlags] = useState<Flag[]>([])
  const [summary, setSummary] = useState<FlagSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [filter, setFilter] = useState('all')
  const [windowDays, setWindowDays] = useState(7)

  useEffect(() => {
    // await-first IIFE so setState isn't synchronous-in-effect (avoids the cascading-render lint).
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ window_days: String(windowDays), limit: '100' })
        if (filter !== 'all') params.set('flag_type', filter)
        const res = await fetch(`/api/flags?${params}`, { cache: 'no-store' })
        if (!active) return
        if (res.ok) {
          const data = await res.json()
          if (active) { setFlags(data.flags ?? []); setSummary(data.summary ?? null) }
        } else {
          setError('Failed to load flags.')
        }
      } catch {
        if (active) setError('Failed to load flags.')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [filter, windowDays, reloadKey])

  const fmt = (n: number | null) => n !== null ? `${formatMoney(n)}` : '—'

  return (
    <div className="space-y-5">
      {/* Header — shared PageHeader (freshness + write-mode standardized). */}
      <PageHeader title="Diagnostic flags" icon={Zap} subtitle="Meta-modelled delivery observations updated after every sync. These labels do not decide what to scale, refresh, or cut." />
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{READ_ONLY_APPLY_NOTE} Flags below are diagnostic-only and cannot authorize a change.</p>

      {/* Low-data calibration — only on the unfiltered view, when every flag is still "too early". */}
      {filter === 'all' && summary &&
        (summary.winners + summary.losers + summary.scale_candidates + summary.watchlist + summary.creative_refresh) === 0 &&
        summary.too_early > 0 && (
        <LowDataNotice
          title="Still warming up — too early to call"
          message={`Every ad evaluated in this ${windowDays}-day window is flagged "too early": there is not enough delivery evidence for a stable diagnostic label.`}
          items={[
            { label: 'Too early', have: String(summary.too_early) },
            { label: 'Stable diagnostic flags', have: '0', need: 'More observed delivery' },
          ]}
        />
      )}

      {/* Summary filter pills */}
      {summary && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(FLAG_CONFIG).map(([type, cfg]) => {
            const isActive = filter === type
            return (
              <button
                key={type}
                onClick={() => setFilter(filter === type ? 'all' : type)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
                style={
                  isActive
                    ? cfg.activeFilterStyle
                    : {
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }
                }
              >
                <cfg.icon style={{ width: '12px', height: '12px' }} />
                {cfg.label}
                <span style={{ fontWeight: 700 }}>{summary[type as keyof FlagSummary] ?? 0}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Window selector */}
      <div className="flex items-center gap-2">
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Window:</span>
        {[1, 3, 7, 30].map((d) => (
          <button
            key={d}
            onClick={() => setWindowDays(d)}
            className="px-2.5 py-1 rounded text-xs font-medium transition-colors"
            style={
              windowDays === d
                ? { background: 'var(--accent-dim)', color: 'var(--accent-hover)', border: '1px solid var(--accent)' }
                : { color: 'var(--text-tertiary)', border: '1px solid transparent' }
            }
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Flag list */}
      <div className="space-y-2">
        {loading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))
        ) : error ? (
          <ErrorState title="Couldn't load flags" onRetry={() => setReloadKey((k) => k + 1)} />
        ) : flags.length === 0 ? (
          <EmptyState
            icon={Zap}
            title="No flags yet"
            description="Run a sync to evaluate your campaigns"
          />
        ) : (
          flags.map((flag) => {
            const cfg = FLAG_CONFIG[flag.flag_type] ?? FLAG_CONFIG.too_early
            const Icon = cfg.icon
            const entityId = flag.meta_ad_id ?? flag.meta_adset_id ?? flag.meta_campaign_id ?? '—'
            return (
              <div key={flag.id} className="rounded-lg p-4 space-y-2" style={cfg.cardStyle}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    <Icon style={{ width: '16px', height: '16px', color: cfg.color, flexShrink: 0 }} />
                    <FlagBadge type={flag.flag_type as FlagType} />
                    <span style={metricChipStyle}>
                      {flag.entity_level}
                    </span>
                    {flag.audience_type !== 'unknown' && (
                      <span style={metricChipStyle}>
                        {flag.audience_type}
                      </span>
                    )}
                    <span
                      className="text-xs font-mono truncate"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {entityId}
                    </span>
                  </div>
                  <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
                    {flag.spend_in_window !== null && (
                      <span style={metricChipStyle}>
                        Spend: {fmt(flag.spend_in_window)}
                      </span>
                    )}
                    {flag.cpa_in_window !== null && (
                      <span style={metricChipStyle}>
                        Meta cost/Result: {fmt(flag.cpa_in_window)}
                      </span>
                    )}
                    {flag.ctr_in_window !== null && (
                      <span style={metricChipStyle}>
                        CTR: {flag.ctr_in_window.toFixed(2)}%
                      </span>
                    )}
                    {flag.frequency_in_window !== null && (
                      <span style={metricChipStyle}>
                        Freq: {flag.frequency_in_window.toFixed(1)}
                      </span>
                    )}
                    <span style={{ ...metricChipStyle, color: 'var(--text-tertiary)' }}>
                      {flag.window_days}d
                    </span>
                  </div>
                </div>
                <p style={{ fontSize: '13.5px', color: 'var(--text-primary)' }}>{flag.reason}</p>
                {/* This rendered the STORED action prose. A flag carries no ActionDecision, so it is diagnostic by STRUCTURE — the resolver decides without reading the wording, and the raw text never reaches the owner as an instruction. asProposedAction merely PREFIXED the stored string — framing without validation. */}
                {flag.recommended_action && (
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {resolveDisplayAuthority(null, flag.recommended_action).copy} <span style={{ color: 'var(--text-tertiary)' }}>· Diagnostic only: no change runs from a flag.</span>
                  </p>
                )}
                {flag.watch_next && (
                  <p style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                    <span style={{ fontWeight: 600 }}>Watch:</span> {resolveDisplayAuthority(null, flag.watch_next).copy}
                  </p>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
