import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const w = 56, h = 22
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((v - min) / range) * (h - 3) - 1.5
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={w} height={h} style={{ overflow: 'visible', opacity: 0.6 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface KpiCardProps {
  label: string
  value: string | number
  subtitle?: string
  evidence?: {
    source: string
    date: string
    scope: string
    availability: string
  }
  delta?: { value: number; direction: 'up' | 'down' | 'flat' }
  accent?: 'good' | 'warn' | 'bad' | 'default'
  loading?: boolean
  icon?: React.ElementType
  sparkline?: number[]
}

// Quiet good, loud bad (design decision): healthy values stay ink (the green delta carries the good
// news); only warn/bad values escalate to color. No side-stripe accents — status lives in the value.
const VALUE_COLOR: Record<string, string> = {
  good:    'var(--text-primary)',
  warn:    'var(--warning)',
  bad:     'var(--danger)',
  default: 'var(--text-primary)',
}

const SPARK_COLOR: Record<string, string> = {
  good:    'var(--success)',
  warn:    'var(--warning)',
  bad:     'var(--danger)',
  default: 'var(--accent)',
}

export function KpiCard({
  label, value, subtitle, evidence, delta,
  accent = 'default', loading, icon: Icon, sparkline,
}: KpiCardProps) {
  if (loading) {
    return (
      <div style={{
        background: 'var(--bg-surface)', border: '1px solid var(--border)',
        borderRadius: '12px', padding: '20px',
        boxShadow: '0 1px 3px rgba(16,24,40,0.08)',
      }}>
        <div style={{ height: '10px', width: '72px', borderRadius: '4px', background: 'var(--bg-elevated)', marginBottom: '14px' }} />
        <div style={{ height: '32px', width: '96px', borderRadius: '4px', background: 'var(--bg-elevated)', marginBottom: '10px' }} />
        <div style={{ height: '10px', width: '48px', borderRadius: '4px', background: 'var(--bg-subtle)' }} />
      </div>
    )
  }

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: '20px',
      boxShadow: 'var(--shadow-card)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{
          fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--text-tertiary)',
        }}>
          {label}
        </span>
        {sparkline && sparkline.length >= 2
          ? <Sparkline data={sparkline} color={SPARK_COLOR[accent]} />
          : Icon && <Icon style={{ width: '14px', height: '14px', color: 'var(--text-disabled)' }} />
        }
      </div>

      {/* Value */}
      <p style={{
        fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em',
        lineHeight: 1, fontVariantNumeric: 'tabular-nums',
        color: VALUE_COLOR[accent], marginBottom: '10px', margin: '0 0 10px',
      }}>
        {value}
      </p>

      {/* Delta + subtitle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        {delta && (
          <span style={{
            display: 'flex', alignItems: 'center', gap: '3px',
            fontSize: '11.5px', fontWeight: 600,
            color: delta.direction === 'up' ? 'var(--success)'
              : delta.direction === 'down' ? 'var(--danger)'
              : 'var(--text-disabled)',
          }}>
            {delta.direction === 'up'   && <TrendingUp style={{ width: '11px', height: '11px' }} />}
            {delta.direction === 'down' && <TrendingDown style={{ width: '11px', height: '11px' }} />}
            {delta.direction === 'flat' && <Minus style={{ width: '11px', height: '11px' }} />}
            {delta.direction !== 'flat' && `${Math.abs(delta.value).toFixed(1)}%`}
          </span>
        )}
        {subtitle && (
          <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>{subtitle}</span>
        )}
      </div>
      {evidence && (
        <div
          style={{
            marginTop: '10px',
            paddingTop: '8px',
            borderTop: '1px solid var(--border)',
            display: 'grid',
            gap: '3px',
            fontSize: '10.5px',
            color: 'var(--text-tertiary)',
            lineHeight: 1.35,
          }}
        >
          <p>Source: {evidence.source}</p>
          <p>Date: {evidence.date}</p>
          <p>Scope: {evidence.scope}</p>
          <p>Availability: {evidence.availability}</p>
        </div>
      )}
    </div>
  )
}
