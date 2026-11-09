import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nyDaysAgo, nyToday } from '@/lib/utils/date-utils'

// PRODUCTION-PATH proof for the MCP entry point. A review asked for exactly this: a persisted target
// override must change the verdict, and the lagged cut window must be reachable — neither of which the
// pure-function tests can show, because both defects lived in the CALLER.

// The previous version mocked hydration as a NO-OP while separately mocking
// getTargetRange to always return the override. That proved the symbol was called and the values were
// passed — not that hydration CAUSED them, nor that it ran BEFORE the read. Now hydration actually
// mutates the range the getter serves, and the getter returns DEFAULTS until it does. If hydration is
// removed, or runs after the read, the test sees $64/$98 and fails.
const DEFAULTS = { healthy: 64, watch: 98 }
const PERSISTED = { healthy: 100, watch: 200 }
let servedRange = { ...DEFAULTS }
const readOrder: string[] = []
let accountResolution: { ok: true; account: { id: string; accountId: string; accountName: null } } | { ok: false; reason: 'ambiguous' } = {
  ok: true,
  account: { id: 'acct-1', accountId: 'act_1', accountName: null },
}
let deliveryReadFails = false
let learningReadFails = false
let paidPair: Record<string, unknown> | null = null
let latestDeliveryRows = [{ date_start: '2026-08-25' }]
let latestClosedReadFails = false
let activeDeliveryRange: { start: string | null; end: string | null } | null = null

const getBusinessFactsForWindow = vi.fn(async () => ({ valueBearingBookings: 9 }))
const buildGa4ReconciliationBlock = vi.fn(async () => ({
  reconciliation: { scope: 'exact_appointment_join', scopeReason: null },
}))

const hydrateTargetOverrides = vi.fn(async () => {
  readOrder.push('hydrate')
  servedRange = { ...PERSISTED }     // the persisted row is applied HERE, exactly as the real store does
  return {
    status: 'unversioned', authorityEligible: false,
    reasonCode: 'unversioned_app_setting', reason: 'diagnostic only',
    overrides: { cpa: { healthy: 100, watch: 200 } }, provenance: null,
  }
})
const detectOperatingMode = vi.fn((signals: Record<string, unknown>) => {
  void signals
  return {
    dataMode: 'sufficient', authority: 'approval_only', label: '', reason: '', focus: '',
    canMakePerformanceClaims: true, canClaimPerCampaignRoas: false,
    canRecommendBudgetScale: false, canRecommendBudgetCut: false, canRecommendBudgetChanges: false,
    budgetVerdict: 'insufficient_evidence', authorityBasis: 'unavailable',
    scaleAuthorityBasis: 'unavailable', cutAuthorityBasis: 'unavailable', restrictions: [],
  }
})

vi.mock('@/lib/targets/store', () => ({ hydrateTargetOverrides }))
vi.mock('@/lib/modes/operating-mode', () => ({ detectOperatingMode }))
vi.mock('@/lib/accounts/active-account', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveOnlyActiveAccount: vi.fn(async () => accountResolution),
}))
vi.mock('@/lib/modes/learning-status', () => ({
  readActiveAdsetExitedLearning: vi.fn(async () => learningReadFails
    ? { status: 'unavailable', exited: false }
    : { status: 'available', exited: true }),
}))
vi.mock('@/lib/outcomes/business-facts-reader', () => ({ getBusinessFactsForWindow }))
vi.mock('@/lib/modes/objective', () => ({ resolveAccountObjective: vi.fn(async () => 'bookings') }))
vi.mock('@/lib/attribution/paid-cohort-store', () => ({
  readLatestPaidCohortPair: vi.fn(async () => paidPair),
}))
vi.mock('@/lib/analytics/campaign-roas', () => ({
  getPerCampaignRoas: vi.fn(async () => ({
    spend_basis: 'account_level_insights', campaign_spend_complete: false, campaign_mapping_complete: true,
  })),
}))
vi.mock('@/lib/ga4/booking-reconciliation', () => ({
  buildGa4ReconciliationBlock,
  exactPaidEvidence: vi.fn(() => ({ valueBearingBookings: 4, bookedValue: 400 })),
}))
vi.mock('@/lib/ga4/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({ available: false, paid: {}, organic: {}, metaPaid: {}, byChannel: [], zeroValueEvents: 0 })),
  getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({ available: false, rows: [], totals: {}, attributedShare: null })),
}))
const rows = [{ spend: 100, bookings: 2, date_start: '2026-07-01', ad_id: 'a1' }]
vi.mock('@/lib/supabase/admin', () => {
  const makeChain = () => {
    let dateUpperBound: string | null = null
    let dateLowerBound: string | null = null
    let entityLevel: string | null = null
    const chain: Record<string, unknown> = {}
    chain.select = () => chain
    chain.eq = (column: string, value: string) => {
      if (column === 'entity_level') entityLevel = value
      return chain
    }
    chain.gte = (column: string, value: string) => {
      if (column === 'date_start') dateLowerBound = value
      return chain
    }
    chain.lte = (column: string, value: string) => {
      if (column === 'date_start') dateUpperBound = value
      return chain
    }
    chain.order = () => chain
    chain.limit = () => ({
      data: latestClosedReadFails
        ? null
        : latestDeliveryRows.filter((row) => dateUpperBound === null || row.date_start <= dateUpperBound),
      error: latestClosedReadFails ? { message: 'latest delivery unavailable' } : null,
    })
    chain.maybeSingle = () => ({ data: null, error: null })
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (entityLevel === 'ad') {
        activeDeliveryRange = { start: dateLowerBound, end: dateUpperBound }
      }
      return resolve({
        data: rows,
        error: deliveryReadFails ? { message: 'daily_insights unavailable' } : null,
      })
    }
    return chain
  }
  return { getAdminClient: () => ({ from: () => makeChain() }) }
})

// Persisted override: $100 target / $200 max, DIFFERENT from the built-in $64/$98.
vi.mock('@/lib/targets/target-ranges', async (orig) => {
  const actual = await orig<Record<string, unknown>>()
  return { ...actual, getTargetRange: vi.fn(() => { readOrder.push('read'); return servedRange }) }
})

beforeEach(() => {
  vi.clearAllMocks()
  servedRange = { ...DEFAULTS }     // every test starts on defaults; only hydration changes that
  readOrder.length = 0
  accountResolution = { ok: true, account: { id: 'acct-1', accountId: 'act_1', accountName: null } }
  deliveryReadFails = false
  learningReadFails = false
  paidPair = null
  latestDeliveryRows = [{ date_start: '2026-08-25' }]
  latestClosedReadFails = false
  activeDeliveryRange = null
})

describe('MCP getOperatingMode — the production path', () => {
  it('anchors its 30-day evidence window to the latest synced account day', async () => {
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()

    expect(getBusinessFactsForWindow).toHaveBeenCalledWith(
      'acct-1',
      '2026-07-27',
      '2026-08-25',
    )
  })

  it('excludes a manually synced partial row for today from the closed decision window', async () => {
    const closedDay = nyDaysAgo(2)
    const startDate = new Date(`${closedDay}T00:00:00Z`)
    startDate.setUTCDate(startDate.getUTCDate() - 29)
    latestDeliveryRows = [{ date_start: nyToday() }, { date_start: closedDay }]
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()

    expect(getBusinessFactsForWindow).toHaveBeenCalledWith(
      'acct-1',
      startDate.toISOString().slice(0, 10),
      closedDay,
    )
  })

  it('anchors the seven-day active-delivery window to the same closed-through day', async () => {
    latestDeliveryRows = [{ date_start: '2026-01-31' }]
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()

    expect(activeDeliveryRange).toEqual({ start: '2026-01-25', end: '2026-01-31' })
  })

  it('anchors lagged and corroborating decision windows to the same closed-through day', async () => {
    latestDeliveryRows = [{ date_start: '2026-08-25' }]
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()

    expect(buildGa4ReconciliationBlock).toHaveBeenNthCalledWith(
      2,
      'acct-1',
      '2026-07-29',
      '2026-08-11',
    )
    expect(buildGa4ReconciliationBlock).toHaveBeenNthCalledWith(
      3,
      'acct-1',
      '2026-08-12',
      '2026-08-25',
    )
  })

  it('does not substitute calendar yesterday when the latest synced day cannot be read', async () => {
    latestClosedReadFails = true
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    const result = await getOperatingMode() as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      error_code: 'OPERATING_MODE_DELIVERY_UNAVAILABLE',
      mode: null,
      authority_basis: 'unavailable',
    })
    expect(getBusinessFactsForWindow).not.toHaveBeenCalled()
    expect(detectOperatingMode).not.toHaveBeenCalled()
  })

  it('HYDRATES the saved targets before reading them, and passes the EFFECTIVE values', async () => {
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()

    expect(hydrateTargetOverrides).toHaveBeenCalled()
    // ORDER: hydration must precede every target read, or a cold process evaluates on defaults.
    expect(readOrder[0]).toBe('hydrate')
    expect(readOrder.indexOf('read')).toBeGreaterThan(readOrder.indexOf('hydrate'))
    // CAUSATION: the values are the ones hydration applied, not a separately-stubbed constant.
    const signals = detectOperatingMode.mock.calls[0]![0] as Record<string, unknown>
    expect(signals.targetCpa).toBe(PERSISTED.healthy)   // 100, NOT the built-in 64
    expect(signals.maxCpa).toBe(PERSISTED.watch)        // 200, NOT the built-in 98
    expect(signals.targetPolicyStatus).toBe('unversioned')
  })

  it('supplies a LAGGED PERIOD that can actually clear the gate', async () => {
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()
    const signals = detectOperatingMode.mock.calls[0]![0] as Record<string, unknown>
    const cw = signals.laggedPeriod as { daysSinceEnd: number; start: string; end: string } | null

    expect(cw, 'the MCP tool must build a lagged decision window').not.toBeNull()
    // The whole point: this must CLEAR the gate, where "days since the reporting window ended" never could.
    expect(cw!.daysSinceEnd).toBeGreaterThanOrEqual(14)
    expect(cw!.end < cw!.start === false).toBe(true)
  })

  it('threads campaign SPEND completeness, not just the spend basis', async () => {
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()
    const signals = detectOperatingMode.mock.calls[0]![0] as Record<string, unknown>
    expect(signals.campaignSpendComplete).toBe(false)      // from getPerCampaignRoas
    expect(signals.authoritativeSpendBasis).toBe(true)     // both are passed, not just this one
  })

  it('threads one same-run paid cohort pair into the detector with generation completeness', async () => {
    paidPair = {
      evaluationRunId: '00000000-0000-4000-8000-000000000300',
      recentScale: {
        generationId: '00000000-0000-4000-8000-000000000301', cohortKind: 'recent_scale',
        windowStart: '2026-07-15', windowEnd: '2026-07-28', asOfDate: '2026-07-29',
        complete: true, blockerCodes: [], generationComplete: true, generationBlockerCodes: [],
        spend: 240, bookings: 8, bookedValue: 1_760, metrics: {},
      },
      maturedCut: {
        generationId: '00000000-0000-4000-8000-000000000302', cohortKind: 'matured_cut',
        windowStart: '2026-07-01', windowEnd: '2026-07-14', asOfDate: '2026-07-29',
        complete: false, blockerCodes: ['stale_appointment_state'],
        generationComplete: false, generationBlockerCodes: ['stale_appointment_state'],
        spend: 400, bookings: 0, bookedValue: 0, metrics: {},
      },
    }
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    await getOperatingMode()
    const signals = detectOperatingMode.mock.calls[0]![0] as Record<string, unknown>
    expect(signals.interactionCohorts).toEqual({
      evaluationRunId: '00000000-0000-4000-8000-000000000300',
      recentScale: expect.objectContaining({ complete: true, allUnitsComplete: true, spend: 240, bookings: 8 }),
      maturedCut: expect.objectContaining({ complete: false, allUnitsComplete: false, blockerCodes: ['stale_appointment_state'] }),
    })
  })

  it('does not turn ambiguous account ownership into a healthy low-data mode', async () => {
    accountResolution = { ok: false, reason: 'ambiguous' }
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    const result = await getOperatingMode() as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      mode: null,
      authority_basis: 'unavailable',
    })
    expect(detectOperatingMode).not.toHaveBeenCalled()
    expect(hydrateTargetOverrides).not.toHaveBeenCalled()
  })

  it('does not turn a failed delivery read into zero-spend pre-launch mode', async () => {
    deliveryReadFails = true
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    const result = await getOperatingMode() as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      error_code: 'OPERATING_MODE_DELIVERY_UNAVAILABLE',
      mode: null,
      authority_basis: 'unavailable',
    })
    expect(detectOperatingMode).not.toHaveBeenCalled()
  })

  it('does not turn an unavailable learning-stage read into active-learning mode', async () => {
    learningReadFails = true
    const { getOperatingMode } = await import('@/mcp/tools/operating-mode')
    const result = await getOperatingMode() as Record<string, unknown>

    expect(result).toMatchObject({
      status: 'unavailable',
      error_code: 'OPERATING_MODE_LEARNING_STATUS_UNAVAILABLE',
      mode: null,
      authority_basis: 'unavailable',
    })
    expect(detectOperatingMode).not.toHaveBeenCalled()
  })
})
