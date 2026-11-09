import './_support/outcome-noun-booking'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildUserMessage } from '@/lib/report/prompt-builder'

/** Outcome uuid fixture for a numeric case id (economics identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

// CONSUMER-LEVEL proofs. The reconciler tests prove the join; these prove the surfaces that emit
// money actually consume it, and say UNAVAILABLE rather than substituting GA telemetry.
//
// Each mocks the boundary its surface depends on and asserts the OUTPUT a human or the LLM sees.

const buildGa4ReconciliationBlock = vi.fn()
const exactPaidEvidence = vi.fn()
const loadEconomicsInputs = vi.fn()
const readAccountSpendWindow = vi.fn()
const readGovernedEconomicsPolicy = vi.fn()
const readProcessorSettlementWindow = vi.fn()
const readVariableCostWindow = vi.fn()
const readPaidTouchAdAssignments = vi.fn()

vi.mock('@/lib/ga4/booking-reconciliation', async (orig) => {
  const actual = await orig<typeof import('@/lib/ga4/booking-reconciliation')>()
  return { ...actual, buildGa4ReconciliationBlock, exactPaidEvidence }
})
vi.mock('@/lib/outcomes/ledger-account', () => ({
  resolveAdAccountId: vi.fn(async () => '00000000-0000-4000-8000-000000000079'),
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => ({}) }))
vi.mock('@/lib/economics/settings', () => ({ loadEconomicsInputs }))
vi.mock('@/lib/economics/ad-spend-reader', () => ({ readAccountSpendWindow }))
vi.mock('@/lib/economics/economics-policy-reader', () => ({ readGovernedEconomicsPolicy }))
vi.mock('@/lib/economics/settlement-reader', () => ({ readProcessorSettlementWindow }))
vi.mock('@/lib/economics/variable-cost-reader', () => ({ readVariableCostWindow }))
vi.mock('@/lib/economics/paid-touch-assignment-reader', () => ({ readPaidTouchAdAssignments }))

const recon = (over: Record<string, unknown> = {}) => ({
  reconciliation: {
    scope: 'pending_configuration', scopeReason: 'appointment_id not registered',
    business: {
      confirmedAppointments: 5, valueBearingBookings: 4, zeroValueAppointments: 1,
      canceledAppointments: 2, bookedValue: 1200, observedCollectedValue: 600,
      recordedOutcomeValue: 600,
      amountPaidCoverage: { withRecordedAmount: 5, total: 5 },
    },
    byChannel: [], warnings: [], ...over,
  },
  lines: [],
})

beforeEach(() => {
  vi.resetModules()
  buildGa4ReconciliationBlock.mockReset()
  exactPaidEvidence.mockReset()
  loadEconomicsInputs.mockReset()
  readAccountSpendWindow.mockReset()
  readGovernedEconomicsPolicy.mockReset()
  readProcessorSettlementWindow.mockReset()
  readVariableCostWindow.mockReset()
  readPaidTouchAdAssignments.mockReset()
  readAccountSpendWindow.mockResolvedValue({
    status: 'available', totalSpend: '500.0000', dayCount: 30, blockerCodes: [],
  })
  readGovernedEconomicsPolicy.mockResolvedValue({
    status: 'unavailable', blockerCodes: ['economics_policy_missing'],
  })
  loadEconomicsInputs.mockResolvedValue({
    status: 'available',
    inputs: { aov: 220, gross_margin_rate: 0.5, repeat_rate: null, source_note: 'Owner estimate' },
    reason_code: null,
    unavailable_reason: null,
    provenance: {
      source: 'app_settings.economics_inputs',
      status: 'unversioned_app_setting',
      updated_at: '2026-07-30T12:00:00Z',
      owner_approval_recorded: false,
      version_recorded: false,
    },
  })
})
afterEach(() => { vi.clearAllMocks() })

describe('[16] MCP economics uses ledger/exact facts and never raw GA event value', () => {
  it('rejects fractional lookback windows at the tool boundary', async () => {
    const { getEconomics } = await import('@/mcp/tools/economics')
    await expect(getEconomics({ window_days: 7.5 })).rejects.toThrow(/window_days must be an integer/i)
  })

  it('rejects a half-specified explicit economics range', async () => {
    const { getEconomics } = await import('@/mcp/tools/economics')
    await expect(getEconomics({ start_date: '2026-07-27' })).rejects.toThrow(/provided together/i)
  })

  it('uses an explicit governed date range without recomputing from the calendar', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon())
    exactPaidEvidence.mockReturnValue(null)

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ start_date: '2026-08-20', end_date: '2026-08-25' }) as {
      window: { start: string; end: string; days: number }
    }

    expect(readAccountSpendWindow).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-4000-8000-000000000079',
      { start: '2026-08-20', end: '2026-08-25' },
      expect.any(String),
    )
    expect(buildGa4ReconciliationBlock).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000079',
      '2026-08-20',
      '2026-08-25',
    )
    expect(out.window).toEqual({ start: '2026-08-20', end: '2026-08-25', days: 6 })
  })

  it('reports paid CPA as UNAVAILABLE with a reason when there is no exact join', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon())
    exactPaidEvidence.mockReturnValue(null)

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ window_days: 30 }) as Record<string, never>

    const paid = out.paid as unknown as Record<string, unknown>
    expect(paid.cpa).toBeNull()
    expect(paid.value_bearing_bookings).toBeNull()
    expect(String(paid.unavailable_reason)).toMatch(/EXACT booking-id join/)
    expect(String(paid.unavailable_reason)).toMatch(/NOT a claim that paid produced zero bookings/)
    expect(String(paid.unavailable_reason)).toMatch(/raw GA event counts must NOT be substituted/)

    // Ledger business facts still stand.
    const business = out.business as unknown as Record<string, unknown>
    expect(business.confirmed_appointments).toBe(5)
    expect(business.booked_value).toBe(1200)
    expect(business.outcome_recorded_checkout_revenue).toBe(600)
    const sources = out.sources as unknown as Record<string, unknown>
    expect(String(sources.business_truth)).toMatch(/Outcome ledger/)
    expect(String(sources.paid_attribution)).toMatch(/UNAVAILABLE/)
  })

  it('keeps GA Paid Social session associations diagnostic and withholds Meta CPA/ROAS', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon({ scope: 'exact_appointment_join', scopeReason: null }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 4, bookedValue: 900, recordedRevenue: 800 })

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ window_days: 30 }) as Record<string, never>
    const paid = out.paid as unknown as Record<string, unknown>

    expect(paid.value_bearing_bookings).toBe(4)
    expect(paid.booked_value).toBe(900)      // LEDGER value, not GA event value
    expect(paid.outcome_recorded_checkout_revenue).toBe(800)
    expect(paid.cpa).toBeNull()
    expect(paid.revenue_roas).toBeNull()
    expect(paid.association_basis).toBe('ga4_paid_social_session_association')
    expect(paid.action_authority).toBe('diagnostic_only')
    expect(String(paid.unavailable_reason)).toMatch(/GA Paid Social.*not Meta platform identity/i)
    expect(String(paid.unavailable_reason)).toMatch(/view-through/i)
    const sources = out.sources as unknown as Record<string, unknown>
    expect(String(sources.paid_attribution)).toMatch(/GA4 Paid Social session association/i)
    expect(String(sources.paid_attribution)).toMatch(/NOT exact Meta paid attribution/i)
    expect(String(sources.paid_attribution)).not.toMatch(/^EXACT/)
  })

  it('does not substitute AOV or build a profit view when economics inputs are unavailable', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon({ scope: 'exact_appointment_join', scopeReason: null }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 4, bookedValue: 900, recordedRevenue: 800 })
    loadEconomicsInputs.mockResolvedValue({
      status: 'unavailable',
      inputs: null,
      reason_code: 'not_configured',
      unavailable_reason: 'Economics inputs have not been configured.',
      provenance: null,
    })

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ window_days: 30 }) as Record<string, unknown>
    const profit = out.profit_view as Record<string, unknown>
    const benchmark = out.champion_benchmark as Record<string, unknown>

    expect(profit).toMatchObject({ status: 'unavailable', action_authority: 'none' })
    expect(String(profit.unavailable_reason)).toMatch(/AOV\/margin estimates.*not substitutes/i)
    expect(JSON.stringify(profit)).not.toContain('275')
    expect(benchmark).toMatchObject({
      context_status: 'historical_audit_only',
      action_authority: 'none',
      current_policy: false,
    })
    expect(String(benchmark.warning)).toMatch(/not a current target, scaling rule, or money authority/i)
  })

  it('never turns AOV/margin estimates plus booked outcomes into collected contribution', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon({ scope: 'exact_appointment_join', scopeReason: null }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 4, bookedValue: 900, recordedRevenue: 800 })

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ window_days: 30 }) as Record<string, unknown>
    const profit = out.profit_view as Record<string, unknown>

    expect(profit).toMatchObject({
      status: 'unavailable',
      reason_code: 'settled_contribution_unavailable',
      action_authority: 'none',
    })
    expect(String(profit.unavailable_reason)).toMatch(/processor-settled collections/i)
    expect(String(profit.unavailable_reason)).toMatch(/governed variable costs/i)
    expect(String(profit.unavailable_reason)).not.toMatch(/refund|cancell/i)
    expect(JSON.stringify(profit)).not.toMatch(/profit_per_booking|contribution_per_booking|raise-budget condition/i)
  })

  it('publishes observed contribution and a partial exact paid-touch association without causal authority', async () => {
    buildGa4ReconciliationBlock.mockResolvedValue(recon({ scope: 'exact_appointment_join', scopeReason: null }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 4, bookedValue: 900, recordedRevenue: 800 })
    readGovernedEconomicsPolicy.mockResolvedValue({
      status: 'available', approvalId: '00000000-0000-4000-8000-000000000179',
      policyId: '00000000-0000-4000-8000-000000000279', policyHash: `sha256:${'a'.repeat(64)}`,
      objective: 'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', reviewDueAt: '2027-01-01T00:00:00Z',
      realizationHorizonDays: 30,
      settlementSource: { processor: 'unknown_processor', processorAccountRef: 'merchant_1' },
      variableCostBasis: 'outcome_actual_entries',
      requiredCostSources: ['owner_actual_cost_export'],
      allowedVariableCostCategories: ['consumables'],
      variableCostCategorySources: { consumables: 'owner_actual_cost_export' },
      fixedOverheadTreatment: 'excluded_from_contribution',
    })
    readProcessorSettlementWindow.mockResolvedValue({
      source: { batchId: '00000000-0000-4000-8000-000000000379', processor: 'unknown_processor',
        processorAccountRef: 'merchant_1', importSequence: 1 },
      summary: {
        businessMoney: { status: 'available', collectedRevenueExTaxMinor: 100_000,
          refundsAndChargebacksMinor: 5_000, paymentProcessingFeesMinor: 3_000,
          netCollectedBeforeVariableCostsAndAdsMinor: 92_000, excludedTaxMinor: 0, eventCount: 3 },
        outcomeLinkage: { status: 'unavailable', totals: null, outcomeCount: null },
        blockerCodes: ['outcome_linkage_incomplete'],
        diagnostics: { sourceEventCount: 3, inWindowEventCount: 3, ignoredOutsideWindow: 0, unlinkedEventCount: 1 },
      },
      events: [
        { id: 'payment', processorEventId: 'payment', processorTransactionId: 'transaction-1',
          eventKind: 'payment_settled', occurredAt: '2026-07-01T12:00:00Z',
          availableAt: '2026-07-01T13:00:00Z', currency: 'USD', outcomeId: oid(101),
          collectedExTaxMinor: 100_000, refundsExTaxMinor: 0, chargebacksExTaxMinor: 0,
          recoveredChargebacksExTaxMinor: 0, paymentFeesMinor: 0, taxAmountMinor: 0 },
        { id: 'refund', processorEventId: 'refund', processorTransactionId: 'transaction-1',
          eventKind: 'refund_settled', occurredAt: '2026-07-02T12:00:00Z',
          availableAt: '2026-07-02T13:00:00Z', currency: 'USD', outcomeId: null,
          collectedExTaxMinor: 0, refundsExTaxMinor: 5_000, chargebacksExTaxMinor: 0,
          recoveredChargebacksExTaxMinor: 0, paymentFeesMinor: 0, taxAmountMinor: 0 },
        { id: 'fee', processorEventId: 'fee', processorTransactionId: 'transaction-1',
          eventKind: 'fee_adjustment', occurredAt: '2026-07-02T12:00:00Z',
          availableAt: '2026-07-02T13:00:00Z', currency: 'USD', outcomeId: oid(101),
          collectedExTaxMinor: 0, refundsExTaxMinor: 0, chargebacksExTaxMinor: 0,
          recoveredChargebacksExTaxMinor: 0, paymentFeesMinor: 3_000, taxAmountMinor: 0 },
      ],
    })
    readVariableCostWindow.mockResolvedValue({
      policyId: '00000000-0000-4000-8000-000000000279', sourceCuts: [],
      summary: { status: 'available', incurredVariableCostsMinor: 20_000,
        reversedVariableCostsMinor: 0, totalVariableCostsMinor: 20_000,
        byCategoryMinor: { consumables: 20_000 }, outcomeCount: 2, eventCount: 2,
        blockerCodes: [], diagnostics: { sourceEventCount: 2, inWindowEventCount: 2,
          ignoredOutsideWindow: 0, requiredSourceCount: 1, coveredSourceCount: 1 } },
      events: [
        { id: 'cost-1', costSource: 'owner_actual_cost_export', sourceEventId: 'cost-1',
          eventKind: 'cost_incurred', reversesSourceEventId: null,
          occurredAt: '2026-07-02T12:00:00Z', availableAt: '2026-07-02T13:00:00Z',
          currency: 'USD', outcomeId: oid(101), category: 'consumables', amountMinor: 15_000 },
        { id: 'cost-2', costSource: 'owner_actual_cost_export', sourceEventId: 'cost-2',
          eventKind: 'cost_incurred', reversesSourceEventId: null,
          occurredAt: '2026-07-02T12:00:00Z', availableAt: '2026-07-02T13:00:00Z',
          currency: 'USD', outcomeId: oid(202), category: 'consumables', amountMinor: 5_000 },
      ],
    })
    readPaidTouchAdAssignments.mockResolvedValue({
      assignments: [{
        outcomeId: oid(101),
        linkId: '00000000-0000-4000-8000-000000000101',
        touchId: '00000000-0000-4000-9000-000000000101',
        metaCampaignId: '1001', metaAdsetId: '2001', metaAdId: '3001',
        observedAt: '2026-06-30T12:00:00Z', linkedAt: '2026-07-01T11:00:00Z',
        policyVersion: 1,
      }],
      requestedOutcomeCount: 2,
      unassignedOutcomeIds: [202],
      incompleteIdentityOutcomeIds: [],
    })

    const { getEconomics } = await import('@/mcp/tools/economics')
    const out = await getEconomics({ window_days: 30 }) as Record<string, unknown>
    const profit = out.profit_view as Record<string, unknown>
    expect(profit).toMatchObject({
      status: 'paid_touch_association_partial', action_authority: 'none',
      north_star_status: 'unavailable',
      reason_code: 'incremental_contribution_unavailable',
      blocker_codes: [
        'causal_comparison_missing',
        'paid_touch_classification_incomplete',
        'payment_to_experiment_assignment_missing',
      ],
      observedBusinessContribution: {
        status: 'available', components: { contributionAfterAds: '220.0000' },
      },
      adAttributedContribution: {
        status: 'partial',
        basis: 'exact_positive_paid_touch_association_noncausal',
        components: { contributionAfterAds: '270.0000' },
        blockerCodes: ['paid_touch_classification_incomplete'],
      },
      incrementalContribution: { status: 'unavailable' },
    })
  })
})

describe('[17] campaign ROAS is unavailable without an exact join, and ledger-valued with one', () => {
  const insights = [{ meta_campaign_id: 'c1', spend: 400, bookings: 3, bookings_view_through: 0 }]

  const mockDb = (campaignName: string) => ({
    from: (t: string) => t === 'daily_insights'
      ? { select: () => ({ eq: () => ({ eq: () => ({ gte: () => ({ lte: () => ({ data: insights }) }) }) }) }) }
      : { select: () => ({ in: () => ({ data: [{ campaign_id: 'c1', campaign_name: campaignName }] }) }) },
  })

  it('returns roas null with a scope reason when no exact evidence exists', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb('summer studio promo') }))
    vi.doMock('@/lib/ga4/client', () => ({
      getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({
        available: true, rows: [{ campaign: 'summer_studio', confirmationEvents: 9, eventValue: 2700 }],
        totals: { confirmationEvents: 9, eventValue: 2700 }, attributedShare: 1,
      })),
      getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
        available: true, paid: { confirmationEvents: 9, eventValue: 2700 },
        organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 9, eventValue: 2700 },
        byChannel: [], zeroValueEvents: 0,
      })),
      isMetaPaidChannel: (c: string) => c === 'Paid Social',
    }))
    buildGa4ReconciliationBlock.mockResolvedValue(recon())
    exactPaidEvidence.mockReturnValue(null)

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('acct-1', '2026-05-01', '2026-05-31')

    // GA reports 9 events worth $2700 against $400 spend. The old code would have called that 6.75x.
    expect(out.rows[0].ga4_confirmation_events).toBe(9)
    expect(out.rows[0].roas).toBeNull()
    expect(out.rows[0].exact_booked_value).toBeNull()
    expect(out.paid.roas).toBeNull()
    // BLENDED MER is a different quantity and IS available now: total Acuity checkout revenue (all
    // sources) / authoritative Meta spend. 600 revenue / 500 spend = 1.2. It must never be presented as paid
    // performance — the basis string says so.
    expect(out.account.mer).toBe(1.2)
    expect(out.account.mer_basis).toMatch(/BLENDED/)
    expect(out.account.mer_basis).toMatch(/NOT paid performance and NOT (?:a )?paid ROAS/)
    expect(out.attribution_scope).toBe('pending_configuration')
    expect(out.attribution_scope_reason).toMatch(/appointment_id/)
  })

  it('shows exact session-attributed ledger values but still withholds Meta paid ROAS', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb('summer studio promo') }))
    vi.doMock('@/lib/ga4/client', () => ({
      getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({
        available: true, rows: [{ campaign: 'summer_studio', confirmationEvents: 9, eventValue: 2700 }],
        totals: { confirmationEvents: 9, eventValue: 2700 }, attributedShare: 1,
      })),
      getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
        available: true, paid: { confirmationEvents: 9, eventValue: 2700 },
        organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 9, eventValue: 2700 },
        byChannel: [], zeroValueEvents: 0,
      })),
      isMetaPaidChannel: (c: string) => c === 'Paid Social',
    }))
    buildGa4ReconciliationBlock.mockResolvedValue(recon({
      scope: 'exact_appointment_join', scopeReason: null,
      byChannel: [{ channel: 'Paid Social', campaign: 'summer_studio', valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700, zeroValueAppointments: 0 }],
    }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700 })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('acct-1', '2026-05-01', '2026-05-31')

    expect(out.attribution_scope).toBe('exact_appointment_join')
    expect(out.rows[0].exact_value_bearing_bookings).toBe(2)
    expect(out.rows[0].exact_booked_value).toBe(800)
    expect(out.rows[0].exact_checkout_revenue).toBe(700)
    expect(out.rows[0].roas).toBeNull()
    expect(out.paid.roas).toBeNull()
    expect(out.paid.attribution_reason).toMatch(/GA Paid Social is a session channel/)
    expect(out.paid.attribution_reason).toMatch(/Meta view-through outcomes/)
    // MER stays BLENDED even when exact session-attributed paid values exist: they are different questions.
    expect(out.account.mer).toBe(1.2)
  })
})

describe('[15] the daily report prompt cannot contain contradictory money language', () => {
  it('states GA is not money and the ledger is, in the same assembled prompt', () => {
    const msg = buildUserMessage({
      date: '2026-05-10', accountName: 'Example Studio', currency: 'USD',
      accountInsights: { spend: 500, leads: 0, bookings: 3, impressions: 100, reach: 90, clicks: 5, ctr: 5, cpm: 300, cpl: null, cpb: 15, appointmentValue: null, roas: null },
      prevDayInsights: null, prev7dayInsights: null, topCampaigns: [], alerts: [],
      ga4: {
        todayPaidConfirmationEvents: 2, todayPaidEventValue: 400,
        paidConfirmationEvents30: 9, paidEventValue30: 2700,
        todayOrganicConfirmationEvents: 1, todayOrganicEventValue: 100,
        organicConfirmationEvents30: 5, organicEventValue30: 900, zeroValueEvents30: 1,
      },
      outcomes: {
        todayConfirmedAppointments: 3, todayValueBearingBookings: 2, todayZeroValueAppointments: 1,
        todayBookedValue: 550, todayObservedCollectedValue: 500, todayRecordedOutcomeValue: 500, todayAmountPaidCoverage: { withRecordedAmount: 3, total: 3 }, confirmedAppointments30: 42, valueBearingBookings30: 38,
        zeroValueAppointments30: 4, bookedValue30: 9000, observedCollectedValue30: 4200,
        amountPaidCoverage30: { withRecordedAmount: 30, total: 38 }, metaSpend30: 500,
      },
      reconciliation: [
        '=== BOOKING TRUTH (Acuity ledger) vs WEB ATTRIBUTION (GA4) ===',
        '  Web attribution: UNAVAILABLE (pending_configuration) — appointment_id not registered',
      ],
    })

    // The GA block must never claim money...
    expect(msg).toMatch(/NOT bookings, NOT revenue, and NOT a basis for CPA, ROAS or MER/)
    expect(msg).toMatch(/Meta paid ROAS is NOT stated here/)
    // ...and must not contain the old contradictory phrasing anywhere.
    expect(msg).not.toMatch(/the real paid efficiency/)
    expect(msg).not.toMatch(/GA4 PAID revenue/)
    // The ledger block owns the counts, with one vocabulary.
    expect(msg).toMatch(/42 confirmed booking\(s\) — 38 value-bearing, 4 zero-value/)
    expect(msg).toMatch(/\$9,?000\.00 booked value/)
    expect(msg).toMatch(/NEVER call one a test/)
    // Scheduled booked value and amount paid on active appointments are visibly different quantities.
    expect(msg).toMatch(/Amount paid on active bookings \(30d\)/)
    expect(msg).toMatch(/amount_paid exists for only 30\/38 active bookings/)
    expect(msg).toMatch(/observed amount_paid lower bound/i)
    expect(msg).toMatch(/Active-booking amount\/spend ratio \(30d\) = UNAVAILABLE/i)
    expect(msg).not.toMatch(/Revenue MER \(30d\) = 8\.40x/)
  })
})

// ── Review: output-level regressions for campaign mapping and the spend denominator ──
describe('[F3/F5] campaign ROAS and MER fail closed on incomplete mapping or a degraded denominator', () => {
  const insights = [{ meta_campaign_id: 'c1', spend: 400, bookings: 3, bookings_view_through: 0 }]
  const acctRows = [{ spend: 400 }]

  /** `accountRows: null` simulates NO account-level insight row, forcing the campaign-row-sum fallback. */
  // Both reads are .eq('ad_account_id').eq('entity_level').gte().lte(); they differ only by the
  // entity_level VALUE, so the fake dispatches on that rather than on chain shape.
  const mockDb = (accountRows: Array<{ spend: number }> | null) => ({
    from: (t: string) => t === 'daily_insights'
      ? { select: () => ({
          eq: () => ({
            eq: (_col: string, level: string) => ({
              gte: () => ({ lte: () => level === 'account'
                ? { data: accountRows ?? [], error: accountRows ? null : { message: 'no account rows' } }
                : { data: insights } }),
            }),
          }) }) }
      : { select: () => ({ in: () => ({ data: [{ campaign_id: 'c1', campaign_name: 'summer studio promo' }] }) }) },
  })

  const ga = (campaign: string) => ({
    getGa4ConfirmationTelemetryByCampaign: vi.fn(async () => ({
      available: true, rows: [{ campaign, confirmationEvents: 9, eventValue: 2700 }],
      totals: { confirmationEvents: 9, eventValue: 2700 }, attributedShare: 1,
    })),
    getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({
      available: true, paid: { confirmationEvents: 9, eventValue: 2700 },
      organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 9, eventValue: 2700 },
      byChannel: [], zeroValueEvents: 0,
    })),
    isMetaPaidChannel: (c: string) => c === 'Paid Social',
  })

  const exactRecon = (campaign: string) => recon({
    scope: 'exact_appointment_join', scopeReason: null,
    byChannel: [{ channel: 'Paid Social', campaign, valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700, zeroValueAppointments: 0 }],
  })

  it('an UNMAPPED exact paid booking makes ALL per-campaign ROAS unavailable, not a lower bound', async () => {
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb(acctRows) }))
    vi.doMock('@/lib/ga4/client', () => ga('a_campaign_that_matches_nothing'))
    buildGa4ReconciliationBlock.mockResolvedValue(exactRecon('a_campaign_that_matches_nothing'))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700 })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('acct-1', '2026-05-01', '2026-05-31')

    expect(out.campaign_mapping_complete).toBe(false)
    expect(out.campaign_mapping_reason).toMatch(/could belong to any campaign/)
    expect(out.rows[0].roas).toBeNull()          // NOT 800/400 = 2 from a partial numerator
    expect(out.rows[0].exact_booked_value).toBeNull()
  })

  it('[F5] an account row does NOT prove campaign denominators — the sum must reconcile', async () => {
    // Reviewer's reproduction: account spend $400, synced campaign rows $100, an exact $800 booking
    // mapped to that campaign -> 800/100 = 8x ROAS, permitted purely because an account row existed.
    const shortCampaign = [{ meta_campaign_id: 'c1', spend: 100, bookings: 3, bookings_view_through: 0 }]
    vi.doMock('@/lib/supabase/admin', () => ({
      getAdminClient: () => ({
        from: (t: string) => t === 'daily_insights'
          ? { select: () => ({ eq: () => ({ eq: (_c: string, level: string) => ({
              gte: () => ({ lte: () => level === 'account'
                ? { data: [{ spend: 400 }], error: null }     // authoritative account row EXISTS
                : { data: shortCampaign } }) }) }) }) }       // ...but campaign rows only total $100
          : { select: () => ({ in: () => ({ data: [{ campaign_id: 'c1', campaign_name: 'summer studio promo' }] }) }) },
      }),
    }))
    vi.doMock('@/lib/ga4/client', () => ga('summer_studio'))
    buildGa4ReconciliationBlock.mockResolvedValue(exactRecon('summer_studio'))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700 })
    readAccountSpendWindow.mockResolvedValueOnce({
      status: 'available', totalSpend: '400.0000', dayCount: 30, blockerCodes: [],
    })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('acct-1', '2026-05-01', '2026-05-31')

    expect(out.spend_basis).toBe('account_level_insights')   // the account row IS authoritative...
    expect(out.campaign_spend_complete).toBe(false)          // ...but the campaign rows do not reconcile
    expect(out.campaign_spend_reason).toMatch(/75% unaccounted/)
    expect(out.rows[0].roas).toBeNull()                      // NOT 800/100 = 8x
  })

  it('a DEGRADED spend denominator withholds paid ROAS and blended MER in the NORMAL path', async () => {
    // The GA-unavailable branch already required an authoritative basis; the GA-AVAILABLE branch did
    // not, so ordinary operation could show MER on a denominator the UI was warning was incomplete.
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb(null) }))
    vi.doMock('@/lib/ga4/client', () => ga('summer_studio'))
    buildGa4ReconciliationBlock.mockResolvedValue(exactRecon('summer_studio'))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700 })
    readAccountSpendWindow.mockResolvedValueOnce({
      status: 'unavailable', totalSpend: null, dayCount: null, blockerCodes: ['meta_spend_day_missing:2026-05-17'],
    })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('acct-1', '2026-05-01', '2026-05-31')

    expect(out.spend_basis).toBe('account_level_window_incomplete')
    expect(out.paid.roas).toBeNull()
    expect(out.account.mer).toBeNull()           // the normal path, not just the GA-unavailable one
    expect(out.rows[0].roas).toBeNull()
  })

  it('withholds every return ratio when the exact account insight window is missing a day', async () => {
    readAccountSpendWindow.mockResolvedValue({
      status: 'unavailable', totalSpend: null, dayCount: null,
      blockerCodes: ['meta_spend_day_missing:2026-05-17'],
    })
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb(acctRows) }))
    vi.doMock('@/lib/ga4/client', () => ga('summer_studio'))
    buildGa4ReconciliationBlock.mockResolvedValue(exactRecon('summer_studio'))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 2, bookedValue: 800, recordedRevenue: 700 })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('00000000-0000-4000-8000-000000000079', '2026-05-01', '2026-05-31')

    expect(out.spend_basis).toBe('account_level_window_incomplete')
    expect(out.campaign_spend_reason).toMatch(/meta_spend_day_missing/)
    expect(out.paid.roas).toBeNull()
    expect(out.account.mer).toBeNull()
    expect(out.rows.every((row) => row.roas === null)).toBe(true)
  })

  it('counts an unmapped zero-price appointment with positive amount_paid as a mapping blocker', async () => {
    readAccountSpendWindow.mockResolvedValue({
      status: 'available', totalSpend: '400.0000', dayCount: 31, blockerCodes: [],
    })
    vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => mockDb(acctRows) }))
    vi.doMock('@/lib/ga4/client', () => ga('summer_studio'))
    buildGa4ReconciliationBlock.mockResolvedValue(recon({
      scope: 'exact_appointment_join', scopeReason: null,
      byChannel: [{
        channel: 'Paid Social', campaign: 'unmapped_zero_price', valueBearingBookings: 0,
        zeroValueAppointments: 1, bookedValue: 0, recordedRevenue: 100,
      }],
    }))
    exactPaidEvidence.mockReturnValue({ valueBearingBookings: 0, bookedValue: 0, recordedRevenue: 100 })

    const { getPerCampaignRoas } = await import('@/lib/analytics/campaign-roas')
    const out = await getPerCampaignRoas('00000000-0000-4000-8000-000000000079', '2026-05-01', '2026-05-31')

    expect(out.campaign_mapping_complete).toBe(false)
    expect(out.campaign_mapping_reason).toMatch(/1 exact session-attributed appointment/i)
    expect(out.rows.every((row) => row.roas === null)).toBe(true)
  })
})
