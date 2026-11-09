'use client'

import { businessDisplayName } from '@/config/business-display'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobileNav } from './MobileNavContext'
import { NAV } from './nav-config'
import { withGlobalControlParams } from '@/lib/use-global-controls'

// ── NavItem component ──────────────────────────────────────────────────────

interface NavItemProps {
  href: string
  icon: React.ElementType
  label: string
  badge?: number
}

function NavItem({ href, icon: Icon, label, badge }: NavItemProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { setOpen } = useMobileNav()
  const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(href + '/'))
  const [hovered, setHovered] = useState(false)

  return (
    <Link
      href={withGlobalControlParams(href, searchParams)}
      aria-current={active ? 'page' : undefined}
      onClick={() => setOpen(false)}
      className="relative flex items-center gap-2.5 px-3 rounded-[9px] text-[13px] font-medium transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
      style={{
        minHeight: 44,
        color: active ? 'var(--sidebar-text-active)' : hovered ? 'var(--text-primary)' : 'var(--sidebar-text)',
        background: active ? 'var(--sidebar-active)' : hovered ? 'var(--sidebar-hover)' : 'transparent',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      )}
      <Icon
        className="w-4 h-4 shrink-0"
        style={{ color: active ? 'var(--accent)' : 'var(--text-disabled)' }}
      />
      <span className="flex-1 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span
          className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center shrink-0"
          style={{ background: 'var(--warning)' }}
        >
          {badge}
        </span>
      )}
    </Link>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────

/** `accountReady` false: no ad account exists yet (setup incomplete or no first sync), so the review
 *  badges are not polled; their APIs could only answer "not found". */
export function Sidebar({ accountReady = true }: { accountReady?: boolean } = {}) {
  const { open, setOpen } = useMobileNav()
  const panelRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const [isMobile, setIsMobile] = useState(false)
  // Two distinct approval systems, each badged on the page that actions it:
  //   change_requests (budget/status changes)    → /changes   (the ChangeReviewList)
  //   pending_approvals (creative/test launches)  → /approvals (the ApprovalsQueue)
  // /briefs is the brief LIBRARY, not a queue — it no longer carries the approval badge.
  const [changeCount, setChangeCount] = useState(0)
  const [approvalCount, setApprovalCount] = useState(0)
  // Inbox badge = URGENT only (unresolved critical alerts). Approvals/changes carry their own
  // badges in the REVIEW group, so counting them here would double-badge the same work.
  const [inboxCount, setInboxCount] = useState<number | null>(null)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)')
    const update = () => setIsMobile(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    if (!accountReady) return
    fetch('/api/changes?status=pending')
      .then(r => r.json())
      .then((d: { change_requests?: unknown[] }) => setChangeCount(d.change_requests?.length ?? 0))
      .catch(() => {})
    fetch('/api/approvals')
      .then(r => r.json())
      .then((d: { count?: number }) => setApprovalCount(d.count ?? 0))
      .catch(() => {})
    fetch('/api/alerts?severity=critical&is_resolved=false')
      .then(r => r.json())
      .then((d: { total?: unknown }) => setInboxCount(typeof d.total === 'number' && Number.isSafeInteger(d.total) && d.total >= 0 ? d.total : null))
      .catch(() => setInboxCount(null))
  }, [accountReady])

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const panel = panelRef.current
    let focusFrame: number | null = null
    let focusFallback: number | null = null

    const stopOpeningFocus = () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
      if (focusFallback !== null) window.clearTimeout(focusFallback)
      panel?.removeEventListener('transitionend', onTransitionEnd)
    }
    const focusFirstVisibleControl = () => {
      const focusable = panel?.querySelector<HTMLElement>('a[href], button:not([disabled])')
      if (!focusable || getComputedStyle(focusable).visibility === 'hidden') return
      stopOpeningFocus()
      focusable?.focus()
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === panel) focusFirstVisibleControl()
    }
    panel?.addEventListener('transitionend', onTransitionEnd)
    focusFallback = window.setTimeout(focusFirstVisibleControl, 250)
    focusFrame = window.requestAnimationFrame(focusFirstVisibleControl)

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'))
      if (nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      stopOpeningFocus()
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus()
    }
  }, [open, setOpen])

  return (
    <>
      {/* Mobile backdrop — tap to close the drawer (desktop ≥lg never shows this). */}
      {open && (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden />
      )}
      <aside
        ref={panelRef}
        id="primary-nav"
        role={isMobile && open ? 'dialog' : undefined}
        aria-modal={isMobile && open ? true : undefined}
        aria-hidden={isMobile && !open ? true : undefined}
        inert={isMobile && !open ? true : undefined}
        aria-label="Primary navigation"
        className={cn(
          'w-[228px] shrink-0 flex flex-col h-full overflow-hidden fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full max-lg:invisible max-lg:pointer-events-none',
        )}
        style={{ background: 'var(--sidebar-bg)', borderRight: '1px solid var(--sidebar-border)' }}
      >
      {/* Brand block */}
      <div className="px-4 pt-5 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3">
          <div style={{
            width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'var(--shadow-card)',
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9.5 1.5L4 9.5H8L6.5 14.5L13 6.5H9L9.5 1.5Z" fill="white" fillOpacity="0.95"/>
            </svg>
          </div>
          <div className="min-w-0">
            <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
              Maxx
            </p>
            <p style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-tertiary)', lineHeight: 1.3, marginTop: '1px' }}>
              {businessDisplayName()}
            </p>
          </div>
        </div>
      </div>

      {/* Scrollable nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-1" aria-label="Owner navigation">
        {NAV.map((section, si) => (
          <div key={si} className={si > 0 ? 'pt-1' : ''}>
            {section.title && (
              <p
                className="px-3 mb-1 mt-4 text-[10px] font-bold uppercase tracking-[0.1em]"
                style={{ color: 'var(--sidebar-label)' }}
              >
                {section.title}
              </p>
            )}
            <div className="space-y-1">
              {section.items.map(({ label, href, icon, children }) => (
                <div key={href}>
                  <NavItem
                    href={href}
                    icon={icon}
                    label={label}
                    badge={href === '/changes' ? changeCount : href === '/approvals' ? approvalCount : href === '/inbox' ? inboxCount ?? undefined : undefined}
                  />
                  {children && children.length > 0 && (
                    <div className="space-y-1 mt-1" style={{ paddingLeft: 18 }} data-nav-children={href}>
                      {children.map((child) => <NavItem key={child.href} href={child.href} icon={child.icon} label={child.label} />)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom block */}
      <div className="px-3 py-4 space-y-0.5" style={{ borderTop: '1px solid var(--border)' }}>
        {/* Removed: a "Maxx active / 7d sync" row whose green pulsing dot and text were hardcoded
            literals — no state, no fetch, no prop — so it reported a healthy, recently synced system on
            a dead account. Real sync state is in the Topbar and on Settings. */}

        {/* Sign out */}
        <SignOutButton />
      </div>
      </aside>
    </>
  )
}

// ── SignOutButton ──────────────────────────────────────────────────────────

// Session cookies are HttpOnly, so sign-out is a same-origin form POST to the server route, which
// revokes the session, clears the cookies and redirects to /login (src/app/auth/signout/route.ts).
function SignOutButton() {
  const [hovered, setHovered] = useState(false)
  return (
    <form action="/auth/signout" method="post">
      <button
        type="submit"
        className="relative w-full flex items-center gap-2.5 px-3 rounded-[9px] text-[13px] font-medium transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
        style={{
          minHeight: 44,
          color: hovered ? 'var(--text-primary)' : 'var(--sidebar-text)',
          background: hovered ? 'var(--sidebar-hover)' : 'transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <LogOut className="w-4 h-4 shrink-0" style={{ color: 'var(--text-disabled)' }} />
        <span>Sign out</span>
      </button>
    </form>
  )
}
