'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search, RefreshCw, CornerDownLeft } from 'lucide-react'
import { ALL_NAV_ITEMS } from './nav-config'

// ⌘K command palette (cockpit IA — "shortcuts accelerate, don't gate"). Scope:
// jump to any destination + Sync now. Every action is also visibly clickable elsewhere. Source/range
// commands can join once the global control is wired and pages actually read it.

interface Command {
  id: string
  label: string
  hint: string
  icon: React.ElementType
  keywords?: string
  run: () => void
}

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  const openPalette = useCallback(() => { setQuery(''); setActive(0); setOpen(true) }, [])
  const closePalette = useCallback(() => setOpen(false), [])

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = ALL_NAV_ITEMS.map((it) => ({
      id: `nav:${it.href}`,
      label: it.label,
      hint: 'Go to',
      icon: it.icon,
      keywords: it.href,
      run: () => router.push(it.href),
    }))
    const actions: Command[] = [
      {
        id: 'act:sync',
        label: 'Sync now',
        hint: 'Action',
        icon: RefreshCw,
        keywords: 'refresh fetch update data',
        run: () => {
          void fetch('/api/sync', { method: 'POST' })
            .then((r) => toast[r.ok ? 'success' : 'error'](r.ok ? 'Sync started' : 'Could not start sync'))
            .catch(() => toast.error('Could not start sync'))
        },
      },
    ]
    return [...nav, ...actions]
  }, [router])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.hint} ${c.keywords ?? ''}`.toLowerCase().includes(q))
  }, [commands, query])

  // ⌘K / Ctrl+K opens; Esc closes. Listener only — no setState-in-effect.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openPalette()
      } else if (e.key === 'Escape') {
        closePalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPalette, closePalette])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    inputRef.current?.focus()

    function onDialogKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closePalette()
        return
      }
      const isTabKey = event.key === 'Tab'
      if (!isTabKey) return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]'),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onDialogKey)
    return () => {
      document.removeEventListener('keydown', onDialogKey)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus()
    }
  }, [open, closePalette])

  function exec(cmd: Command | undefined) {
    if (!cmd) return
    closePalette()
    cmd.run()
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); exec(filtered[active]) }
  }

  return (
    <>
      {/* Trigger — also lives in the top bar so the shortcut is discoverable, not gated. */}
      <button
        onClick={openPalette}
        title="Command palette (⌘K)"
        style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          minHeight: '44px', padding: '0 12px', borderRadius: '7px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          color: 'var(--text-tertiary)', fontSize: '12px', cursor: 'pointer',
        }}
      >
        <Search style={{ width: '13px', height: '13px' }} />
        <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>⌘K</span>
      </button>

      {open && (
        <div
          onClick={closePalette}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(4,4,12,0.6)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh',
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal={true}
            aria-labelledby="command-palette-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(560px, 92vw)', maxHeight: '60vh', display: 'flex', flexDirection: 'column',
              background: 'var(--bg-surface)', border: '1px solid var(--border-hover)', borderRadius: '12px',
              boxShadow: '0 24px 60px rgba(16,24,40,0.08)', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
              <Search style={{ width: '16px', height: '16px', color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span id="command-palette-title" className="sr-only">Command palette</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0) }}
                onKeyDown={onInputKey}
                placeholder="Jump to a page or run a command…"
                style={{
                  flex: 1, background: 'transparent', border: 'none', outline: 'none',
                  color: 'var(--text-primary)', fontSize: '14px',
                }}
              />
              <kbd style={{ fontSize: '10px', color: 'var(--text-tertiary)', border: '1px solid var(--border-hover)', borderRadius: '4px', padding: '1px 5px' }}>esc</kbd>
            </div>

            <div style={{ overflowY: 'auto', padding: '6px' }}>
              {filtered.length === 0 ? (
                <div style={{ padding: '20px', textAlign: 'center', fontSize: '13px', color: 'var(--text-tertiary)' }}>
                  No matches for &ldquo;{query}&rdquo;
                </div>
              ) : (
                filtered.map((c, i) => {
                  const Icon = c.icon
                  const isActive = i === active
                  return (
                    <button
                      key={c.id}
                      onClick={() => exec(c)}
                      onMouseEnter={() => setActive(i)}
                      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
                        minHeight: 44, padding: '0 10px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                        background: isActive ? 'rgba(99,102,241,0.18)' : 'transparent',
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)', textAlign: 'left',
                      }}
                    >
                      <Icon style={{ width: '15px', height: '15px', color: isActive ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: '13px' }}>{c.label}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{c.hint}</span>
                      {isActive && <CornerDownLeft style={{ width: '13px', height: '13px', color: 'var(--text-tertiary)' }} />}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
