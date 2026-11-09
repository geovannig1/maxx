'use client'

import { useCallback, useEffect, useState } from 'react'
import { defaultVisibleKeys, type EntityLevel } from '@/lib/metrics/catalog'

// Per-table column visibility, persisted to localStorage so a media buyer's chosen columns stick.
// Initialised with the catalog defaults (deterministic → no hydration mismatch); stored prefs load
// after mount.
export function useColumnVisibility(level: EntityLevel) {
  const storageKey = `metric-cols:${level}`
  const [visible, setVisible] = useState<Set<string>>(() => new Set(defaultVisibleKeys(level)))

  useEffect(() => {
    // One-time SSR-safe hydration from localStorage (can't read it in useState's initializer without a
    // server/client hydration mismatch).
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const arr = JSON.parse(raw)
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (Array.isArray(arr)) setVisible(new Set(arr.filter((k) => typeof k === 'string')))
      }
    } catch { /* ignore corrupt storage */ }
  }, [storageKey])

  const persist = useCallback((next: Set<string>) => {
    setVisible(next)
    try { localStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* quota / disabled */ }
  }, [storageKey])

  const toggle = useCallback((key: string) => {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      try { localStorage.setItem(storageKey, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])

  const reset = useCallback(() => persist(new Set(defaultVisibleKeys(level))), [persist, level])

  // Replace the whole visible set (used when applying a saved view).
  const setVisibleKeys = useCallback((keys: string[]) => persist(new Set(keys)), [persist])

  const isVisible = useCallback((key: string) => visible.has(key), [visible])

  return { visible, isVisible, toggle, reset, setVisibleKeys }
}
