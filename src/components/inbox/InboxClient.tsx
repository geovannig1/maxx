'use client'

// The single Action Inbox surface. Server shell (page.tsx) computes the review-queue counts and passes
// them in; this island fetches the alert + task rows client-side (reusing the old pages' fetch + PATCH
// verbs verbatim), classifies everything through the pure groupInboxItems(), and lays out the four
// sections in canonical owner triage order: Urgent → Needs decision → Manual work →
// Waiting / blocked → Informational / resolved.

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { XCircle, CheckSquare, ClipboardCheck, Info, ChevronRight, Clock3 } from 'lucide-react'
import { toast } from 'sonner'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { AlertCard } from './AlertCard'
import { TaskCard, PRIORITY_ORDER, PRIORITY_CONFIG } from './TaskCard'
import { groupInboxItems, type InboxAlert, type InboxTask } from '@/lib/inbox/group'
import type { AttentionItem } from '@/lib/dashboard/attention'

interface Props {
  reviewItems: AttentionItem[]
  initialShowResolved: boolean
  notificationOnly?: boolean
}

export function InboxClient({ reviewItems, initialShowResolved, notificationOnly = false }: Props) {
  const [alerts, setAlerts] = useState<InboxAlert[]>([])
  const [resolvedAlerts, setResolvedAlerts] = useState<InboxAlert[]>([])
  const [tasks, setTasks] = useState<InboxTask[]>([])
  const [loading, setLoading] = useState(true)
  const [alertsError, setAlertsError] = useState<string | null>(null)
  const [tasksError, setTasksError] = useState<string | null>(null)
  const [resolving, setResolving] = useState<Set<string>>(new Set())
  const [updating, setUpdating] = useState<Set<string>>(new Set())
  const [showResolved, setShowResolved] = useState(initialShowResolved)
  const [resolvedLoaded, setResolvedLoaded] = useState(false)

  // Active alerts (all severities) — same endpoint/shape the old Alerts page used.
  const fetchAlerts = useCallback(async () => {
    setAlertsError(null)
    try {
      const res = await fetch('/api/alerts?resolved=false', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setAlerts(data.alerts ?? [])
      } else {
        setAlertsError('Failed to load alerts.')
      }
    } catch {
      setAlertsError('Failed to load alerts.')
    }
  }, [])

  // Open / in-progress tasks — same endpoint/shape the old Tasks page used.
  const fetchTasks = useCallback(async () => {
    setTasksError(null)
    try {
      const res = await fetch('/api/tasks?status=open,in_progress', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setTasks(data.data ?? [])
      } else {
        setTasksError('Failed to load tasks.')
      }
    } catch {
      setTasksError('Failed to load tasks.')
    }
  }, [])

  // Resolved alerts are lazy-loaded the first time the Informational toggle is switched on.
  const fetchResolved = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts?resolved=true', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setResolvedAlerts(data.alerts ?? [])
        setResolvedLoaded(true)
      }
    } catch {
      /* silent — the resolved toggle just shows an empty state */
    }
  }, [])

  useEffect(() => {
    // Defer past the synchronous effect tick so the fetchers' setState isn't synchronous-in-effect.
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      setLoading(true)
      await Promise.all([fetchAlerts(), fetchTasks()])
      if (active) setLoading(false)
    })()
    return () => { active = false }
  }, [fetchAlerts, fetchTasks])

  useEffect(() => {
    // Lazy-load resolved alerts the first time the toggle is switched on. Deferred past the synchronous
    // effect tick so fetchResolved's setState isn't synchronous-in-effect (matches the fetchers above).
    if (!showResolved || resolvedLoaded) return
    let active = true
    void (async () => { await Promise.resolve(); if (active) await fetchResolved() })()
    return () => { active = false }
  }, [showResolved, resolvedLoaded, fetchResolved])

  async function handleResolve(id: string) {
    setResolving((s) => new Set(s).add(id))
    try {
      const res = await fetch(`/api/alerts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      })
      if (res.ok) {
        toast.success('Alert resolved')
        setAlerts((prev) => prev.filter((a) => a.id !== id))
      } else {
        toast.error('Failed to resolve alert')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setResolving((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }

  async function handleStatusChange(id: string, status: string) {
    setUpdating((s) => new Set(s).add(id))
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.ok) {
        toast.success('Task updated')
        setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
      } else {
        toast.error('Failed to update task')
      }
    } catch {
      toast.error('Network error')
    } finally {
      setUpdating((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
    }
  }

  const combinedAlerts = showResolved ? [...alerts, ...resolvedAlerts] : alerts
  const groups = groupInboxItems({ alerts: combinedAlerts, tasks, attention: reviewItems })
  const openManualTasks = groups.manual.filter((t) => t.status === 'open')
  const waitingTasks = groups.manual.filter((t) => t.status === 'in_progress')
  const tasksByPriority = (items: InboxTask[]) => PRIORITY_ORDER
    .map((p) => ({ priority: p, items: items.filter((t) => t.priority === p) }))
    .filter((g) => g.items.length > 0)
  const manualByPriority = tasksByPriority(openManualTasks)
  const waitingByPriority = tasksByPriority(waitingTasks)
  const informationalCount = groups.informational.info.length + (showResolved ? groups.informational.resolved.length : 0)

  // `/inbox` remains a legacy notification surface only. Owner decisions, manual work, and outcome
  // review live in `/decisions`; alert acknowledgement here never grants action authority.
  if (notificationOnly) {
    return (
      <div className="space-y-8">
        <Section icon={XCircle} title="Active notifications" count={groups.urgent.length + groups.informational.info.length}>
          {loading ? <AlertSkeletons /> : alertsError ? (
            <ErrorState title="Couldn't load alerts" onRetry={fetchAlerts} />
          ) : groups.urgent.length + groups.informational.info.length === 0 ? (
            <EmptyState icon={Info} tone="good" title="No active notifications" description="No unresolved alert notifications are waiting." />
          ) : (
            <div className="space-y-3">
              {[...groups.urgent, ...groups.informational.info].map((alert) => (
                <AlertCard key={alert.id} alert={alert} onResolve={handleResolve} resolving={resolving.has(alert.id)} />
              ))}
            </div>
          )}
        </Section>
        <Section icon={Info} title="Resolved notifications" count={showResolved ? groups.informational.resolved.length : 0}>
          <button
            onClick={() => setShowResolved((value) => !value)}
            className="text-xs font-medium rounded-lg px-3"
            style={{ color: 'var(--accent)', minHeight: 44 }}
          >
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
          {showResolved && (
            <div className="space-y-3 mt-3">
              {groups.informational.resolved.map((alert) => (
                <AlertCard key={alert.id} alert={alert} onResolve={handleResolve} resolving={false} />
              ))}
            </div>
          )}
        </Section>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* 1 — Urgent */}
      <Section icon={XCircle} title="Urgent" count={groups.urgent.length}>
        {loading ? (
          <AlertSkeletons />
        ) : alertsError ? (
          <ErrorState title="Couldn't load alerts" onRetry={fetchAlerts} />
        ) : groups.urgent.length === 0 ? (
          <EmptyState
            icon={XCircle}
            tone="good"
            title="No urgent issues"
            description="No critical or warning alerts — Maxx is watching."
          />
        ) : (
          <div className="space-y-3">
            {groups.urgent.map((alert) => (
              <AlertCard key={alert.id} alert={alert} onResolve={handleResolve} resolving={resolving.has(alert.id)} />
            ))}
          </div>
        )}
      </Section>

      {/* 2 — Needs decision */}
      <Section icon={ClipboardCheck} title="Needs decision" count={groups.review.length}>
        {groups.review.length === 0 ? (
          <EmptyState
            icon={ClipboardCheck}
            tone="good"
            title="No decisions needed"
            description="No approvals, changes, outcomes, or conflicts waiting on you."
          />
        ) : (
          <div className="space-y-2">
            {groups.review.map((item) => (
              <ReviewRow key={item.key} item={item} />
            ))}
          </div>
        )}
      </Section>

      {/* 3 — Manual work */}
      <Section icon={CheckSquare} title="Manual work" count={openManualTasks.length}>
        {loading ? (
          <AlertSkeletons />
        ) : tasksError ? (
          <ErrorState title="Couldn't load tasks" onRetry={fetchTasks} />
        ) : openManualTasks.length === 0 ? (
          <EmptyState
            icon={CheckSquare}
            tone="good"
            title="No manual work"
            description="No open owner-review or execution-eligible tasks are waiting for manual work."
          />
        ) : (
          <div className="space-y-4">
            {manualByPriority.map(({ priority, items }) => {
              const config = PRIORITY_CONFIG[priority]
              return (
                <div key={priority} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="section-label" style={config.badgeStyle} data-priority-badge>
                      {config.label}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {items.length} task{items.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {items.map((task) => (
                      <TaskCard key={task.id} task={task} onStatusChange={handleStatusChange} isUpdating={updating.has(task.id)} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {/* 4 — Waiting / blocked */}
      <Section icon={Clock3} title="Waiting / blocked" count={waitingTasks.length}>
        {loading ? (
          <AlertSkeletons />
        ) : tasksError ? (
          <ErrorState title="Couldn't load tasks" onRetry={fetchTasks} />
        ) : waitingTasks.length === 0 ? (
          <EmptyState
            icon={Clock3}
            tone="good"
            title="Nothing waiting"
            description="No in-progress or blocked owner tasks are waiting on external follow-up."
          />
        ) : (
          <div className="space-y-4">
            {waitingByPriority.map(({ priority, items }) => {
              const config = PRIORITY_CONFIG[priority]
              return (
                <div key={priority} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="section-label" style={config.badgeStyle} data-priority-badge>
                      {config.label}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      {items.length} waiting task{items.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {items.map((task) => (
                      <TaskCard key={task.id} task={task} onStatusChange={handleStatusChange} isUpdating={updating.has(task.id)} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Section>

      {/* 5 — Informational / resolved */}
      <Section icon={Info} title="Informational / resolved" count={informationalCount}>
        {loading ? (
          <AlertSkeletons />
        ) : (
          <div className="space-y-3">
            {groups.informational.info.length === 0 ? (
              <EmptyState
                icon={Info}
                tone="good"
                title="Nothing informational"
                description="No informational alerts right now."
              />
            ) : (
              groups.informational.info.map((alert) => (
                <AlertCard key={alert.id} alert={alert} onResolve={handleResolve} resolving={resolving.has(alert.id)} />
              ))
            )}

            {/* Resolved items behind a toggle */}
            <button
              onClick={() => setShowResolved((v) => !v)}
              className="text-xs font-medium transition-colors cursor-pointer rounded-lg"
              style={{ color: 'var(--accent-hover)', minHeight: 44, padding: '0 10px' }}
            >
              {showResolved ? 'Hide resolved' : 'Show resolved'}
            </button>
            {showResolved && (
              groups.informational.resolved.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  No alerts have been resolved yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {groups.informational.resolved.map((alert) => (
                    <AlertCard key={alert.id} alert={alert} onResolve={handleResolve} resolving={resolving.has(alert.id)} />
                  ))}
                </div>
              )
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: React.ElementType
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        {count > 0 && (
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '1px solid var(--border)' }}
          >
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function ReviewRow({ item }: { item: AttentionItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center justify-between gap-3 px-4 rounded-lg transition-colors"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', minHeight: 44 }}
    >
      <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
      <ChevronRight className="w-4 h-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
    </Link>
  )
}

function AlertSkeletons() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-[88px] rounded-xl animate-pulse"
          style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
        />
      ))}
    </div>
  )
}
