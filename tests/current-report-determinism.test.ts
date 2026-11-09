import { describe, expect, it } from 'vitest'

import { projectCurrentDailyReport } from '@/lib/report/generator'
import { projectCurrentWeeklyReport } from '@/lib/report/weekly'
import { buildWeeklyExecutiveDigest } from '@/lib/report/weekly-executive'
import { maximalDigestFixture } from './fixtures/daily-digest-v2'
import { WEEK_END, WEEK_START, weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'
import type { StoredRecommendation } from '@/lib/recommendations/store'

describe('current report narrative containment', () => {
  it('projects the daily report only from the committed deterministic digest and governed appendix', () => {
    const legacyBudgetAction = {
      recommendation_type: 'scale',
      reason_for_action: 'Move the Cold budget to Warm.',
      action_authority_tier: 'owner_review',
    } as unknown as StoredRecommendation
    const report = projectCurrentDailyReport(
      maximalDigestFixture,
      [legacyBudgetAction],
      'committed_withheld',
    )

    expect(report.fullReportMd).toContain(`# ${maximalDigestFixture.subject}`)
    expect(report.fullReportMd).toContain(maximalDigestFixture.narrative.text)
    expect(report.fullReportMd).toContain('## Governed Recommendations')
    expect(report.fullReportMd).toContain('A committed recommendation snapshot exists')
    expect(report.fullReportMd).toContain('withheld during the diagnostics-only rollout')
    expect(report.fullReportMd).not.toMatch(/0 recommendations/i)
    expect(report.fullReportMd).not.toContain('Move the Cold budget to Warm.')
    expect(report.fullReportMd).not.toContain('## Diagnostic Narrative')
    expect(report.summaryText).toBe(maximalDigestFixture.narrative.text)
    expect(report.modelUsed).toBe('deterministic-daily-v3')
    expect(report.promptTokens).toBe(0)
    expect(report.completionTokens).toBe(0)
  })

  it('labels a missing recommendation snapshot unavailable instead of converting it to zero', () => {
    const report = projectCurrentDailyReport(maximalDigestFixture, [], 'unavailable')

    expect(report.fullReportMd).toContain('No committed recommendation snapshot is available')
    expect(report.fullReportMd).toContain('recommendations are withheld')
    expect(report.fullReportMd).not.toMatch(/0 recommendations/i)
  })

  it('projects the weekly report only from the committed deterministic evidence digest', () => {
    const digest = buildWeeklyExecutiveDigest(weeklyExecutiveEvidenceFixture, {
      weeklyReportId: '00000000-0000-4000-8000-000000000108',
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
    })
    const report = projectCurrentWeeklyReport(digest)

    expect(report.fullReportMd).toBe(digest.text)
    expect(report.summaryText).toBe(digest.context.current_week)
    expect(report.modelUsed).toBe('deterministic-weekly-v1')
    expect(report.fullReportMd).not.toMatch(/LLM|Diagnostic Narrative/i)
  })
})
