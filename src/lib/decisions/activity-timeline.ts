export interface ActivityChangeInput {
  id: string
  action_type: string | null
  entity_level: string | null
  meta_entity_id: string | null
  reason: string | null
  risk_level: string | null
  status: string | null
  created_at: string
  /** ADR-059: 'owner' when the owner initiated the change; absent or 'agent' otherwise. */
  initiated_by?: string | null
  preview?: string | null
  rollback_of?: string | null
}

export interface ActivityLedgerInput {
  id: string
  origin: string
  setting_name: string
  entity_name: string | null
  previous_value: string | null
  actual_launched_value: string | null
  final_value: string | null
  proposed_value: string | null
  user_decision: string | null
  decision_note: string | null
  created_at: string
}

export interface ActivityDecisionInput {
  id: string
  recommendation_id: string | null
  recommendation_type: string
  entity_key: string
  user_decision: string
  decision_note: string | null
  decision_date: string
  action_taken: boolean
  action_taken_date: string | null
  follow_up_date: string | null
}

export interface ActivityOutcomeInput {
  id: string
  source_id: string | null
  recommendation: string
  outcome: string
  outcome_note: string | null
  review_status: string | null
  reviewed_at: string | null
  evaluated_at: string | null
  recommended_on: string
}

export interface ActivityTaskInput {
  id: string
  title: string
  status: string
  completion_note: string | null
  completed_at: string | null
  updated_at: string | null
  action_decision_id: string | null
}

export interface DecisionActivityEntry {
  id: string
  kind: 'proposal' | 'setup_decision' | 'owner_decision' | 'manual_implementation' | 'observation' | 'outcome_review'
  at: string
  title: string
  status: string
  detail: string
  linked_ids: Record<string, string | null>
}

export interface DecisionActivityInput {
  changes: ActivityChangeInput[]
  ledger: ActivityLedgerInput[]
  decisions: ActivityDecisionInput[]
  outcomes: ActivityOutcomeInput[]
  tasks?: ActivityTaskInput[]
}

const OWNER_ACTIVITY_EXCLUDED_TERMS = /(?:outcome[_\s-]*(?:ledger|business|source)|recorded[_\s-]*outcome|collected[_\s-]*value|checkout|trackedcheckout|amount[_\s-]*paid|amountpaid|booked[_\s-]*value|bookedvalue|cancell?ation|refund|cash|profit|revenue|return(?:s|ed)?|roas|paid[_\s-]*association|paidassociation)/i

function ownerActivityDetail(value: string | null | undefined, fallback: string): string {
  const detail = value?.trim() ?? ''
  return detail && !OWNER_ACTIVITY_EXCLUDED_TERMS.test(detail) ? detail : fallback
}

function ownerActivityTitle(value: string, fallback: string): string {
  return OWNER_ACTIVITY_EXCLUDED_TERMS.test(value) ? fallback : value
}

export function buildDecisionActivityTimeline(input: DecisionActivityInput): DecisionActivityEntry[] {
  const entries: DecisionActivityEntry[] = []

  for (const row of input.changes) {
    const owner = row.initiated_by === 'owner'
    const action = (row.action_type ?? 'change request').replace(/_/g, ' ')
    entries.push({
      id: `change:${row.id}`,
      kind: 'proposal',
      at: row.created_at,
      title: ownerActivityTitle(owner ? `${row.rollback_of ? 'your rollback' : 'your change'} · ${action}` : action, 'Meta delivery change request'),
      status: row.status ?? 'unknown',
      detail: owner
        ? `${ownerActivityDetail(row.preview, 'Owner-initiated Meta delivery change.')} You initiated this change.`
        : ownerActivityDetail(row.reason, 'Meta delivery rationale was recorded.'),
      linked_ids: { change_request_id: row.id, meta_entity_id: row.meta_entity_id, ...(row.rollback_of ? { rollback_of: row.rollback_of } : {}) },
    })
  }

  for (const row of input.ledger) {
    const finalValue = row.actual_launched_value ?? row.final_value ?? row.proposed_value ?? '—'
    entries.push({
      id: `ledger:${row.id}`,
      kind: row.origin === 'manual_action' ? 'manual_implementation' : 'setup_decision',
      at: row.created_at,
      title: ownerActivityTitle(row.setting_name, 'Manual Meta state record'),
      status: row.user_decision ?? row.origin,
      detail: ownerActivityDetail(
        `${row.previous_value ? `${row.previous_value} → ` : ''}${finalValue}${row.decision_note ? ` · “${row.decision_note}”` : ''}`,
        'Manual Meta state record retained without excluded financial detail.',
      ),
      linked_ids: { ledger_id: row.id },
    })
  }

  for (const row of input.decisions) {
    entries.push({
      id: `decision:${row.id}`,
      kind: 'owner_decision',
      at: row.decision_date,
      title: ownerActivityTitle(`${row.recommendation_type.replace(/_/g, ' ')} · ${row.entity_key}`, 'Meta delivery owner decision'),
      status: row.user_decision,
      detail: `${ownerActivityDetail(row.decision_note, 'Owner disposition recorded.')} Agreeing to a recommendation does not mean implemented.`,
      linked_ids: { decision_id: row.id, recommendation_id: row.recommendation_id },
    })
    if (row.action_taken && row.action_taken_date) {
      entries.push({
        id: `implementation:${row.id}`,
        kind: 'manual_implementation',
        at: row.action_taken_date,
        title: ownerActivityTitle(`${row.recommendation_type.replace(/_/g, ' ')} · manual implementation recorded`, 'Manual Meta implementation recorded'),
        status: 'recorded',
        detail: `Implementation was recorded separately from the owner decision.${row.follow_up_date ? ` Review scheduled for ${row.follow_up_date}.` : ''}`,
        linked_ids: { decision_id: row.id, recommendation_id: row.recommendation_id },
      })
    }
  }

  for (const row of input.tasks ?? []) {
    if (row.status !== 'done' && row.status !== 'dismissed') continue
    entries.push({
      id: `task:${row.id}`,
      kind: row.status === 'done' ? 'manual_implementation' : 'owner_decision',
      at: row.completed_at ?? row.updated_at ?? new Date(0).toISOString(),
      title: ownerActivityTitle(`${row.title} · ${row.status === 'done' ? 'manual task recorded' : 'dismissed'}`, 'Manual Meta task record'),
      status: row.status,
      detail: row.completion_note ?? 'Owner task disposition recorded. This does not by itself prove a live Meta change.',
      linked_ids: { task_id: row.id, action_decision_id: row.action_decision_id },
    })
  }

  for (const row of input.outcomes) {
    if (row.evaluated_at) {
      entries.push({
        id: `observation:${row.id}`,
        kind: 'observation',
        at: row.evaluated_at,
        title: ownerActivityTitle(`${row.outcome.replace(/_/g, ' ')} · observed outcome`, 'Meta delivery observation'),
        status: 'measured',
        detail: ownerActivityDetail(row.outcome_note ?? row.recommendation, 'Meta delivery observation recorded.'),
        linked_ids: { outcome_id: row.id, source_id: row.source_id },
      })
    }
    if (row.reviewed_at || (row.review_status && row.review_status !== 'pending')) {
      entries.push({
        id: `outcome-review:${row.id}`,
        kind: 'outcome_review',
        at: row.reviewed_at ?? row.evaluated_at ?? `${row.recommended_on}T12:00:00Z`,
        title: ownerActivityTitle(`${row.outcome.replace(/_/g, ' ')} · outcome review`, 'Meta delivery outcome review'),
        status: row.review_status ?? 'pending',
        detail: ownerActivityDetail(row.outcome_note ?? row.recommendation, 'Meta delivery outcome review recorded.'),
        linked_ids: { outcome_id: row.id, source_id: row.source_id },
      })
    }
  }

  return entries.sort((a, b) => {
    const date = b.at.localeCompare(a.at)
    return date !== 0 ? date : a.id.localeCompare(b.id)
  })
}
