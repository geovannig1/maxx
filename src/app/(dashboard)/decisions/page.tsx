export const dynamic = 'force-dynamic'

import { requireOwner } from '@/lib/auth/page-owner'
import { ClipboardCheck } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { ActiveAccountUnavailableNotice } from '@/components/accounts/ActiveAccountUnavailableNotice'
import { DecisionQueue } from '@/components/decisions/DecisionQueue'
import { DECISION_QUEUE_VIEWS, isDecisionQueueFilter, type DecisionQueueView } from '@/lib/decisions/queue-v2'
import { readDecisionQueue } from '@/lib/decisions/read-model'

function resolveView(value: string | undefined): DecisionQueueView {
  return DECISION_QUEUE_VIEWS.includes(value as DecisionQueueView)
    ? value as DecisionQueueView
    : 'needs_review'
}

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; filter?: string; legacy?: string; decision?: string }>
}) {
  await requireOwner()

  const params = await searchParams
  const filter = isDecisionQueueFilter(params.filter) ? params.filter : undefined
  const data = await readDecisionQueue(filter ? { alertScope: 'unresolved_critical' } : undefined)
  const focused = params.decision
    ? data.items.find((item) => item.source_id === params.decision
      || item.id === params.decision
      || item.authority_decision_id === params.decision)
    : undefined
  const initialView = filter ? 'needs_review' : focused?.bucket ?? resolveView(params.view)

  return (
    <div className="space-y-5 max-w-5xl">
      <PageHeader
        title="Decisions"
        icon={ClipboardCheck}
        subtitle="One review-first queue for evidence, owner decisions, manual implementation, and measured outcomes."
      />

      {params.legacy && (
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          You arrived through the former {params.legacy} route. Its durable records now appear in this queue.
        </p>
      )}

      {data.notices.map((notice) => (
        <div key={notice} className="rounded-lg p-3 text-[12px]" style={{ color: 'var(--warning)', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          {notice}
        </div>
      ))}

      {data.accountErrorCode
        ? <ActiveAccountUnavailableNotice code={data.accountErrorCode} />
        : <DecisionQueue items={data.items} initialView={initialView} filter={filter} focusedDecisionId={focused?.id} />}
    </div>
  )
}
