'use client'

import { useEffect } from 'react'

export default function DashboardError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    // The server retains diagnostic context; this boundary deliberately avoids exposing it to the owner.
    void error
  }, [error])

  return (
    <section className="card-base max-w-xl p-6" role="alert" aria-labelledby="dashboard-error-title">
      <h1 id="dashboard-error-title" className="text-lg">This dashboard could not load</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        No performance conclusion has been shown. Try again; if this continues, review Diagnostics.
      </p>
      <div className="mt-5 flex gap-3">
        <button type="button" className="min-h-11 rounded-md px-4 text-sm font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }} onClick={reset}>
          Try again
        </button>
        <a href="/diagnostics" className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
          Open Diagnostics
        </a>
      </div>
    </section>
  )
}
