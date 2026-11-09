'use client'

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, X, ChevronRight } from 'lucide-react'

interface Alert {
  severity: string
  title: string
  type?: string
  alert_type?: string
}

interface AlertBannerProps {
  alerts: Alert[]
}

export function AlertBanner({ alerts }: AlertBannerProps) {
  const [dismissed, setDismissed] = useState(false)
  const [xHovered, setXHovered] = useState(false)

  if (dismissed || alerts.length === 0) return null

  const critical = alerts.filter((a) => a.severity === 'critical')
  const warnings  = alerts.filter((a) => a.severity === 'warning')
  const topAlert  = critical[0] || warnings[0]
  if (!topAlert) return null

  const isCritical = topAlert.severity === 'critical'

  const containerStyle = isCritical
    ? { background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }
    : { background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }

  const accentColor = isCritical ? 'var(--danger)' : 'var(--warning)'

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-lg text-sm"
      style={containerStyle}
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: accentColor }} />
      <div className="flex-1 min-w-0">
        <p style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
          {critical.length > 0
            ? `${critical.length} critical alert${critical.length > 1 ? 's' : ''}`
            : `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`}
          {' — '}
          <span style={{ fontWeight: 400, color: 'rgba(238,238,245,0.7)' }}>{topAlert.title}</span>
          {alerts.length > 1 && (
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginLeft: '6px' }}>
              +{alerts.length - 1} more
            </span>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href="/alerts"
          className="flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ color: accentColor }}
        >
          View all <ChevronRight className="w-3 h-3" />
        </Link>
        <button
          onClick={() => setDismissed(true)}
          className="p-0.5 rounded transition-colors"
          style={{ color: xHovered ? 'rgba(238,238,245,0.9)' : 'var(--text-tertiary)' }}
          onMouseEnter={() => setXHovered(true)}
          onMouseLeave={() => setXHovered(false)}
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
