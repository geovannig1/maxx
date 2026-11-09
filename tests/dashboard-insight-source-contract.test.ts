import { describe, expect, it } from 'vitest'
import {
  accountInsightSpendPacing,
  accountInsightSpendTrend,
} from '@/lib/dashboard/insight-source-contract'

describe('dashboard account daily_insight source contract', () => {
  const rows = [
    { date_start: '2026-08-18', spend: '10.25' },
    { date_start: '2026-08-19', spend: 20 },
    { date_start: '2026-08-20', spend: null },
  ]

  it('projects account daily_insights into the existing spend-trend row shape', () => {
    expect(accountInsightSpendTrend(rows)).toEqual([
      { report_date: '2026-08-18', total_spend: 10.25 },
      { report_date: '2026-08-19', total_spend: 20 },
      { report_date: '2026-08-20', total_spend: 0 },
    ])
  })

  it('computes pacing from account daily_insights instead of daily_reports', () => {
    expect(accountInsightSpendPacing(rows, '2026-08-19')).toEqual({
      recentSpend: 20,
      daysOfData: 1,
    })
  })
})
