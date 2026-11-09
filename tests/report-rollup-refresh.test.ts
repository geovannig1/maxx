import { beforeEach, describe, it, expect, vi } from 'vitest'

const { getAdminClientMock } = vi.hoisted(() => ({ getAdminClientMock: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: getAdminClientMock }))

import { computeReportRollup, refreshReportRollups } from '@/lib/report/rollup-refresh'

// daily_reports numbers froze because generateDailyReport runs only for the latest date, so back-day
// rows kept stale morning-after spend/bookings that the dashboard + reconcile read. computeReportRollup
// is the pure restate from the (now-rolling-window-restated) account daily_insights row.

describe('computeReportRollup', () => {
  it('restates spend/leads/bookings and derives cpl/cpb', () => {
    expect(computeReportRollup({ spend: 100, leads: 4, bookings: 2 })).toEqual({
      total_spend: 100, total_leads: 4, total_bookings: 2, avg_cpl: 25, avg_cpb: 50,
    })
  })

  it('leaves cpl/cpb null on zero denominators (never divides by zero)', () => {
    expect(computeReportRollup({ spend: 100, leads: 0, bookings: 0 })).toEqual({
      total_spend: 100, total_leads: 0, total_bookings: 0, avg_cpl: null, avg_cpb: null,
    })
  })

  it('rejects a missing/partial row instead of fabricating zero metrics', () => {
    expect(() => computeReportRollup(null)).toThrow(/unavailable is not zero/i)
    expect(() => computeReportRollup({ spend: 50, leads: null, bookings: 1 }))
      .toThrow(/unavailable is not zero/i)
  })
})

describe('refreshReportRollups', () => {
  const ACCT = '00000000-0000-4000-8000-0000000000e9'

  beforeEach(() => {
    getAdminClientMock.mockReset()
  })

  it('updates only rollup fields so existing narrative/report_json are preserved', async () => {
    const updateBuilder = {
      update: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      select: vi.fn(),
    }
    updateBuilder.update.mockReturnValue(updateBuilder)
    updateBuilder.eq.mockReturnValue(updateBuilder)
    updateBuilder.is.mockReturnValue(updateBuilder)
    updateBuilder.select.mockResolvedValue({ data: [{ id: 'row-1' }], error: null })

    const readBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      gte: vi.fn(),
      lte: vi.fn(),
    }
    readBuilder.select.mockReturnValue(readBuilder)
    readBuilder.eq.mockReturnValue(readBuilder)
    readBuilder.gte.mockReturnValue(readBuilder)
    readBuilder.lte.mockResolvedValue({
      data: [
        { date_start: '2026-08-12', spend: 120, leads: 4, bookings: 1 },
      ],
      error: null,
    })

    const from = vi.fn()
      .mockReturnValueOnce(readBuilder)
      .mockReturnValueOnce(updateBuilder)
    getAdminClientMock.mockReturnValue({ from })

    const updated = await refreshReportRollups(ACCT, '2026-08-11', '2026-08-13')

    expect(updated).toBe(1)
    expect(from).toHaveBeenNthCalledWith(1, 'daily_insights')
    expect(readBuilder.select).toHaveBeenCalledWith('date_start, spend, leads, bookings')
    expect(readBuilder.eq).toHaveBeenNthCalledWith(1, 'ad_account_id', ACCT)
    expect(readBuilder.eq).toHaveBeenNthCalledWith(2, 'entity_level', 'account')
    expect(readBuilder.gte).toHaveBeenCalledWith('date_start', '2026-08-11')
    expect(readBuilder.lte).toHaveBeenCalledWith('date_start', '2026-08-13')

    expect(from).toHaveBeenNthCalledWith(2, 'daily_reports')
    expect(updateBuilder.update).toHaveBeenCalledWith(
      {
        total_spend: 120,
        total_leads: 4,
        total_bookings: 1,
        avg_cpl: 30,
        avg_cpb: 120,
      },
    )
    expect(updateBuilder.eq).toHaveBeenNthCalledWith(1, 'ad_account_id', ACCT)
    expect(updateBuilder.eq).toHaveBeenNthCalledWith(2, 'report_date', '2026-08-12')
    expect(updateBuilder.is).toHaveBeenCalledWith('executive_evidence_generation_id', null)

    // Critical: the payload must NOT touch narrative fields. If it did, an existing
    // report's LLM-generated summary / report_json / full_report_md would be wiped.
    const payload = updateBuilder.update.mock.calls[0][0]
    expect(payload).not.toHaveProperty('summary_text')
    expect(payload).not.toHaveProperty('full_report_md')
    expect(payload).not.toHaveProperty('report_json')
  })

  it('updates every existing report row in the date window without inserting missing days', async () => {
    const updateBuilder = {
      update: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      select: vi.fn(),
    }
    updateBuilder.update.mockReturnValue(updateBuilder)
    updateBuilder.eq.mockReturnValue(updateBuilder)
    updateBuilder.is.mockReturnValue(updateBuilder)
    updateBuilder.select
      .mockResolvedValueOnce({ data: [{ id: 'row-1' }], error: null })
      .mockResolvedValueOnce({ data: [{ id: 'row-2' }], error: null })

    const readBuilder = {
      select: vi.fn(),
      eq: vi.fn(),
      gte: vi.fn(),
      lte: vi.fn(),
    }
    readBuilder.select.mockReturnValue(readBuilder)
    readBuilder.eq.mockReturnValue(readBuilder)
    readBuilder.gte.mockReturnValue(readBuilder)
    readBuilder.lte.mockResolvedValue({
      data: [
        { date_start: '2026-08-03', spend: 10, leads: 0, bookings: 0 },
        { date_start: '2026-08-04', spend: 20, leads: 1, bookings: 0 },
      ],
      error: null,
    })

    const from = vi.fn()
      .mockReturnValueOnce(readBuilder)
      .mockReturnValue(updateBuilder)
    getAdminClientMock.mockReturnValue({ from })

    const updated = await refreshReportRollups(ACCT, '2026-08-03', '2026-08-04')

    expect(updated).toBe(2)
    expect(updateBuilder.update).toHaveBeenCalledTimes(2)
    expect(updateBuilder.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ total_spend: 10, total_leads: 0, total_bookings: 0 }),
    )
    expect(updateBuilder.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ total_spend: 20, total_leads: 1, total_bookings: 0 }),
    )
  })
})
