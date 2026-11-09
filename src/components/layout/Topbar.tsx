'use client'

import { businessDisplayName, businessInitials } from '@/config/business-display'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { RefreshCw, Bell, Menu, ShieldCheck } from 'lucide-react'
import { useMobileNav } from './MobileNavContext'
import { WriteModeBadge } from '@/components/ui/badges'
import { CommandPalette } from './CommandPalette'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { DateRangeControl } from '@/components/ui/DateRangeControl'
import { showsGlobalTrafficSource, useGlobalControls } from '@/lib/use-global-controls'
import type { TrafficSource } from '@/lib/ga4/client'
import { UNRESOLVED_CRITICAL_ALERT_FILTER } from '@/lib/decisions/queue-v2'

export { showsGlobalTrafficSource } from '@/lib/use-global-controls'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard':       'Overview',
  '/recommendations': 'Recommendations',
  '/decisions':       'Decisions',
  '/performance':     'Ads',
  '/activity':        'Activity',
  '/reports':         'Reports',
  '/inbox':       'Inbox',
  '/alerts':      'Alerts',
  '/tasks':       'Tasks',
  '/flags':       'Flags',
  '/campaigns':   'Campaigns',
  '/adsets':      'Ad Sets',
  '/ads':         'Ads',
  '/maxx':        'Ask Maxx',
  '/briefs':      'Briefs',
  '/tests':       'Tests',
  '/competitors': 'Competitors',
  '/signals':     'Signals',
  '/settings':    'Settings',
  '/launch':      'Launch',
  '/approvals':   'Approvals',
  '/create':      'Create',
  '/hooks':       'Hooks',
  '/explorer':    'Explorer',
  '/discovery':   'Discovery',
  '/changes':     'Changes',
  '/conversions': 'Conversions',
  '/diagnostics': 'Diagnostics & Trust',
  '/learnings':   'Learnings',
  // Tab destinations (sub-routes of Performance/Activity). Exact keys so getTitle shows the tab's own
  // title instead of falling through startsWith() to the parent section ('Performance'/'Activity').
  '/performance/campaigns': 'Campaigns',
  '/performance/adsets':    'Ad Sets',
  '/performance/ads':       'Ads',
  '/creative':              'Creative',
  '/truth':                 'Truth',
  '/experiments':           'Experiments',
  '/performance/segments':  'Segments',
  '/performance/flags':     'Flags',
  '/activity/reports':      'Reports',
  '/activity/change-log':   'Decision history',
  '/activity/learnings':    'Learnings',
}

function getTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname]
  for (const [key, val] of Object.entries(PAGE_TITLES)) {
    if (pathname.startsWith(key + '/')) return val
  }
  return 'Maxx'
}

function formatLastSync(iso: string | null): string {
  if (!iso) return 'Never synced'
  const diff = (Date.now() - new Date(iso).getTime()) / 60000
  if (diff < 1) return 'Just now'
  if (diff < 60) return `${Math.floor(diff)}m ago`
  if (diff < 1440) return `${Math.floor(diff / 60)}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const SOURCE_OPTIONS: { value: TrafficSource; label: string; title: string }[] = [
  { value: 'complete', label: 'Complete', title: 'All-source business totals plus traffic and ad delivery' },
  { value: 'paid', label: 'Paid', title: 'GA paid-channel telemetry plus Meta delivery; not paid outcomes' },
  { value: 'organic', label: 'Organic', title: 'GA non-paid channel telemetry; not ledger revenue' },
]

export const COMPACT_SOURCE_CLASS =
  'inline-flex xl:hidden items-center rounded-lg text-[12px] font-semibold focus-within:ring-2 focus-within:ring-indigo-400/60'

export const SEGMENTED_SOURCE_CLASS = 'hidden xl:inline-flex rounded-lg p-0.5'

/** The pill must say how OLD THE DATA is, not just when a sync last ran — "synced 10m ago" was a
 *  sync-attempt clock that stayed green over week-old rows. "Data thru Jul 12 · 25m ago" says both. */
function formatSyncPill(dataThrough: string | null, lastSync: string | null): string {
  const syncPart = formatLastSync(lastSync)
  if (!dataThrough) return syncPart
  const d = new Date(dataThrough + 'T00:00:00Z')
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `Data thru ${day} · ${syncPart}`
}

export const CRITICAL_ALERT_QUEUE_HREF = `/decisions?filter=${UNRESOLVED_CRITICAL_ALERT_FILTER}&legacy=inbox`
/** `not_ready`: no ad account exists yet (setup incomplete or no first sync), so nothing is polled. */
type CriticalAlertStatus = 'checking' | 'available' | 'unavailable' | 'not_ready'

/** The alerts route paginates rows, so its `total` is the only count for the full filtered population. */
export function unresolvedCriticalAlertTotal(response: unknown): number | null {
  if (!response || typeof response !== 'object') return null
  const total = (response as { total?: unknown }).total
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 ? total : null
}

export function criticalAlertLabel(status: CriticalAlertStatus, total: number): string {
  if (status === 'not_ready') return 'Alerts start after setup and the first Meta sync — open decision queue'
  if (status !== 'available') return 'Unresolved critical alert status unavailable — open decision queue'
  return total > 0
    ? `${total} unresolved critical alert${total === 1 ? '' : 's'} — open decision queue`
    : 'No unresolved critical alerts — open decision queue'
}

/** 'checking' is the pre-fetch state. The sync status is fetched client-side, but this component is
 *  server-rendered inside the dashboard layout, so its INITIAL state is what ships in the HTML of every
 *  route. That initial state must not assert anything: 'never' rendered "Never synced" on first paint of
 *  all 32 pages before hydration corrected it. Unknown is not "never". */
type SyncStatus = 'checking' | 'running' | 'error' | 'synced' | 'never'

export function Topbar({ accountReady = true }: { accountReady?: boolean } = {}) {
  const pathname = usePathname()
  const title = getTitle(pathname)
  const showTrafficSource = showsGlobalTrafficSource(pathname)
  const hasReportDateControl = ['/dashboard', '/performance', '/creative', '/reports'].includes(pathname)
  const reportingTrustHref = pathname === '/dashboard' ? '#reporting-trust' : '/dashboard#reporting-trust'
  const { open, setOpen } = useMobileNav()

  // Reporting workspaces provide their date control beside the account context at every width.
  // Other routes retain the chrome control; all consumers share the URL-backed range.
  const { range, source, setRange, setSource, ready: controlsReady, savedReport } = useGlobalControls()

  const [syncing, setSyncing]             = useState(false)
  const [syncStatus, setSyncStatus]       = useState<SyncStatus>('checking')
  const [lastSyncLabel, setLastSyncLabel] = useState('Checking sync…')
  const [criticalAlerts, setCriticalAlerts] = useState<{ status: CriticalAlertStatus; total: number }>({ status: accountReady ? 'checking' : 'not_ready', total: 0 })
  // Write-mode is global, persistent chrome — surfaced here so it's unmissable on every page (was per-page).
  const [writeModeEnabled, setWriteModeEnabled] = useState(false)

  const fetchSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        const lastSync: string | null = data.lastSync ?? null
        const dataThrough: string | null = data.dataThrough ?? null
        const status: string = data.status ?? 'never'
        setSyncStatus(status === 'running' ? 'running' : status === 'error' ? 'error' : lastSync ? 'synced' : 'never')
        setLastSyncLabel(formatSyncPill(dataThrough, lastSync))
        return
      }
      // Fall through: a non-OK response leaves the state unknown, not 'never'.
      setSyncStatus('error')
      setLastSyncLabel('Sync status unavailable')
    } catch {
      // Never leave the pre-fetch placeholder standing — "Checking sync…" forever is its own false claim.
      setSyncStatus('error')
      setLastSyncLabel('Sync status unavailable')
    }
  }, [])

  const fetchCriticalCount = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts?severity=critical&is_resolved=false', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        const total = unresolvedCriticalAlertTotal(data)
        setCriticalAlerts(total === null ? { status: 'unavailable', total: 0 } : { status: 'available', total })
      } else setCriticalAlerts({ status: 'unavailable', total: 0 })
    } catch { setCriticalAlerts({ status: 'unavailable', total: 0 }) }
  }, [])

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setWriteModeEnabled(data.write_mode_enabled === true)
      }
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    // Defer past the synchronous effect tick so the fetchers' setState isn't synchronous-in-effect.
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      await Promise.all([...(savedReport ? [] : [fetchSyncStatus()]), ...(accountReady ? [fetchCriticalCount()] : []), fetchHealth()])
    })()
    return () => { active = false }
  }, [fetchSyncStatus, fetchCriticalCount, fetchHealth, savedReport, accountReady])

  async function handleSync() {
    if (savedReport) return
    setSyncing(true)
    setSyncStatus('running')
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      if (res.ok) setTimeout(fetchSyncStatus, 3000)
      else setSyncStatus('error')
    } catch { setSyncStatus('error') }
    finally { setSyncing(false) }
  }

  const dotColor =
    syncStatus === 'running' ? 'var(--warning)'
    : syncStatus === 'error' ? 'var(--danger)'
    : syncStatus === 'synced' ? 'var(--success)'
    : 'var(--border-strong)'

  return (
    <header className="px-2 sm:px-4 lg:px-7" style={{
      minHeight: '60px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      {/* Left: hamburger (mobile only) + page title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        <button
          onClick={() => setOpen(!open)}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="primary-nav"
          className="lg:hidden"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: '44px', height: '44px', marginLeft: '-6px', borderRadius: '10px',
            color: 'var(--text-secondary)', background: 'transparent', border: 'none', cursor: 'pointer',
          }}
        >
          <Menu style={{ width: '18px', height: '18px' }} />
        </button>
        <span className="hidden sm:inline" style={{
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: '-0.015em',
        }}>
          {title}
        </span>
      </div>

      {/* Right controls */}
      <div className="gap-1 sm:gap-2 lg:gap-3" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {/* Theme — hidden on small screens, where the header has no room to spare */}
        <div className="hidden sm:block"><ThemeToggle /></div>
        {/* Global date range — compact trigger + popover so the header never wraps to a second line
            (hidden on small screens — pages keep their own controls there) */}
        {controlsReady && !hasReportDateControl && !savedReport && (
          <div className="hidden md:block">
            <DateRangeControl value={range} onChange={setRange} compact />
          </div>
        )}
        {controlsReady && showTrafficSource && (
          <label
            className={COMPACT_SOURCE_CLASS}
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              minHeight: 44,
            }}
          >
            <span className="sr-only">Traffic source</span>
            <select
              aria-label="Traffic source"
              title="Traffic source"
              value={source}
              onChange={(event) => setSource(event.target.value as TrafficSource)}
              style={{
                minHeight: 44,
                maxWidth: '112px',
                paddingLeft: '10px',
                paddingRight: '8px',
                border: 'none',
                borderRadius: '8px',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
              }}
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {controlsReady && showTrafficSource && (
          <div
            className={SEGMENTED_SOURCE_CLASS}
            style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}
            aria-label="Traffic source"
          >
            {SOURCE_OPTIONS.map((option) => {
              const active = option.value === source
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setSource(option.value)}
                  title={option.title}
                  aria-pressed={active}
                  className="rounded-md text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                  style={{
                    minHeight: 44,
                    padding: '0 12px',
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    border: active ? '1px solid var(--border-focus)' : '1px solid transparent',
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        )}

        {/* Sync status */}
        {savedReport ? <span className="text-xs text-[var(--text-secondary)]" title="Dates and data are fixed. Open current report to change dates or sync.">
          Saved report<span className="sr-only">. Dates and data are fixed.</span>
        </span> : !hasReportDateControl && <div className="hidden lg:flex" style={{ alignItems: 'center', gap: '6px' }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%',
            backgroundColor: dotColor, flexShrink: 0,
          }} />
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            {syncStatus === 'running' ? 'Syncing…' : lastSyncLabel}
          </span>
        </div>}

        {/* Sync button */}
        {!savedReport && !hasReportDateControl && <div className="hidden lg:block">
          <SyncButton syncing={syncing} onClick={handleSync} />
        </div>}

        {/* Divider */}
        <div className="hidden md:block" style={{ width: '1px', height: '20px', backgroundColor: 'var(--border)' }} />

        {/* Global chrome — trust entry + write-mode, persistent on every page (cockpit top bar). */}
        <div>
          <Link
            href={reportingTrustHref}
            aria-label="Open reporting Trust summary"
            title="Reporting Trust"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              minWidth: 44, minHeight: 44, padding: '0 12px', borderRadius: '100px', justifyContent: 'center',
              background: 'var(--accent-dim)', border: '1px solid var(--border-focus)',
              color: 'var(--accent)', fontSize: '12px', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >
            <ShieldCheck style={{ width: '13px', height: '13px' }} /><span className="hidden sm:inline">Trust</span>
          </Link>
        </div>
        <WriteModeBadge enabled={writeModeEnabled} />

        {/* Divider */}
        <div className="hidden md:block" style={{ width: '1px', height: '20px', backgroundColor: 'var(--border)' }} />

        {/* Bell */}
        <div>
          <Link
            href={CRITICAL_ALERT_QUEUE_HREF}
            aria-label={criticalAlertLabel(criticalAlerts.status, criticalAlerts.total)}
            title="Unresolved critical alerts in the decision queue"
            style={{ position: 'relative', width: 44, height: 44, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Bell style={{ width: '15px', height: '15px' }} />
            {criticalAlerts.status === 'available' && criticalAlerts.total > 0 && (
              <span style={{
                position: 'absolute', top: '4px', right: '4px',
                minWidth: '18px', height: '18px', padding: '0 4px', borderRadius: '999px',
                backgroundColor: 'var(--danger)', color: 'white', fontSize: '10px', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }} aria-hidden="true">{criticalAlerts.total > 99 ? '99+' : criticalAlerts.total}</span>
            )}
          </Link>
        </div>

        {/* ⌘K command palette — jump to any destination / run actions. */}
        {!savedReport && <div className="hidden lg:block">
          <CommandPalette />
        </div>}

        {/* Account pill */}
        {pathname !== '/dashboard' && <div className="hidden xl:flex" style={{
          alignItems: 'center', gap: '7px',
          height: '28px', paddingLeft: '10px', paddingRight: '12px',
          borderRadius: '100px',
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
        }}>
          <div style={{
            width: '20px', height: '20px', borderRadius: '50%',
            backgroundColor: 'var(--accent-dim)',
            border: '1px solid var(--border-focus)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '9px', fontWeight: 700, color: 'var(--accent)', flexShrink: 0,
          }}>
            {businessInitials()}
          </div>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            {businessDisplayName()}
          </span>
        </div>}
      </div>
    </header>
  )
}

function SyncButton({ syncing, onClick }: { syncing: boolean; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={syncing}
      style={{
        display: 'flex', alignItems: 'center', gap: '6px',
        minHeight: '44px', paddingLeft: '14px', paddingRight: '14px',
        borderRadius: '6px',
        fontSize: '12.5px', fontWeight: 500,
        backgroundColor: syncing ? 'var(--border-focus)' : hovered ? 'var(--accent-hover)' : 'var(--accent)',
        color: 'var(--on-accent)',
        border: 'none',
        cursor: syncing ? 'not-allowed' : 'pointer',
        transition: 'background-color 100ms',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <RefreshCw style={{ width: '12px', height: '12px' }} className={syncing ? 'animate-spin' : ''} />
      {syncing ? 'Syncing…' : 'Sync'}
    </button>
  )
}
