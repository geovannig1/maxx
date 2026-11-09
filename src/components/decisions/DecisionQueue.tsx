'use client'

import { useEffect, useMemo, useState, useTransition, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Clock3, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { ProposalCard } from '@/components/ui/ProposalCard'
import {
  DECISION_QUEUE_VIEWS,
  recommendationDecisionForControl,
  visibleDecisionQueue,
  type DecisionControl,
  type DecisionQueueFilter,
  type DecisionQueueItemV2,
  type DecisionQueueView,
} from '@/lib/decisions/queue-v2'
import {
  AVAILABILITY_LABEL,
  CLAIM_SOURCE_LABEL,
  FRESHNESS_LABEL,
  MATURITY_LABEL,
  RECOMMENDATION_EVIDENCE_VALUE_FORMATTER,
  type RecommendationEvidenceItem,
} from '@/lib/cockpit/contracts'
import { accountTimezone } from '@/config/business-config'

const VIEW_LABEL: Record<DecisionQueueView, string> = {
  needs_review: 'Needs review',
  tracking_repair: 'Tracking repair',
  monitoring: 'Monitoring',
  awaiting_implementation: 'Awaiting implementation',
  outcome_review: 'Outcome review',
  snoozed: 'Snoozed',
}

/**
 * ProposalCard documents `source` as "already in owner-facing words", and this file was passing
 * `item.source` — the raw union 'recommendation' | 'alert' | 'task' | 'outcome' (queue-v2.ts:128).
 * So the eyebrow above every card title read "recommendation", and "outcome" told the owner nothing.
 * That is the same leak the card was written to close, one prop over: a hand-written pass-through is
 * not a label table. Rendered through this map instead, beside the CONTROL_LABEL precedent below.
 */
const SOURCE_LABEL: Record<DecisionQueueItemV2['source'], string> = {
  recommendation: 'Maxx suggests',
  alert: 'Maxx spotted',
  task: 'On your list',
  outcome: 'Result of an earlier call',
}

const CONTROL_LABEL: Record<DecisionControl, string> = {
  agree: 'Agree with recommendation',
  acknowledge: 'Acknowledge',
  schedule: 'Schedule review',
  dismiss: 'Dismiss',
  snooze: 'Snooze',
  mark_implemented: 'Record manual implementation',
  approve_learning: 'Approve learning',
  reject_learning: 'Reject learning',
}

function isoDateAfter(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: accountTimezone(),
  }).format(new Date(`${value}T12:00:00-04:00`))
}

function stateLabel(state: Record<string, unknown> | null, unavailable: string): string {
  if (!state || Object.keys(state).length === 0) return unavailable
  return Object.entries(state)
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value)}`)
    .join(' · ')
}

async function applyControl(item: DecisionQueueItemV2, control: DecisionControl): Promise<Response> {
  if (item.source === 'recommendation') {
    const decision = recommendationDecisionForControl(control)
    return fetch(`/api/recommendations/${item.source_id}/decision`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_decision: decision,
        follow_up_date: control === 'snooze' || control === 'schedule'
          ? (item.review_date ?? isoDateAfter(7))
          : undefined,
      }),
    })
  }
  if (item.source === 'alert') {
    return fetch(`/api/alerts/${item.source_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolved: true, resolution_note: 'Acknowledged from Decisions.' }),
    })
  }
  if (item.source === 'task') {
    const status = control === 'mark_implemented' || control === 'acknowledge'
      ? 'done'
      : control === 'dismiss'
        ? 'dismissed'
        : 'in_progress'
    return fetch(`/api/tasks/${item.source_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status,
        completion_note: control === 'acknowledge'
          ? 'Diagnostic acknowledged from Decisions; no live ad change was authorized or recorded.'
          : control === 'mark_implemented'
            ? 'Manual implementation was recorded from Decisions. Verify the current Meta state before outcome review.'
            : undefined,
      }),
    })
  }
  return fetch(`/api/outcomes/${item.source_id}/review`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review_status: control === 'approve_learning' ? 'approved' : 'rejected' }),
  })
}

function DecisionCard({ item, highlighted }: { item: DecisionQueueItemV2; highlighted: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function act(control: DecisionControl) {
    setError(null)
    startTransition(async () => {
      const response = await applyControl(item, control)
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        const message = body?.error ?? 'The decision could not be recorded.'
        setError(message)
        toast.error(message)
        return
      }
      toast.success(control === 'agree'
        ? 'Decision recorded. No live change was made.'
        : `${CONTROL_LABEL[control]} recorded.`)
      router.refresh()
    })
  }

  return (
    <article
      id={`decision-${item.id}`}
      tabIndex={-1}
      className="card-base overflow-hidden outline-none"
      data-decision-id={item.id}
      style={highlighted ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}
    >
      <div className="p-4 sm:p-5 space-y-4">
        <ProposalCard
          title={item.title}
          summary={item.summary}
          authority={item.authority}
          source={SOURCE_LABEL[item.source] ?? item.source}
          confidence={item.source === 'recommendation' ? item.confidence : undefined}
          evidenceWindow={item.evidence_window
            ? { start: dateLabel(item.evidence_window.start), end: dateLabel(item.evidence_window.end) }
            : null}
        >

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Fact
            label="Optimization unit"
            value={item.optimization_unit
              ? `${item.optimization_unit.level}${item.optimization_unit.name ? ` · ${item.optimization_unit.name}` : ''}`
              : 'Unavailable'}
          />
          <Fact label="Current Meta state" value={stateLabel(item.current_state, 'Unavailable')} />
          <Fact label="Proposed manual change" value={stateLabel(item.proposed_state, 'No governed change proposed')} />
          <Fact label="Guardrail" value={item.guardrail} />
          <Fact label="Review date" value={item.review_date ? dateLabel(item.review_date) : 'Not scheduled'} />
          <Fact label="Expected observation" value={item.expected_observation ?? 'Unavailable — no calibrated impact model'} />
          {item.source === 'recommendation' && (
            <Fact label="Data needed" value={item.dataNeeded ?? 'No additional data required'} />
          )}
        </div>

        {item.hypothesis && (
          <p className="rounded-lg p-3 text-[14px] leading-relaxed" style={{ background: 'var(--bg-subtle)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
            <b style={{ color: 'var(--text-primary)' }}>Hypothesis:</b> {item.hypothesis}
          </p>
        )}

        <details>
          <summary className="text-[12px] font-medium cursor-pointer inline-flex items-center gap-1" style={{ color: 'var(--text-secondary)', minHeight: 44 }}>
            <ChevronDown className="w-4 h-4" /> Evidence, risk, and safeguards
          </summary>
          <div className="space-y-2 text-[12px] pb-1" style={{ color: 'var(--text-secondary)' }}>
            <p><b>Why ranked here:</b> {item.rank_reason}</p>
            <p><b>Risk:</b> {item.risk ?? 'No quantified risk claim is available.'}</p>
            <p><b>Guardrail:</b> {item.guardrail}</p>
            <p><b>Rollback:</b> {item.rollback}</p>
            <div>
              <p className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Evidence:</p>
              <EvidenceList items={item.evidence} />
            </div>
            <p><b>Authority decision:</b> {item.authority_decision_id ?? 'No durable ActionDecision linkage is available.'}</p>
          </div>
        </details>

        {item.controls.length > 0 && (
          <div className="flex gap-2 flex-wrap pt-1" aria-label={`Controls for ${item.title}`}>
            {item.controls.map((control) => (
              <button
                key={control}
                type="button"
                onClick={() => act(control)}
                disabled={pending}
                className="rounded-lg px-3 text-[12px] font-semibold transition-colors disabled:opacity-50"
                style={{
                  minHeight: 44,
                  color: control === 'dismiss' || control === 'reject_learning' ? 'var(--danger)' : 'var(--accent)',
                  background: 'var(--bg-input)', border: '1px solid var(--border)',
                }}
              >
                {CONTROL_LABEL[control]}
              </button>
            ))}
          </div>
        )}
        {item.source === 'recommendation' && item.authority_decision_id && item.authority !== 'diagnostic_only' && (
          <Link
            href={`/changes?propose=${encodeURIComponent(item.authority_decision_id)}#propose-${encodeURIComponent(item.authority_decision_id)}`}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold"
            style={{ minHeight: 44, color: 'var(--on-accent)', background: 'var(--accent)' }}
          >
            <ShieldCheck className="w-4 h-4" /> Propose this change
          </Link>
        )}
        {item.source === 'recommendation' && item.controls.includes('agree') && (
          <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
            Agree records your decision only. It does not mean implemented and cannot change Meta.
          </p>
        )}
        {error && <p role="alert" className="text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
        </ProposalCard>
      </div>
    </article>
  )
}

function evidenceFlags(item: RecommendationEvidenceItem): string[] {
  const flags: string[] = []
  if (item.sourceSystem !== 'meta') flags.push(CLAIM_SOURCE_LABEL[item.sourceSystem])
  if (item.maturity !== 'settled' && item.maturity !== 'not_applicable') flags.push(MATURITY_LABEL[item.maturity])
  if (item.freshness !== 'fresh') flags.push(FRESHNESS_LABEL[item.freshness])
  if (item.availability !== 'available') flags.push(AVAILABILITY_LABEL[item.availability])
  return flags
}

function EvidenceList({ items }: { items: RecommendationEvidenceItem[] }) {
  if (items.length === 0) {
    return <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>No governed claim references are available.</p>
  }
  return (
    <ul className="space-y-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
      {items.map((item) => {
        const flags = evidenceFlags(item)
        const value = item.missing
          ? 'Referenced claim could not be resolved in the immutable snapshot.'
          : RECOMMENDATION_EVIDENCE_VALUE_FORMATTER[item.unit](item.value)
        const window = item.window.start && item.window.end
          ? `${item.window.start} – ${item.window.end}`
          : 'Window unknown'
        return (
          <li key={item.claimId}>
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
            {' '}: {value}
            {flags.length > 0 && (
              <span style={{ color: 'var(--text-tertiary)' }}> · {flags.join(' · ')}</span>
            )}
            <span style={{ color: 'var(--text-tertiary)' }}> · {window}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
      <p className="section-label">{label}</p>
      <p className="text-[12px] mt-1 capitalize" style={{ color: 'var(--text-primary)' }}>{value}</p>
    </div>
  )
}

export function DecisionQueue({
  items,
  initialView,
  filter,
  focusedDecisionId,
}: {
  items: DecisionQueueItemV2[]
  initialView: DecisionQueueView
  filter?: DecisionQueueFilter
  focusedDecisionId?: string
}) {
  const [view, setView] = useState<DecisionQueueView>(initialView)
  const visible = useMemo(() => visibleDecisionQueue(items, view, filter), [filter, items, view])
  const alertFilter = filter === 'unresolved_critical_alerts'
  const counts = useMemo(() => Object.fromEntries(
    DECISION_QUEUE_VIEWS.map((key) => [key, items.filter((item) => item.bucket === key).length]),
  ) as Record<DecisionQueueView, number>, [items])

  useEffect(() => {
    if (!focusedDecisionId) return
    const element = document.getElementById(`decision-${focusedDecisionId}`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    element?.focus({ preventScroll: true })
  }, [focusedDecisionId, view])

  function handleTabKeydown(event: KeyboardEvent<HTMLButtonElement>, key: DecisionQueueView) {
    const index = DECISION_QUEUE_VIEWS.indexOf(key)
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    const targetIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? DECISION_QUEUE_VIEWS.length - 1
        : direction === 0
          ? index
          : (index + direction + DECISION_QUEUE_VIEWS.length) % DECISION_QUEUE_VIEWS.length
    if (targetIndex === index && !['Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = DECISION_QUEUE_VIEWS[targetIndex]
    setView(target)
    document.getElementById(`decision-tab-${target}`)?.focus()
  }

  return (
    <div className="space-y-5">
      {!alertFilter && <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Decision queue views">
        {DECISION_QUEUE_VIEWS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`decision-tab-${key}`}
            aria-selected={view === key}
            aria-controls={`decision-panel-${key}`}
            tabIndex={view === key ? 0 : -1}
            onClick={() => setView(key)}
            onKeyDown={(event) => handleTabKeydown(event, key)}
            className="shrink-0 rounded-lg px-3 text-[12px] font-semibold"
            style={{
              minHeight: 44,
              color: view === key ? 'var(--accent)' : 'var(--text-secondary)',
              background: view === key ? 'var(--accent-dim)' : 'var(--bg-input)',
              border: `1px solid ${view === key ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {VIEW_LABEL[key]} · {counts[key]}
          </button>
        ))}
      </div>}

      {alertFilter && <p className="text-[14px] font-semibold" role="status">Unresolved critical alerts</p>}
      <div id={alertFilter ? 'decision-panel-unresolved-critical-alerts' : `decision-panel-${view}`} role={alertFilter ? 'region' : 'tabpanel'} aria-label={alertFilter ? 'Unresolved critical alerts' : undefined} aria-labelledby={alertFilter ? undefined : `decision-tab-${view}`} tabIndex={0} className="space-y-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
      {visible.deferred_ready_count > 0 && (
        <div className="rounded-lg p-3 flex items-start gap-2" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
          <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {visible.deferred_ready_count} additional ready action{visible.deferred_ready_count === 1 ? '' : 's'} held behind the three-action focus limit. Resolve or snooze a leading item to reveal the next one.
          </p>
        </div>
      )}

      {visible.items.length === 0 ? (
        <div className="card-base p-8 text-center">
          {view === 'snoozed' ? <CalendarClock className="w-7 h-7 mx-auto" style={{ color: 'var(--text-tertiary)' }} />
            : view === 'monitoring' ? <Clock3 className="w-7 h-7 mx-auto" style={{ color: 'var(--text-tertiary)' }} />
              : <CheckCircle2 className="w-7 h-7 mx-auto" style={{ color: 'var(--success)' }} />}
          <p className="text-[14px] font-semibold mt-3" style={{ color: 'var(--text-primary)' }}>Nothing in {alertFilter ? 'unresolved critical alerts' : VIEW_LABEL[view].toLowerCase()}</p>
          <p className="text-[12px] mt-1" style={{ color: 'var(--text-tertiary)' }}>Maxx will place durable records here when they enter this lifecycle state.</p>
        </div>
      ) : (
        <div className="space-y-3">{visible.items.map((item) => (
          <DecisionCard key={item.id} item={item} highlighted={item.id === focusedDecisionId} />
        ))}</div>
      )}
      </div>

      <div className="rounded-lg p-3 flex items-start gap-2" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--success)' }} />
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Write mode remains off. Decisions and implementation records are separate. See the immutable lifecycle in <Link href="/activity" className="underline">Activity</Link>.
        </p>
      </div>
    </div>
  )
}
