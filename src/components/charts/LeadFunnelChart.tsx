'use client'
import { outcomeNoun } from '@/config/outcome-nouns'

interface LeadFunnelChartProps {
  impressions: number
  clicks: number
  landingPageViews: number
  leads: number
  bookings: number
}

function fmt(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return v.toLocaleString()
}

function rate(a: number, b: number): string | null {
  if (!b || !a) return null
  const pct = (a / b) * 100
  if (pct > 100) return null
  return `${pct.toFixed(1)}%`
}

interface Step {
  label: string
  value: number
  color: string
  prev: number | null
}

export function LeadFunnelChart({
  impressions, clicks, landingPageViews, leads, bookings,
}: LeadFunnelChartProps) {
  const steps: Step[] = [
    { label: 'Impressions',    value: impressions,      color: 'var(--chart-1)', prev: null },
    { label: 'Clicks',         value: clicks,            color: 'var(--chart-5)', prev: impressions },
    { label: 'Landing Views',  value: landingPageViews,  color: 'var(--chart-3)', prev: clicks },
    { label: 'Leads',          value: leads,             color: 'var(--chart-2)', prev: landingPageViews },
    { label: `Meta ${outcomeNoun({ plural: false })} events`, value: bookings,          color: 'var(--success)', prev: leads },
  ]

  const hasAnyData = steps.some(s => s.value > 0)

  if (!hasAnyData) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '8px',
      }}>
        <div style={{
          width: '40px', height: '40px', borderRadius: '10px',
          background: 'var(--accent-dim)', border: '1px solid var(--border-focus)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M9 3L3 15h12L9 3z" stroke="var(--chart-1)" strokeWidth="1.5" strokeLinejoin="round" fill="none"/>
          </svg>
        </div>
        <p style={{ fontSize: '12.5px', color: 'var(--text-tertiary)' }}>No funnel data yet — run a sync</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: '0', height: '100%' }}>
      {steps.map((step, i) => {
        const convRate = step.prev !== null ? rate(step.value, step.prev) : null
        const isLast = i === steps.length - 1

        return (
          <div key={step.label} style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
            {/* Step card */}
            <div style={{
              flex: 1,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              padding: '14px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              position: 'relative',
            }}>
              {/* Color dot + label */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  backgroundColor: step.color, flexShrink: 0,
                }} />
                <span style={{
                  fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em',
                  textTransform: 'uppercase', color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                }}>
                  {step.label}
                </span>
              </div>

              {/* Value */}
              <p style={{
                fontSize: '22px', fontWeight: 700, letterSpacing: '-0.03em',
                fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)',
                lineHeight: 1,
              }}>
                {fmt(step.value)}
              </p>

              {/* Conversion rate from previous */}
              {convRate && (
                <span style={{
                  fontSize: '10.5px', fontWeight: 600,
                  color: step.color, letterSpacing: '0.01em',
                }}>
                  {convRate} conv.
                </span>
              )}
              {!convRate && step.prev !== null && (
                /* This dash MEANS "no conversion rate available" — it is content, not chrome,
                   so it takes the AA-readable tertiary ink, never the 3:1 disabled ink. */
                <span style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>—</span>
              )}
            </div>

            {/* Arrow between steps */}
            {!isLast && (
              <div style={{
                width: '20px', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6h8M7 3l3 3-3 3" stroke="var(--border-hover)"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
