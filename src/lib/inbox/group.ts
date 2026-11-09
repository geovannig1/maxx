// Pure classifier for the Action Inbox (Wave 2). Splits the alert + task rows the page fetches, plus the
// shared buildAttention() model, into the four inbox sections: Urgent issues / Manual tasks / Review
// needed / Informational. It stays pure (no fetching, no DOM) so the inbox and the dashboard "Needs you
// today" card, both built on buildAttention, can never disagree — and so grouping is unit-testable.

import type { AttentionItem, AttentionKey } from '@/lib/dashboard/attention'

export type AlertSeverity = 'critical' | 'warning' | 'info'

// The alert row shape the inbox renders. Mirrors the /api/alerts payload the old Alerts page consumed;
// the extracted AlertCard is typed against this so the markup stays verbatim.
export interface InboxAlert {
  id: string
  alert_type: string
  severity: AlertSeverity
  title: string
  message: string
  alert_date: string | null
  detected_at: string
  is_resolved: boolean
  entity_level: string | null
  meta_campaign_id: string | null
  meta_adset_id: string | null
  meta_ad_id: string | null
  metric_name: string | null
  metric_value: number | null
  baseline_value: number | null
  why_it_matters: string | null
  recommended_actions: string[] | null
  amount_at_risk: number | null
  action_label: string | null
  action_url: string | null
}

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low'

// The task row shape the inbox renders. Mirrors the /api/tasks payload the old Tasks page consumed.
export interface InboxTask {
  id: string
  title: string
  description: string | null
  recommendation: string | null
  priority: TaskPriority
  status: string
  due_date: string | null
}

// buildAttention surfaces that are REVIEW queues — rendered as count+link rows only, never as
// approve/reject controls (the queues stay their own pages). Critical/warning alerts and open tasks are
// deliberately excluded: they render as full cards in the Urgent and Manual sections instead.
export const INBOX_REVIEW_KEYS: AttentionKey[] = [
  'pending_changes',
  'pending_approvals',
  'outcomes_review',
  'ledger_conflicts',
]

export interface InboxGroups {
  /** Unresolved critical + warning alerts, critical first. */
  urgent: InboxAlert[]
  /** Open / in-progress tasks, ranked urgent → low. */
  manual: InboxTask[]
  /** Review-queue attention items (counts + links), in buildAttention's severity order. */
  review: AttentionItem[]
  informational: {
    /** Unresolved info alerts. */
    info: InboxAlert[]
    /** Resolved alerts (any severity), shown behind a toggle. */
    resolved: InboxAlert[]
  }
}

export interface GroupInboxInput {
  alerts: InboxAlert[]
  tasks: InboxTask[]
  /** Output of buildAttention() — the page computes the counts and passes the ranked list in. */
  attention: AttentionItem[]
}

function severityOrder(s: AlertSeverity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2
}

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/** Classify inbox rows into the four sections. Pure: sorts copies, never mutates the inputs. */
export function groupInboxItems({ alerts, tasks, attention }: GroupInboxInput): InboxGroups {
  const urgent = alerts
    .filter((a) => !a.is_resolved && (a.severity === 'critical' || a.severity === 'warning'))
    .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))

  const manual = tasks
    .filter((t) => t.status === 'open' || t.status === 'in_progress')
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])

  const review = attention.filter((i) => INBOX_REVIEW_KEYS.includes(i.key))

  const info = alerts.filter((a) => !a.is_resolved && a.severity === 'info')
  const resolved = alerts.filter((a) => a.is_resolved)

  return { urgent, manual, review, informational: { info, resolved } }
}
