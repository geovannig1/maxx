import { describe, it, expect } from 'vitest'
import { buildAttention } from '@/lib/dashboard/attention'
import {
  groupInboxItems,
  INBOX_REVIEW_KEYS,
  type InboxAlert,
  type InboxTask,
  type AlertSeverity,
  type TaskPriority,
} from '@/lib/inbox/group'

function alert(id: string, severity: AlertSeverity, is_resolved = false): InboxAlert {
  return {
    id,
    alert_type: 'spend_spike',
    severity,
    title: `Alert ${id}`,
    message: 'msg',
    alert_date: null,
    detected_at: '2026-07-01T00:00:00Z',
    is_resolved,
    entity_level: null,
    meta_campaign_id: null,
    meta_adset_id: null,
    meta_ad_id: null,
    metric_name: null,
    metric_value: null,
    baseline_value: null,
    why_it_matters: null,
    recommended_actions: null,
    amount_at_risk: null,
    action_label: null,
    action_url: null,
  }
}

function task(id: string, priority: TaskPriority, status = 'open'): InboxTask {
  return { id, title: `Task ${id}`, description: null, recommendation: null, priority, status, due_date: null }
}

// Every review-queue surface present so the review filter has something to exclude around it.
const attentionAll = buildAttention({
  criticalAlerts: 2,
  warningAlerts: 1,
  openTasks: 3,
  pendingChanges: 1,
  pendingApprovals: 2,
  outcomesAwaitingReview: 1,
  ledgerConflicts: 1,
})

describe('groupInboxItems — urgent', () => {
  it('keeps only unresolved critical + warning alerts, critical first', () => {
    const alerts = [alert('w1', 'warning'), alert('c1', 'critical'), alert('i1', 'info'), alert('c2', 'critical', true)]
    const { urgent } = groupInboxItems({ alerts, tasks: [], attention: [] })
    expect(urgent.map((a) => a.id)).toEqual(['c1', 'w1'])
  })

  it('is stable within the same severity (preserves input order)', () => {
    const alerts = [alert('c1', 'critical'), alert('c2', 'critical'), alert('w1', 'warning')]
    const { urgent } = groupInboxItems({ alerts, tasks: [], attention: [] })
    expect(urgent.map((a) => a.id)).toEqual(['c1', 'c2', 'w1'])
  })
})

describe('groupInboxItems — manual', () => {
  it('keeps only open / in_progress tasks, ranked urgent → low', () => {
    const tasks = [task('low', 'low'), task('urg', 'urgent'), task('med', 'medium', 'in_progress'), task('done', 'high', 'done')]
    const { manual } = groupInboxItems({ alerts: [], tasks, attention: [] })
    expect(manual.map((t) => t.id)).toEqual(['urg', 'med', 'low'])
  })
})

describe('groupInboxItems — review', () => {
  it('keeps only the review-queue keys, in buildAttention order', () => {
    const { review } = groupInboxItems({ alerts: [], tasks: [], attention: attentionAll })
    expect(review.map((i) => i.key)).toEqual(['pending_changes', 'pending_approvals', 'outcomes_review', 'ledger_conflicts'])
  })

  it('excludes urgent/manual attention keys (alerts + tasks render as cards)', () => {
    const { review } = groupInboxItems({ alerts: [], tasks: [], attention: attentionAll })
    for (const item of review) expect(INBOX_REVIEW_KEYS).toContain(item.key)
    expect(review.some((i) => i.key === 'critical_alerts' || i.key === 'warning_alerts' || i.key === 'open_tasks')).toBe(false)
  })
})

describe('groupInboxItems — informational', () => {
  it('splits unresolved info alerts from resolved alerts (any severity, behind the toggle)', () => {
    const alerts = [alert('i1', 'info'), alert('rc', 'critical', true), alert('ri', 'info', true), alert('c1', 'critical')]
    const { informational } = groupInboxItems({ alerts, tasks: [], attention: [] })
    expect(informational.info.map((a) => a.id)).toEqual(['i1'])
    expect(informational.resolved.map((a) => a.id)).toEqual(['rc', 'ri'])
  })
})

describe('groupInboxItems — zero states', () => {
  it('returns empty sections for empty inputs', () => {
    const g = groupInboxItems({ alerts: [], tasks: [], attention: [] })
    expect(g.urgent).toEqual([])
    expect(g.manual).toEqual([])
    expect(g.review).toEqual([])
    expect(g.informational.info).toEqual([])
    expect(g.informational.resolved).toEqual([])
  })
})

describe('groupInboxItems — purity', () => {
  it('does not mutate the input arrays', () => {
    const alerts = [alert('w1', 'warning'), alert('c1', 'critical')]
    const tasks = [task('low', 'low'), task('urg', 'urgent')]
    groupInboxItems({ alerts, tasks, attention: attentionAll })
    expect(alerts.map((a) => a.id)).toEqual(['w1', 'c1'])
    expect(tasks.map((t) => t.id)).toEqual(['low', 'urg'])
  })
})
