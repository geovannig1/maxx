export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { History } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/PageHeader'
import { getLedgerForAccount } from '@/lib/recommendations/setup-ledger'
import { activeAccountErrorCode, resolveOnlyActiveAccount, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { getAdminClient } from '@/lib/supabase/admin'
import {
  buildDecisionActivityTimeline,
  type ActivityChangeInput,
  type ActivityDecisionInput,
  type ActivityLedgerInput,
  type ActivityOutcomeInput,
  type ActivityTaskInput,
  type DecisionActivityEntry,
} from '@/lib/decisions/activity-timeline'
import { accountTimezone } from '@/config/business-config'
import { accountTimezoneShortName } from '@/config/timezone-label'

interface TimelineRead {
  entries: DecisionActivityEntry[]
  notices: string[]
  accountErrorCode: ActiveAccountErrorCode | null
}

async function getTimeline(): Promise<TimelineRead> {
  const db = getAdminClient()
  const active = await resolveOnlyActiveAccount(db)
  if (!active.ok) {
    return { entries: [], notices: [], accountErrorCode: activeAccountErrorCode(active.reason) }
  }
  const accountId = active.account.id
  const notices: string[] = []
  const [changes, decisions, outcomes, ledger, tasks] = await Promise.all([
    db.from('change_requests')
      .select('id, action_type, entity_level, meta_entity_id, reason, risk_level, status, created_at, initiated_by, preview, rollback_of')
      .eq('ad_account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(100),
    db.from('recommendation_decisions')
      .select('id, recommendation_id, recommendation_type, entity_key, user_decision, decision_note, decision_date, action_taken, action_taken_date, follow_up_date')
      .eq('ad_account_id', accountId)
      .order('decision_date', { ascending: false })
      .limit(100),
    db.from('recommendation_outcomes')
      .select('id, source_id, recommendation, outcome, outcome_note, review_status, reviewed_at, evaluated_at, recommended_on')
      .eq('ad_account_id', accountId)
      .not('outcome', 'is', null)
      .order('evaluated_at', { ascending: false })
      .limit(100),
    getLedgerForAccount(accountId, 100),
    db.from('audit_tasks')
      .select('id, title, status, completion_note, completed_at, updated_at, action_decision_id')
      .eq('ad_account_id', accountId)
      .in('status', ['done', 'dismissed'])
      .order('updated_at', { ascending: false })
      .limit(100),
  ])

  if (changes.error) notices.push('Change-request history is unavailable.')
  if (decisions.error) notices.push('Owner-decision history is unavailable.')
  if (outcomes.error) notices.push('Outcome history is unavailable.')
  if (tasks.error) notices.push('Manual task history is unavailable.')

  return {
    entries: buildDecisionActivityTimeline({
      changes: (changes.data ?? []) as unknown as ActivityChangeInput[],
      ledger: ledger as ActivityLedgerInput[],
      decisions: (decisions.data ?? []) as unknown as ActivityDecisionInput[],
      outcomes: (outcomes.data ?? []) as unknown as ActivityOutcomeInput[],
      tasks: (tasks.data ?? []) as unknown as ActivityTaskInput[],
    }),
    notices,
    accountErrorCode: null,
  }
}

const KIND_LABEL: Record<DecisionActivityEntry['kind'], string> = {
  proposal: 'Proposal',
  setup_decision: 'Setup decision',
  owner_decision: 'Owner decision',
  manual_implementation: 'Manual implementation',
  observation: 'Observation',
  outcome_review: 'Outcome review',
}

const KIND_COLOR: Record<DecisionActivityEntry['kind'], string> = {
  proposal: 'var(--accent)',
  setup_decision: 'var(--text-secondary)',
  owner_decision: 'var(--warning)',
  manual_implementation: 'var(--success)',
  observation: 'var(--accent)',
  outcome_review: 'var(--success)',
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', timeZone: accountTimezone(),
    })
  } catch {
    return iso
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: accountTimezone(),
    })
  } catch {
    return ''
  }
}

function TimelineCard({ entry }: { entry: DecisionActivityEntry }) {
  const refs = Object.entries(entry.linked_ids).filter(([, value]) => value !== null)
  return (
    <article className="card-base p-4" style={{ borderLeft: `3px solid ${KIND_COLOR[entry.kind]}` }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="text-[12px] font-bold uppercase tracking-wide rounded-full px-2 py-1" style={{
            color: KIND_COLOR[entry.kind], background: 'var(--bg-subtle)', border: '1px solid var(--border)',
          }}>
            {KIND_LABEL[entry.kind]}
          </span>
          <span className="text-[12px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
            {entry.status.replace(/_/g, ' ')}
          </span>
        </div>
        <time className="text-[12px] shrink-0" dateTime={entry.at} style={{ color: 'var(--text-tertiary)' }}>{fmtTime(entry.at)} {accountTimezoneShortName()}</time>
      </div>
      <h2 className="text-[14px] font-semibold capitalize mt-2" style={{ color: 'var(--text-primary)' }}>{entry.title}</h2>
      <p className="text-[14px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{entry.detail}</p>
      {refs.length > 0 && (
        <details className="mt-2">
          <summary className="text-[12px] cursor-pointer" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', color: 'var(--text-tertiary)' }}>
            Immutable record links
          </summary>
          <p className="text-[12px] break-all" style={{ color: 'var(--text-tertiary)' }}>
            {refs.map(([key, value]) => `${key}: ${value}`).join(' · ')}
          </p>
        </details>
      )}
    </article>
  )
}

export default async function ChangeLogPage() {
  await requireOwner()

  const data = await getTimeline()
  const groups: Array<{ label: string; entries: DecisionActivityEntry[] }> = []
  for (const entry of data.entries) {
    const label = fmtDate(entry.at)
    const last = groups[groups.length - 1]
    if (last?.label === label) last.entries.push(entry)
    else groups.push({ label, entries: [entry] })
  }

  return (
    <div className="space-y-5 max-w-4xl">
      <PageHeader
        title="Lifecycle timeline"
        icon={History}
        subtitle="The immutable path from proposal to owner decision, separately recorded manual implementation, observation, and reviewed outcome."
      />

      {data.notices.map((notice) => (
        <div key={notice} className="rounded-lg p-3 text-[12px]" style={{ color: 'var(--warning)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          {notice}
        </div>
      ))}

      {data.accountErrorCode ? (
        <ActiveAccountUnavailableNotice code={data.accountErrorCode} />
      ) : data.entries.length === 0 ? (
        <div className="card-base">
          <EmptyState
            icon={History}
            title="No lifecycle records yet"
            description="Proposals, owner decisions, separately recorded manual actions, observations, and reviewed outcomes will appear here."
          />
        </div>
      ) : (
        <div className="space-y-7">
          {groups.map((group) => (
            <section key={group.label} className="space-y-3">
              <p className="section-label">{group.label} · {group.entries.length}</p>
              <div className="space-y-2">{group.entries.map((entry) => <TimelineCard key={entry.id} entry={entry} />)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
