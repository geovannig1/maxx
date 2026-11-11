'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Eye, Rss, Zap } from 'lucide-react'
import Link from 'next/link'
import { format } from 'date-fns'
import { ATTRIBUTION_WINDOW_LABEL } from '@/lib/platforms/meta/attribution'
import { READ_ONLY_APPLY_NOTE } from '@/lib/ui/proposal'
import { formatMoney } from '@/lib/utils/format-currency'

interface TopObservation {
  entity_name: string
  observation: string
  evidence_basis: 'meta_modelled'
  action_authority: 'diagnostic_only'
}

interface TrendSignal {
  title: string
  context: string
  source: string
  evidence_basis: 'external_research'
  action_authority: 'diagnostic_only'
}

interface BriefData {
  meta_delivery:
    | {
        available: true
        spend: number
        modelled_results: number
        evidence_basis: 'meta_modelled'
        action_authority: 'diagnostic_only'
      }
    | {
        available: false
        spend: null
        modelled_results: null
        evidence_basis: 'meta_modelled'
        action_authority: 'diagnostic_only'
        unavailable_reason: 'no_committed_daily_report' | 'incomplete_committed_daily_report'
      }
  top_observation: TopObservation | null
  action_today: {
    copy: string
    tier: 'execution_eligible' | 'owner_review' | 'diagnostic_only' | 'diagnostic_only_legacy'
  } | null
  new_competitor_ads: number
  competitor_alert: string | null
  trend_signal: TrendSignal | null
  campaigns_status: 'active' | 'all_paused' | 'no_data'
  generated_at: string
}

const DIVIDER = <div style={{ height: '1px', background: 'var(--bg-subtle)', margin: '12px 0' }} />

export function MorningBrief() {
  const todayKey = `maxx_brief_read_${format(new Date(), 'yyyy-MM-dd')}`
  const [data, setData] = useState<BriefData | null>(null)
  const [loading, setLoading] = useState(true)
  const [readError, setReadError] = useState(false)
  const [collapsed, setCollapsed] = useState(true)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch('/api/morning-brief')
        if (!response.ok) throw new Error('Morning brief read failed')
        const next = (await response.json()) as BriefData
        if (active) setData(next)
      } catch {
        if (active) setReadError(true)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [])

  function handleMarkRead() {
    if (typeof window !== 'undefined') localStorage.setItem(todayKey, '1')
    setCollapsed(true)
  }

  if (loading) {
    return (
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-focus)', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '16px', height: '16px', borderRadius: '3px', background: 'var(--accent-dim)', animation: 'pulse 2s infinite' }} />
            <div style={{ width: '80px', height: '11px', borderRadius: '4px', background: 'var(--bg-subtle)', animation: 'pulse 2s infinite' }} />
          </div>
          <div style={{ width: '60px', height: '11px', borderRadius: '4px', background: 'var(--bg-subtle)', animation: 'pulse 2s infinite' }} />
        </div>
        <div style={{ width: '200px', height: '28px', borderRadius: '6px', background: 'var(--bg-subtle)', marginBottom: '8px', animation: 'pulse 2s infinite' }} />
        <div style={{ width: '260px', height: '13px', borderRadius: '4px', background: 'var(--bg-subtle)', animation: 'pulse 2s infinite' }} />
      </div>
    )
  }

  if (collapsed) {
    const summary = readError
      ? 'Morning brief unavailable'
      : data?.meta_delivery.available
        ? `${formatMoney(data.meta_delivery.spend)} Meta spend · ${data.meta_delivery.modelled_results} modelled event${data.meta_delivery.modelled_results === 1 ? '' : 's'}`
        : 'No committed delivery snapshot for yesterday'
    return (
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--accent-dim)',
          borderRadius: '12px',
          padding: '10px 16px',
          marginBottom: '24px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          cursor: 'pointer',
        }}
        onClick={() => setCollapsed(false)}
      >
        <Zap style={{ width: '14px', height: '14px', color: 'var(--accent)', flexShrink: 0 }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{summary}</span>
        <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>· Diagnostic brief</span>
        <ChevronDown style={{ width: '14px', height: '14px', color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0 }} />
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-focus)', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap style={{ width: '16px', height: '16px', color: 'var(--accent)' }} />
          <span style={{ fontSize: '10.5px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>Maxx Brief</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{format(new Date(), 'MMMM d')}</span>
          <button onClick={handleMarkRead} style={{ fontSize: '11px', color: 'var(--text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 6px' }}>
            Mark as read
          </button>
          <button onClick={() => setCollapsed(true)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }} aria-label="Collapse">
            <ChevronUp style={{ width: '14px', height: '14px', color: 'var(--text-tertiary)' }} />
          </button>
        </div>
      </div>

      {readError ? (
        <div>
          <p style={{ fontSize: '15px', fontWeight: 650, color: 'var(--warning)' }}>Brief data unavailable</p>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>No status is inferred from a failed read. Refresh after the account data is available.</p>
        </div>
      ) : data?.meta_delivery.available ? (
        <div>
          <p style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
            {formatMoney(data.meta_delivery.spend)} Meta spend yesterday
          </p>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '5px' }}>
            {data.meta_delivery.modelled_results} Meta-modelled event{data.meta_delivery.modelled_results === 1 ? '' : 's'} · diagnostic delivery context only
          </p>
        </div>
      ) : (
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)' }}>No committed report data for yesterday. No performance status is inferred.</p>
      )}

      {data?.top_observation && (
        <>
          {DIVIDER}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <Eye style={{ width: '14px', height: '14px', color: 'var(--text-tertiary)', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Diagnostic observation</p>
              <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '3px' }}>{data.top_observation.entity_name}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{data.top_observation.observation}</p>
            </div>
          </div>
        </>
      )}

      {data?.action_today && (
        <>
          {DIVIDER}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <CheckCircle2 style={{ width: '15px', height: '15px', color: 'var(--accent)', flexShrink: 0, marginTop: '1px' }} />
            <div>
              <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBottom: '3px' }}>
                {data.action_today.tier === 'diagnostic_only' || data.action_today.tier === 'diagnostic_only_legacy'
                  ? 'Diagnostic review'
                  : data.action_today.tier === 'owner_review'
                    ? 'Governed owner review'
                    : 'Governed execution-eligible decision'}
              </p>
              <p style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{data.action_today.copy}</p>
              <p style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', marginTop: '3px' }}>{READ_ONLY_APPLY_NOTE}</p>
            </div>
          </div>
        </>
      )}

      {(data?.competitor_alert || data?.trend_signal) && (
        <>
          {DIVIDER}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Market pulse · diagnostic context</p>
            {data.competitor_alert && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <Eye style={{ width: '13px', height: '13px', color: 'var(--text-tertiary)', flexShrink: 0, marginTop: '1px' }} />
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{data.competitor_alert}</p>
              </div>
            )}
            {data.trend_signal && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                <Rss style={{ width: '13px', height: '13px', color: 'var(--accent)', flexShrink: 0, marginTop: '1px' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {data.trend_signal.title}{' '}
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>— {data.trend_signal.source}</span>
                  </p>
                  <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{data.trend_signal.context}</p>
                </div>
                <Link href="/signals" style={{ flexShrink: 0, fontSize: '11px', color: 'var(--accent)', textDecoration: 'none' }}>View →</Link>
              </div>
            )}
          </div>
        </>
      )}

      {DIVIDER}
      <p style={{ fontSize: '10.5px', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
        Meta spend and modelled events come from the committed daily Meta report ({ATTRIBUTION_WINDOW_LABEL} attribution) and carry diagnostic-only authority. They are not paid CPA or paid ROAS. The outcome ledger remains the business record; GA4 is session-channel telemetry.
      </p>
    </div>
  )
}
