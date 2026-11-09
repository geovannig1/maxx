'use client'

import { useEffect } from 'react'
import { applyTargetOverrides } from '@/lib/targets/target-ranges'

// Hydrates the browser's ACTIVE target ranges from the saved overrides once per session, so every
// client-side band (table cells, range badges, panels) reflects the Performance-Targets editor.
// On any failure the built-in defaults stay in effect.
export function TargetRangesProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let cancelled = false
    fetch('/api/targets', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.overrides) applyTargetOverrides(d.overrides) })
      .catch(() => { /* keep defaults */ })
    return () => { cancelled = true }
  }, [])
  return <>{children}</>
}
