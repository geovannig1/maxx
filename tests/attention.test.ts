import { describe, it, expect } from 'vitest'
import { buildAttention, ATTENTION_HREFS, ATTENTION_KEYS, ATTENTION_SEVERITY, type AttentionCounts } from '@/lib/dashboard/attention'

const allOne: AttentionCounts = {
  criticalAlerts: 1,
  pendingChanges: 1,
  pendingApprovals: 1,
  outcomesAwaitingReview: 1,
  ledgerConflicts: 1,
  openTasks: 1,
  warningAlerts: 1,
}

describe('buildAttention', () => {
  it('returns an empty array when nothing needs attention', () => {
    expect(buildAttention({})).toEqual([])
  })

  it('covers all seven surfaces and returns them in severity order', () => {
    const items = buildAttention(allOne)
    expect(items).toHaveLength(7)
    expect(items.map((i) => i.key)).toEqual([
      'critical_alerts',
      'pending_changes',
      'pending_approvals',
      'outcomes_review',
      'ledger_conflicts',
      'open_tasks',
      'warning_alerts',
    ])
    // severityRank is intrinsic and strictly increasing down the list.
    expect(items.map((i) => i.severityRank)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('omits zero-count surfaces while keeping intrinsic severity ranks', () => {
    const items = buildAttention({ pendingApprovals: 2, warningAlerts: 4 })
    expect(items.map((i) => i.key)).toEqual(['pending_approvals', 'warning_alerts'])
    // A lone warning alert keeps its low intrinsic rank (7), never gets promoted to 1.
    expect(items.find((i) => i.key === 'warning_alerts')!.severityRank).toBe(ATTENTION_SEVERITY.warning_alerts)
    expect(items.find((i) => i.key === 'pending_approvals')!.severityRank).toBe(ATTENTION_SEVERITY.pending_approvals)
  })

  it('writes plain-English, count-first labels (with pluralization and urgent note)', () => {
    expect(buildAttention({ criticalAlerts: 1 })[0].label).toBe('1 critical alert to resolve')
    expect(buildAttention({ criticalAlerts: 3 })[0].label).toBe('3 critical alerts to resolve')
    expect(buildAttention({ pendingApprovals: 2 })[0].label).toBe('2 changes awaiting your approval')
    expect(buildAttention({ openTasks: 5, openTasksUrgent: 2 })[0].label).toBe('5 open tasks (2 urgent)')
    expect(buildAttention({ openTasks: 5 })[0].label).toBe('5 open tasks')
  })

  it('every key has an href, and built items link through the href table', () => {
    for (const key of ATTENTION_KEYS) {
      expect(ATTENTION_HREFS[key]).toBeTruthy()
    }
    // The alert + task surfaces merge into the unified Action Inbox (no standalone /alerts or /tasks).
    expect(ATTENTION_HREFS.critical_alerts).toBe('/inbox')
    expect(ATTENTION_HREFS.warning_alerts).toBe('/inbox')
    expect(ATTENTION_HREFS.open_tasks).toBe('/inbox')
    for (const item of buildAttention(allOne)) {
      expect(item.href).toBe(ATTENTION_HREFS[item.key])
    }
    // Table and severity map cover exactly the same key set.
    expect(Object.keys(ATTENTION_SEVERITY).sort()).toEqual([...ATTENTION_KEYS].sort())
  })
})
