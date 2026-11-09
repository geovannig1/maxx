'use client'

import { useState, useEffect, useRef } from 'react'
import { Bot, X } from 'lucide-react'
import { MaxxChat } from './MaxxChat'

// Global "Ask Maxx" entry point — a floating button on every page that opens the chat slide-over.
// This is the accessible assistant the product kept pointing at; it replaces the dead "chat in Claude Code"
// guidance. Fixed-position (escapes any stacking context) with a reduced-motion-aware slide.

export function MaxxLauncher({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = panelRef.current?.querySelector<HTMLElement>('button, textarea, a[href]')
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, a[href]'))
      if (nodes.length === 0) return
      const firstNode = nodes[0]
      const lastNode = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === firstNode) {
        e.preventDefault()
        lastNode.focus()
      } else if (!e.shiftKey && document.activeElement === lastNode) {
        e.preventDefault()
        firstNode.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus()
    }
  }, [open])

  // Off by default: no button, no panel, no way to trigger a metered API call.
  if (!enabled) return null

  return (
    <>
      {/* Launcher button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Ask Maxx"
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 40,
            display: 'flex', alignItems: 'center', gap: 8,
            height: 44, padding: '0 16px 0 14px', borderRadius: 999,
            background: 'var(--accent)', color: '#fff', border: 'none',
            boxShadow: 'var(--shadow-panel)', cursor: 'pointer',
            fontSize: 13.5, fontWeight: 600,
          }}
        >
          <Bot className="w-[18px] h-[18px]" />
          Ask Maxx
        </button>
      )}

      {/* Backdrop (click-away) */}
      <div
        onClick={() => setOpen(false)}
        aria-hidden
        style={{
          position: 'fixed', inset: 0, zIndex: 45,
          background: 'rgba(16,24,40,0.18)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 180ms ease',
        }}
      />

      {/* Slide-over panel */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-hidden={open ? undefined : true}
        inert={open ? undefined : true}
        aria-label="Maxx assistant"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 46,
          width: 'min(440px, 100vw)',
          background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-panel)',
          display: 'flex', flexDirection: 'column',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        className="motion-reduce:transition-none"
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-dim)', border: '1px solid var(--border-focus)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Bot className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1 }}>Maxx</p>
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Your media buyer: it drafts, you approve</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close Maxx assistant" style={{ width: 44, height: 44, borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <X className="w-4 h-4" />
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, padding: '10px 16px 16px' }}>
          {/* Mount the chat only when open so it doesn't run/fetch in the background. */}
          {open && <MaxxChat />}
        </div>
      </aside>
    </>
  )
}
