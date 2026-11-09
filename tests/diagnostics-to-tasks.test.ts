import { describe, it, expect } from 'vitest'
import { anomaliesToTasks, deliveryDiagnosticsToTasks, reallocationsToTasks } from '@/lib/diagnostics/to-tasks'
import { explainMetricChange } from '@/lib/diagnostics/anomaly'
import { computeDeliveryDiagnostic } from '@/lib/diagnostics/opportunity'
import { computeTrust } from '@/lib/trust/trust'
import type { Reallocation } from '@/lib/recommendations/reallocation'

describe('anomaliesToTasks', () => {
  it('turns a worsened high-severity metric into a high-priority investigate task', () => {
    const cpl = explainMetricChange({ key: 'cpl', label: 'CPL', current: 14, previous: 10, direction: 'lower_is_better', unit: '$' })
    const tasks = anomaliesToTasks([cpl])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].priority).toBe('high')
    expect(tasks[0].source).toBe('anomaly')
    expect(tasks[0].title).toMatch(/CPL/)
  })

  it('skips improvements / non-anomalies', () => {
    const improved = explainMetricChange({ key: 'cpl', label: 'CPL', current: 8, previous: 10, direction: 'lower_is_better', unit: '$' })
    expect(anomaliesToTasks([improved])).toHaveLength(0)
  })

  it('downgrades priority + adds a verify note when the spike is low-trust', () => {
    const cpl = explainMetricChange({ key: 'cpl', label: 'CPL', current: 14, previous: 10, direction: 'lower_is_better', unit: '$', trustCtx: { spend: 5, bookings: 0, windowDays: 1, revenueClaim: true } })
    const tasks = anomaliesToTasks([cpl])
    expect(tasks[0].priority).toBe('medium') // high severity but untrusted → not urgent
    expect(tasks[0].recommendation).toMatch(/verify before acting/i)
  })
})

describe('deliveryDiagnosticsToTasks', () => {
  const verifiedTrust = computeTrust({ spend: 600, bookings: 12, windowDays: 14, dataAgeHours: 5, sourceOfTruth: 'exact_paid_appointment_join', revenueClaim: true, attributionCoverage: 0.95, dataSourcesCount: 2 })
  const thinTrust = computeTrust({ spend: 5, bookings: 0, windowDays: 1, revenueClaim: true })

  it('creates only an investigation task for a notable delivery observation', () => {
    const notable = computeDeliveryDiagnostic({ pacing: { status: 'under', pct: 45 }, frequency: 4.2, qualityTier: 'below_average', trust: verifiedTrust })
    const tasks = deliveryDiagnosticsToTasks([{ name: 'Retargeting', diagnostic: notable }])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].source).toBe('delivery_diagnostic')
    expect(tasks[0].title).toMatch(/^Investigate auction or delivery observations/i)
    expect(`${tasks[0].title} ${tasks[0].description} ${tasks[0].recommendation}`).not.toMatch(/scale|hold|fix|pause|increase|decrease|reallocate/i)
    expect(tasks[0].priority).toBe('low')
  })

  it('does not create a task for ordinary or insufficient evidence', () => {
    const ordinary = computeDeliveryDiagnostic({ pacing: { status: 'on', pct: 100 }, frequency: 1.8, qualityTier: 'above_average', trust: verifiedTrust })
    const insufficient = computeDeliveryDiagnostic({ pacing: { status: 'under', pct: 50 }, frequency: 1.8, qualityTier: 'above_average', trust: thinTrust })
    expect(deliveryDiagnosticsToTasks([
      { name: 'A', diagnostic: ordinary },
      { name: 'B', diagnostic: insufficient },
    ])).toHaveLength(0)
  })
})

describe('reallocationsToTasks', () => {
  const base: Reallocation = { fromId: 'l', fromName: 'Cold', toId: 'w', toName: 'RT', suggestedShiftDaily: 25, rationale: 'Governed.', trust: 80, meetsBar: false, approvalRequired: true, authorityTier: 'owner_review' }
  it('uses authority tier — never trust alone — to set urgency', () => {
    expect(reallocationsToTasks([{ ...base, meetsBar: true, authorityTier: 'execution_eligible' }])[0].priority).toBe('high')
    expect(reallocationsToTasks([base])[0].priority).toBe('medium')
    expect(reallocationsToTasks([base])[0].recommendation).toMatch(/Owner approval/i)
  })
})
