'use client'

import { useEffect, useRef, useState } from 'react'
import { Bookmark, Plus, Trash2, Check, Save } from 'lucide-react'
import type { SavedView } from './useSavedViews'

// Dropdown to apply / save / update / delete named table views. Self-contained (click-outside),
// matching the ColumnChooser / ExportCsvButton styling.
export function SavedViewsControl({
  views,
  activeId,
  onApply,
  onSaveNew,
  onUpdateActive,
  onDelete,
}: {
  views: SavedView[]
  activeId: string | null
  onApply: (view: SavedView) => void
  onSaveNew: (name: string) => void
  onUpdateActive: () => void
  onDelete: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setNaming(false) }
    }
    if (open) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const active = views.find((v) => v.id === activeId)

  function commitNew() {
    if (name.trim()) onSaveNew(name.trim())
    setName(''); setNaming(false); setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg text-xs transition-colors"
        style={{
          height: 32, padding: '0 12px',
          background: open || active ? 'var(--accent-dim)' : 'var(--bg-input)',
          border: `1px solid ${open || active ? 'var(--accent)' : 'var(--border)'}`,
          color: open || active ? 'var(--accent)' : 'var(--text-secondary)',
          maxWidth: 180,
        }}
        title={active ? `View: ${active.name}` : 'Saved views'}
      >
        <Bookmark className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">{active ? active.name : 'Views'}</span>
        {views.length > 0 && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-tertiary)' }}>{views.length}</span>}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-60 rounded-lg shadow-2xl overflow-hidden" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)' }}>
          <div className="max-h-64 overflow-y-auto py-1">
            {views.length === 0 ? (
              <p className="px-3 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>No saved views yet.</p>
            ) : (
              views.map((v) => (
                <div key={v.id} className="flex items-center group hover:bg-[var(--border)]">
                  <button onClick={() => { onApply(v); setOpen(false) }} className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 text-left">
                    <span className="w-3 shrink-0">{v.id === activeId && <Check className="w-3 h-3" style={{ color: 'var(--accent)' }} />}</span>
                    <span className="text-xs truncate" style={{ color: v.id === activeId ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{v.name}</span>
                  </button>
                  <button onClick={() => onDelete(v.id)} className="px-2 py-1.5 opacity-0 group-hover:opacity-100 transition-opacity" title="Delete view">
                    <Trash2 className="w-3 h-3" style={{ color: 'var(--text-tertiary)' }} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="py-1" style={{ borderTop: '1px solid var(--border)' }}>
            {active && (
              <button onClick={() => { onUpdateActive(); setOpen(false) }} className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--border)]" style={{ color: 'var(--text-secondary)' }}>
                <Save className="w-3 h-3" /> Update &quot;{active.name}&quot;
              </button>
            )}
            {naming ? (
              <div className="px-3 py-1.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitNew(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
                  placeholder="View name…"
                  className="w-full h-7 px-2 rounded-md text-xs focus:outline-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                />
              </div>
            ) : (
              <button onClick={() => setNaming(true)} className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--border)]" style={{ color: 'var(--accent)' }}>
                <Plus className="w-3 h-3" /> Save current as…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
