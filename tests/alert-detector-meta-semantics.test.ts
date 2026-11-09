import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assessAllClickCtrTrend } from '@/lib/alerts/detector'

function sevenDays(start: number, clicks: number, impressions: number) {
  return Array.from({ length: 7 }, (_, offset) => ({
    date_start: `2026-08-${String(start + offset).padStart(2, '0')}`,
    clicks,
    impressions,
  }))
}

describe('legacy alert detector Meta semantics', () => {
  it('does not turn a single day into a creative-performance trend', () => {
    expect(assessAllClickCtrTrend([
      { date_start: '2026-08-14', clicks: 1, impressions: 1_000 },
    ], '2026-08-14')).toMatchObject({ status: 'insufficient', recentDays: 1, priorDays: 0 })
  })

  it('detects only a descriptive all-click CTR decline across two complete seven-day windows', () => {
    const result = assessAllClickCtrTrend([
      ...sevenDays(1, 20, 1_000),
      ...sevenDays(8, 15, 1_000),
    ], '2026-08-14')

    expect(result).toMatchObject({
      status: 'declined',
      recentDays: 7,
      priorDays: 7,
      recentCtr: 1.5,
      priorCtr: 2,
      declinePct: 25,
    })
  })

  it('does not treat a low but stable all-click CTR level as decline evidence', () => {
    const result = assessAllClickCtrTrend([
      ...sevenDays(1, 3, 1_000),
      ...sevenDays(8, 3, 1_000),
    ], '2026-08-14')
    expect(result.status).toBe('no_decline')
  })

  it('requires adequate impressions in both comparison windows', () => {
    const result = assessAllClickCtrTrend([
      ...sevenDays(1, 2, 100),
      ...sevenDays(8, 1, 100),
    ], '2026-08-14')
    expect(result.status).toBe('insufficient')
  })

  it('contains no detector-authored fatigue verdict, prediction, or creative prescription', () => {
    const source = readFileSync('src/lib/alerts/detector.ts', 'utf8')
    expect(source).not.toMatch(/alert_type:\s*['"]creative_fatigue['"]/)
    expect(source).not.toMatch(/CTR will start|fatigue is beginning|fatigue signals|hook is not working|audience saturation|Upload New Creative|Prepare New Creative|Refresh Creative/i)
  })
})
