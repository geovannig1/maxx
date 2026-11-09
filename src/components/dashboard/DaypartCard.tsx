'use client'

import { useEffect, useState } from 'react'
import { DaypartHeatmap, DaypartRow } from '@/components/charts/DaypartHeatmap'

interface DaypartApiResponse {
  data?: DaypartRow[]
  error?: string
}

export function DaypartCard() {
  const [rows, setRows] = useState<DaypartRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/daypart')
      .then(r => r.json())
      .then((res: DaypartApiResponse) => {
        if (res.error) {
          setError(res.error)
        } else {
          setRows(res.data ?? [])
        }
      })
      .catch(() => setError('Failed to load'))
  }, [])

  if (error) {
    return (
      <div className="card-base p-5">
        <p className="section-label" style={{ marginBottom: '8px' }}>Best Hours — Last 60 Days</p>
        <p style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Could not load daypart data.</p>
      </div>
    )
  }

  if (rows === null) {
    return (
      <div className="card-base p-5">
        <p className="section-label" style={{ marginBottom: '8px' }}>Best Hours — Last 60 Days</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '24px 0' }}>
          <div
            style={{
              width: '16px',
              height: '16px',
              borderRadius: '50%',
              border: '2px solid var(--border-focus)',
              borderTopColor: 'var(--accent)',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>Loading…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="card-base p-5">
      <p className="section-label" style={{ marginBottom: '12px' }}>Best Hours — Last 60 Days</p>
      <DaypartHeatmap data={rows} />
      <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '10px' }}>
        Green = low CPA. Focus budget here when you daypart.
      </p>
    </div>
  )
}
