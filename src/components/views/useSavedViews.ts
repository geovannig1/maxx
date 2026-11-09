'use client'

import { useCallback, useEffect, useState } from 'react'

// A saved view captures a table's configurable state so a media buyer can name and switch between
// setups ("High-CPL ads", "Active campaigns by spend"). Persisted to localStorage per table; the
// last-applied view is remembered and re-applied on load so it sticks.

export interface TableViewState {
  columns?: string[] // visible metric keys
  sortKey?: string
  sortDir?: 'asc' | 'desc'
  search?: string
  status?: string // entity status filter (campaigns)
}

export interface SavedView {
  id: string
  name: string
  state: TableViewState
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through */ }
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function useSavedViews(storageKey: string) {
  const viewsKey = `saved-views:${storageKey}`
  const activeKey = `saved-views-active:${storageKey}`
  const [views, setViews] = useState<SavedView[]>([])
  const [activeId, setActiveIdState] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect --
       One-time SSR-safe hydration from localStorage. It must run in an effect: reading localStorage in
       useState's initializer would diverge from the server render and cause a hydration mismatch. */
    try {
      const rawV = localStorage.getItem(viewsKey)
      if (rawV) {
        const arr = JSON.parse(rawV)
        if (Array.isArray(arr)) setViews(arr.filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string'))
      }
      const a = localStorage.getItem(activeKey)
      if (a) setActiveIdState(a)
    } catch { /* ignore corrupt storage */ }
    setLoaded(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [viewsKey, activeKey])

  const persist = useCallback((next: SavedView[]) => {
    setViews(next)
    try { localStorage.setItem(viewsKey, JSON.stringify(next)) } catch { /* quota / disabled */ }
  }, [viewsKey])

  const setActive = useCallback((id: string | null) => {
    setActiveIdState(id)
    try {
      if (id) localStorage.setItem(activeKey, id); else localStorage.removeItem(activeKey)
    } catch { /* ignore */ }
  }, [activeKey])

  const saveView = useCallback((name: string, state: TableViewState): SavedView => {
    const view: SavedView = { id: newId(), name: name.trim() || 'Untitled', state }
    persist([...views, view])
    setActive(view.id)
    return view
  }, [views, persist, setActive])

  const updateView = useCallback((id: string, state: TableViewState) => {
    persist(views.map((v) => (v.id === id ? { ...v, state } : v)))
  }, [views, persist])

  const removeView = useCallback((id: string) => {
    persist(views.filter((v) => v.id !== id))
    if (activeId === id) setActive(null)
  }, [views, persist, activeId, setActive])

  return { views, activeId, loaded, saveView, updateView, removeView, setActive }
}
