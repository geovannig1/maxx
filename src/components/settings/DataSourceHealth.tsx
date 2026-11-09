'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

interface Source {
  key: string
  name: string
  role: string
  status: string
  detail: string
  error: string | null
  confidenceImpact: string
}
interface Health {
  sources: Source[]
  write_mode_enabled: boolean
  owner_email_set: boolean
  environment: string
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  connected:      { color: 'var(--success)', label: 'Connected' },
  configured:     { color: 'var(--success)', label: 'Configured' },
  stale:          { color: 'var(--warning)', label: 'Stale' },
  error:          { color: 'var(--danger)',  label: 'Error' },
  not_configured: { color: 'var(--warning)', label: 'Not configured' },
  disconnected:   { color: 'var(--danger)',  label: 'Disconnected' },
}

export function DataSourceHealth() {
  const [health, setHealth] = useState<Health | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Health | null) => setHealth(d))
      .catch(() => setHealth(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Skeleton className="h-40 rounded-lg" style={{ background: 'var(--bg-elevated)' }} />
  if (!health) return null

  return (
    <div className="card-base overflow-hidden">
      <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
        <p className="section-label">Data Sources &amp; System Health</p>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>env: {health.environment}</span>
      </div>
      <div>
        {health.sources.map((s, i) => {
          const st = STATUS_STYLE[s.status] ?? { color: 'var(--text-tertiary)', label: s.status }
          return (
            <div key={s.key} className="px-5 py-3" style={{ borderBottom: i < health.sources.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div className="flex items-center justify-between gap-3">
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: st.color }} />
                  <span style={{ fontSize: '12px', color: st.color, fontWeight: 600 }}>{st.label}</span>
                </span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{s.role}</p>
              <p style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{s.detail}</p>
              {s.error && <p style={{ fontSize: '11.5px', color: 'var(--danger)', marginTop: '3px' }}>⚠ {s.error}</p>}
            </div>
          )
        })}
      </div>
      <div className="px-5 py-3" style={{ background: 'var(--bg-elevated)', display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
        <span style={{ color: health.write_mode_enabled ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>
          Write mode: {health.write_mode_enabled ? 'ON' : 'OFF'}
        </span>
        <span style={{ color: health.owner_email_set ? 'var(--text-secondary)' : 'var(--warning)' }}>
          Owner email: {health.owner_email_set ? 'set' : 'NOT set'}
        </span>
      </div>
    </div>
  )
}
