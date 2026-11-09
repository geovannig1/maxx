import './_support/outcome-noun-booking'
import { describe, expect, it, vi } from 'vitest'
import type { getAdminClient } from '@/lib/supabase/admin'
import type { AccountInsights } from '@/lib/report/prompt-builder'
import { buildDeterministicDigestNarrative } from '@/lib/report/digest-narrative'
import { buildCommittedDailyDigest, readDailyBudgetTarget } from '@/lib/report/daily-digest-wiring'
import { weeklyExecutiveEvidenceFixture } from './fixtures/weekly-executive'

describe('Daily Digest V3 deterministic narrative', () => {
  it('renders only the three independent committed state lines in canonical order', () => {
    const narrative = buildDeterministicDigestNarrative({
      business: { state: 'higher', line: 'Business line.' },
      paid_delivery: { state: 'mixed', line: 'Paid-delivery line.' },
      data_confidence: { state: 'degraded', line: 'Confidence line.' },
    })

    expect(narrative).toEqual({
      text: 'Business line. Paid-delivery line. Confidence line.',
      source: 'deterministic',
    })
  })
})

type Db = ReturnType<typeof getAdminClient>

function fakeSupabase(rows: Record<string, { data: unknown[] | null; error: { message?: string } | null }>): Db {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: async () => rows[table] ?? { data: [], error: null },
      }),
    }),
  } as unknown as Db
}

const CAMPAIGN_UUID = '11111111-1111-4111-8111-111111111111'

describe('readDailyBudgetTarget', () => {
  it('sums ACTIVE campaign budgets keyed by the uuid primary key', async () => {
    const supabase = fakeSupabase({
      campaigns: { data: [{ id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: '55.00' }], error: null },
      adsets: { data: [{ campaign_id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: null }], error: null },
    })

    expect(await readDailyBudgetTarget(supabase, 'acct')).toBe(55)
  })

  it('reads effective_status and drops a campaign Meta reports as PAUSED despite an ACTIVE status', async () => {
    const supabase = fakeSupabase({
      campaigns: {
        data: [{ id: CAMPAIGN_UUID, status: 'ACTIVE', effective_status: 'PAUSED', daily_budget: '55.00' }],
        error: null,
      },
      adsets: { data: [{ campaign_id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: null }], error: null },
    })

    expect(await readDailyBudgetTarget(supabase, 'acct')).toBeNull()
  })

  it('drops a CBO budget whose ad sets are all paused', async () => {
    const supabase = fakeSupabase({
      campaigns: { data: [{ id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: '55.00' }], error: null },
      adsets: { data: [{ campaign_id: CAMPAIGN_UUID, status: 'PAUSED', daily_budget: null }], error: null },
    })

    expect(await readDailyBudgetTarget(supabase, 'acct')).toBeNull()
  })

  it('falls back to ACTIVE ad-set budgets matched on the campaign uuid FK', async () => {
    const supabase = fakeSupabase({
      campaigns: { data: [{ id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: null }], error: null },
      adsets: { data: [{ campaign_id: CAMPAIGN_UUID, status: 'ACTIVE', daily_budget: 30 }], error: null },
    })

    expect(await readDailyBudgetTarget(supabase, 'acct')).toBe(30)
  })

  it('returns null — never 0 — when either read errors', async () => {
    const supabase = fakeSupabase({
      campaigns: { data: null, error: { message: 'permission denied' } },
      adsets: { data: [], error: null },
    })

    expect(await readDailyBudgetTarget(supabase, 'acct')).toBeNull()
  })

  it('returns null instead of throwing when the client itself blows up', async () => {
    const exploding = { from: () => { throw new Error('connection reset') } } as unknown as Db

    expect(await readDailyBudgetTarget(exploding, 'acct')).toBeNull()
  })
})

const accountInsights: AccountInsights = {
  spend: 92.4, leads: 4, bookings: 1, impressions: 3800, reach: 3410, clicks: 57,
  ctr: 1.5, cpm: null, cpl: 23.1, cpb: null, appointmentValue: null, roas: null,
}
const sevenDay: AccountInsights = {
  spend: 88.6, leads: 4, bookings: 1, impressions: 3700, reach: 3290, clicks: 63,
  ctr: 1.7, cpm: null, cpl: 22.15, cpb: null, appointmentValue: null, roas: null,
}

function wiring(overrides: Partial<Parameters<typeof buildCommittedDailyDigest>[0]> = {}) {
  const executiveEvidence = structuredClone(weeklyExecutiveEvidenceFixture)
  executiveEvidence.lastCompleteDate = '2026-08-11'
  executiveEvidence.meta!.byWindow.lastDay = {
    spendAmount: 92.4, impressions: 3_800, reach: 3_410, linkClicks: 57,
    landingPageViews: 14, leads: 2, modeledBookings: 1,
    modeledBookingValue: 300, modeledClickBookings: 1,
    modeledViewBookings: 0, modeledUnknownBookings: 0,
  }
  executiveEvidence.meta!.byWindow.prior7 = {
    spendAmount: 620.2, impressions: 10_000, reach: 8_000, linkClicks: 145,
    landingPageViews: 130, leads: 14, modeledBookings: 7,
    modeledBookingValue: 2_100, modeledClickBookings: 6,
    modeledViewBookings: 1, modeledUnknownBookings: 0,
  }
  executiveEvidence.outcomes!.byWindow.lastDay = {
    activeAppointments: 3, valueBearingBookings: 3, zeroValueAppointments: 0,
    bookedValue: 900, activeAmountPaidObserved: 900,
    activeAmountPaidRevenue: 900, amountPaidCoverage: { withRecordedAmount: 3, total: 3 },
    canceledAppointments: 0, canceledAmountPaidObserved: 0,
  }
  executiveEvidence.outcomes!.byWindow.prior7 = {
    activeAppointments: 14, valueBearingBookings: 14, zeroValueAppointments: 0,
    bookedValue: 4_200, activeAmountPaidObserved: 4_200,
    activeAmountPaidRevenue: 4_200, amountPaidCoverage: { withRecordedAmount: 14, total: 14 },
    canceledAppointments: 0, canceledAmountPaidObserved: 0,
  }
  return {
    reportDate: '2026-08-11',
    accountName: 'Example Studio',
    accountInsights,
    sevenDayDailyAverage: sevenDay,
    ledgerBookingsToday: 3,
    ledgerBookingsPriorSevenDayAverage: 2,
    executiveEvidence,
    readDailyBudgetTarget: async () => 88.6,
    ...overrides,
  }
}

describe('buildCommittedDailyDigest V3 wiring', () => {
  it('rejects a committed V3 digest when its executive evidence binding is absent', async () => {
    await expect(buildCommittedDailyDigest(wiring({
      executiveEvidence: null as unknown as Parameters<typeof buildCommittedDailyDigest>[0]['executiveEvidence'],
    })))
      .rejects.toThrow(/executive evidence snapshot is required/i)
  })

  it('never invokes a supplied model callback', async () => {
    const llm = vi.fn(async () => ({ text: 'Untrusted model prose.' }))
    const committed = await buildCommittedDailyDigest(wiring({ llm }))

    expect(llm).not.toHaveBeenCalled()
    expect(committed.contract_version).toBe(3)
    expect(committed.narrative.source).toBe('deterministic')
    expect(committed.markdown).toContain(`## Deterministic read\n${committed.narrative.text}`)
    expect(committed.markdown).not.toContain('Untrusted model prose.')
  })

  it('does not read or classify a current budget as historical pacing evidence', async () => {
    const read = vi.fn(async () => 88)
    const committed = await buildCommittedDailyDigest(wiring({ readDailyBudgetTarget: read }))

    expect(read).not.toHaveBeenCalled()
    expect(committed.pacing).toEqual({ spend: 92.4, target: null, band: 'unavailable' })
    expect(committed.markdown).toContain('Weekly budget comparison unavailable')
    expect(committed.markdown).not.toContain('$88.00 daily budget target')
    expect(committed.states.business.state).not.toBe('unavailable')
  })

  it('degrades pacing to unavailable without changing the three evidence states', async () => {
    const available = await buildCommittedDailyDigest(wiring())
    const unavailable = await buildCommittedDailyDigest(wiring({ readDailyBudgetTarget: async () => null }))

    expect(unavailable.pacing).toMatchObject({ target: null, band: 'unavailable' })
    expect(unavailable.states).toEqual(available.states)
    expect(unavailable.narrative).toEqual(available.narrative)
  })

  it('wires both booking planes without substituting zero for an absent ledger read', async () => {
    const committed = await buildCommittedDailyDigest(wiring())
    const executiveEvidence = structuredClone(wiring().executiveEvidence)
    executiveEvidence.outcomes!.byWindow.lastDay = null
    const unavailable = await buildCommittedDailyDigest(wiring({
      executiveEvidence,
    }))

    expect(committed.kpis.find((kpi) => kpi.key === 'bookings_real')?.value).toBe(3)
    expect(committed.kpis.find((kpi) => kpi.key === 'bookings_meta')?.value).toBe(1)
    expect(unavailable.kpis.find((kpi) => kpi.key === 'bookings_real')?.value).toBeNull()
    expect(unavailable.markdown).toContain('- Value-bearing bookings (outcome ledger): unavailable')
    expect(unavailable.markdown).not.toContain('Value-bearing bookings (outcome ledger): 0')
  })

  it('keeps Meta delivery KPIs while current-run outcome facts are unavailable', async () => {
    const executiveEvidence = structuredClone(wiring().executiveEvidence)
    const incompletePlane = {
      status: 'incomplete' as const,
      blockerCodes: ['campaign_adset_outcome_reconciliation_failed'],
      sourceNotBefore: '2026-08-16T14:30:00.000Z',
      checkedLevels: ['campaign' as const, 'adset' as const, 'ad' as const],
    }
    executiveEvidence.sources.meta = {
      availability: 'partial',
      head: '2026-08-16T14:31:00.000Z',
      blockerCodes: ['meta_outcome_plane_incomplete:lastDay'],
    }
    executiveEvidence.meta!.byWindow.lastDay = {
      ...executiveEvidence.meta!.byWindow.lastDay!,
      leads: null,
      modeledBookings: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: null,
      outcomePlane: incompletePlane,
    }
    executiveEvidence.meta!.byWindow.prior7 = {
      ...executiveEvidence.meta!.byWindow.prior7!,
      leads: null,
      modeledBookings: null,
      modeledBookingValue: null,
      modeledClickBookings: null,
      modeledViewBookings: null,
      modeledUnknownBookings: null,
      outcomePlane: incompletePlane,
    }

    const committed = await buildCommittedDailyDigest(wiring({ executiveEvidence }))
    const kpis = Object.fromEntries(committed.kpis.map((row) => [row.key, row.value]))

    expect(kpis.spend).toBe(92.4)
    expect(kpis.ctr).toBe(1.5)
    expect(kpis.leads).toBeNull()
    expect(kpis.bookings_meta).toBeNull()
    expect(kpis.cpl).toBeNull()
    expect(committed.markdown).toContain('- Meta-modelled bookings: unavailable')
    expect(committed.markdown).not.toContain('- Meta-modelled bookings: 0')
    expect(committed.markdown).not.toContain('- Leads: 0')
  })

  it('projects every current KPI from the committed evidence snapshot, never parallel input reads', async () => {
    const executiveEvidence = structuredClone(weeklyExecutiveEvidenceFixture)
    executiveEvidence.meta!.byWindow.lastDay = {
      spendAmount: 12, impressions: 1_000, reach: 800, linkClicks: 20,
      landingPageViews: 18, leads: 2, modeledBookings: 1,
      modeledBookingValue: 300, modeledClickBookings: 1,
      modeledViewBookings: 0, modeledUnknownBookings: 0,
    }
    executiveEvidence.outcomes!.byWindow.lastDay = {
      activeAppointments: 3, valueBearingBookings: 2, zeroValueAppointments: 1,
      bookedValue: 500, activeAmountPaidObserved: 450,
      activeAmountPaidRevenue: 450,
      amountPaidCoverage: { withRecordedAmount: 3, total: 3 },
      canceledAppointments: 0, canceledAmountPaidObserved: 0,
    }

    const committed = await buildCommittedDailyDigest(wiring({
      reportDate: executiveEvidence.lastCompleteDate,
      accountInsights: { ...accountInsights, spend: 999, leads: 999, bookings: 999, ctr: 99, cpl: 1 },
      ledgerBookingsToday: 999,
      executiveEvidence,
    }))
    const kpis = Object.fromEntries(committed.kpis.map((row) => [row.key, row.value]))

    expect(kpis).toMatchObject({
      spend: 12, leads: 2, bookings_real: 2, bookings_meta: 1, ctr: 2, cpl: 6,
    })
    expect(committed.pacing.spend).toBe(12)
  })

  it('shows unavailable snapshot KPI facts instead of falling back to parallel values', async () => {
    const executiveEvidence = structuredClone(weeklyExecutiveEvidenceFixture)
    executiveEvidence.meta = null
    executiveEvidence.outcomes = null

    const committed = await buildCommittedDailyDigest(wiring({ executiveEvidence }))

    expect(committed.kpis.every((row) => row.value === null)).toBe(true)
    expect(committed.pacing.spend).toBeNull()
  })
})
