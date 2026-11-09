'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'

// One outcome source's on/off switch on the sources screen. PATCH /api/outcomes/sources/<id> is
// owner-only, same-origin and rate limited; the button reflects only what the server confirmed.

export function OutcomeSourceToggle({ id, label, enabled: initial }: { id: string; label: string; enabled: boolean }) {
  const [enabled, setEnabled] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/outcomes/sources/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !enabled }),
      })
      const body = await res.json().catch(() => null) as { source?: { enabled: boolean }; error?: string } | null
      if (!res.ok || typeof body?.source?.enabled !== 'boolean') throw new Error(body?.error ?? 'The change was not saved.')
      setEnabled(body.source.enabled)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The change was not saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant={enabled ? 'outline' : 'default'} disabled={busy} aria-pressed={enabled}
        aria-label={`${enabled ? 'Disable' : 'Enable'} ${label}`} onClick={toggle}>
        {busy ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
      </Button>
      {error ? <span role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span> : null}
    </div>
  )
}
