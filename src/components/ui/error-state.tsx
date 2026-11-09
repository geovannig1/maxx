'use client'

import { AlertTriangle, RotateCw } from 'lucide-react'

// A distinct error state so a failed/500 fetch no longer falls through to the "empty" state
// ("No data — adjust filters"), which misleads users into thinking it's a filter problem.
export function ErrorState({
  title = "Couldn't load this data",
  message = 'The request failed. This is usually a temporary sync or connection issue, not a problem with your filters.',
  onRetry,
}: {
  title?: string
  message?: string
  onRetry?: () => void
}) {
  return (
    <div
      className="card-base"
      role="alert"
      style={{ padding: '28px 24px', textAlign: 'center' }}
    >
      <div
        style={{
          width: '44px', height: '44px', borderRadius: '12px', margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
        }}
      >
        <AlertTriangle style={{ width: '20px', height: '20px', color: 'var(--danger)' }} />
      </div>
      <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</p>
      <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', maxWidth: '380px', margin: '6px auto 0' }}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          type="button"
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '14px',
            minHeight: 44, padding: '0 16px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600,
            color: 'var(--on-accent)', background: 'var(--accent)', border: 'none', cursor: 'pointer',
          }}
        >
          <RotateCw style={{ width: '13px', height: '13px' }} /> Retry
        </button>
      )}
    </div>
  )
}
