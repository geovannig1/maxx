// The "needs you" list — every act/review surface that can be waiting on the operator, collapsed into
// one severity-ranked list the dashboard (and later the Action Inbox) renders. Pure: the counts are
// gathered by the caller and passed in. The hrefs live in ONE exported table so a later nav change
// (Wave 2 introduces /inbox) is a single-file edit, not a hunt across pages.

export type AttentionKey =
  | 'critical_alerts'
  | 'pending_changes'
  | 'pending_approvals'
  | 'outcomes_review'
  | 'ledger_conflicts'
  | 'open_tasks'
  | 'warning_alerts'

export interface AttentionItem {
  key: AttentionKey
  /** Plain-English, count-first (e.g. "3 changes awaiting your approval"). */
  label: string
  count: number
  /** 1 = most urgent. Drives ordering and emphasis. */
  severityRank: number
  href: string
}

/** Single source of truth for where each surface lives. Flip a route here and every consumer follows. */
export const ATTENTION_HREFS: Record<AttentionKey, string> = {
  critical_alerts: '/inbox',
  pending_changes: '/changes',
  pending_approvals: '/approvals',
  outcomes_review: '/activity/learnings',
  ledger_conflicts: '/launch',
  open_tasks: '/inbox',
  warning_alerts: '/inbox',
}

export const ATTENTION_KEYS = Object.keys(ATTENTION_HREFS) as AttentionKey[]

/** Intrinsic severity of each surface (1 = most urgent). Fixed, so a surface keeps its rank whether or
 *  not more urgent surfaces happen to be present. Critical alerts → … → warning alerts. */
export const ATTENTION_SEVERITY: Record<AttentionKey, number> = {
  critical_alerts: 1,
  pending_changes: 2,
  pending_approvals: 3,
  outcomes_review: 4,
  ledger_conflicts: 5,
  open_tasks: 6,
  warning_alerts: 7,
}

export interface AttentionCounts {
  criticalAlerts?: number
  pendingChanges?: number
  pendingApprovals?: number
  outcomesAwaitingReview?: number
  ledgerConflicts?: number
  openTasks?: number
  /** Urgent + high-priority subset of openTasks, surfaced in the label. */
  openTasksUrgent?: number
  warningAlerts?: number
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Build the ranked "needs you" list. Zero-count surfaces are omitted; result is severity-ordered. */
export function buildAttention(counts: AttentionCounts): AttentionItem[] {
  const c = counts
  const criticalAlerts = c.criticalAlerts ?? 0
  const pendingChanges = c.pendingChanges ?? 0
  const pendingApprovals = c.pendingApprovals ?? 0
  const outcomesReview = c.outcomesAwaitingReview ?? 0
  const ledgerConflicts = c.ledgerConflicts ?? 0
  const openTasks = c.openTasks ?? 0
  const openTasksUrgent = c.openTasksUrgent ?? 0
  const warningAlerts = c.warningAlerts ?? 0

  const items: AttentionItem[] = []
  const add = (key: AttentionKey, count: number, label: string) => {
    if (count > 0) items.push({ key, label, count, severityRank: ATTENTION_SEVERITY[key], href: ATTENTION_HREFS[key] })
  }

  // Severity order: critical alerts → pending changes → pending approvals → outcomes review →
  // ledger conflicts → open tasks (urgent/high first) → warning alerts.
  add('critical_alerts', criticalAlerts, `${plural(criticalAlerts, 'critical alert')} to resolve`)
  add('pending_changes', pendingChanges, `${plural(pendingChanges, 'pending change')} to review`)
  add('pending_approvals', pendingApprovals, `${plural(pendingApprovals, 'change')} awaiting your approval`)
  add('outcomes_review', outcomesReview, `${plural(outcomesReview, 'outcome')} awaiting your review`)
  add('ledger_conflicts', ledgerConflicts, `${plural(ledgerConflicts, 'ledger conflict')} to resolve`)
  add('open_tasks', openTasks, openTasksUrgent > 0 ? `${plural(openTasks, 'open task')} (${openTasksUrgent} urgent)` : `${plural(openTasks, 'open task')}`)
  add('warning_alerts', warningAlerts, `${plural(warningAlerts, 'warning alert')}`)

  return items
}
