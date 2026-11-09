import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAdminClient = vi.fn()
const requireOutcomeLedgerHealth = vi.fn()
const readPaidTouchAdAssignments = vi.fn()
const getConfirmationFacts = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient }))
// the gate is per enabled outcome source (src/lib/outcomes/source-health.ts).
vi.mock('@/lib/outcomes/source-health', () => ({ requireOutcomeLedgerHealth }))
vi.mock('@/lib/economics/paid-touch-assignment-reader', () => ({ readPaidTouchAdAssignments }))
vi.mock('@/lib/outcomes/confirmation-facts', () => ({ getConfirmationFacts }))

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

const healthyAt = '2026-09-05T15:00:00Z'

/** Outcome uuid fixture for a numeric case id (the cohort key is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

/** One `v_business_outcomes` row as the database returns it for the reader's projection. */
type LedgerRow = {
  id: string
  currency: string
  price: number | null
  amount_paid: number | null
  status: string
  business_state: 'active_value_bearing' | 'active_zero_value' | 'cancelled' | null
  booking_date_et: string
}

function ledgerRow(id: number, values: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: oid(id),
    currency: 'USD',
    price: 100,
    amount_paid: 100,
    status: 'confirmed',
    business_state: 'active_value_bearing',
    booking_date_et: '2026-09-02',
    ...values,
  }
}

function fakeClient(rows: LedgerRow[] | null) {
  const calls: Array<{ table: string; accountIds: string[]; from: string | null; to: string | null }> = []
  return {
    calls,
    client: {
      from(table: string) {
        const call = { table, accountIds: [] as string[], from: null as string | null, to: null as string | null }
        calls.push(call)
        const query = {
          select() { return query },
          eq(field: string, value: string) {
            if (field === 'ad_account_id') call.accountIds.push(value)
            return query
          },
          gte(_field: string, value: string) { call.from = value; return query },
          lte(_field: string, value: string) { call.to = value; return query },
          order() { return query },
          range(from: number, to: number) {
            if (rows === null) return Promise.resolve({ data: null, error: null })
            const selected = rows
              .filter(row => call.from !== null && call.to !== null
                && row.booking_date_et >= call.from && row.booking_date_et <= call.to)
              .slice(from, to + 1)
            return Promise.resolve({ data: selected, error: null })
          },
        }
        return query
      },
    },
  }
}

const confirmationFacts = (values: Record<string, number> = {}) => ({
  totalConfirmations: 6,
  websiteConfirmations: 4,
  staffOrManualConfirmations: 1,
  originUnknownConfirmations: 1,
  websiteWithAcceptedCapi: 3,
  websiteLegacyStampUnverified: 1,
  websiteLaterCanceled: 1,
  ...values,
})

describe('measurement report reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireOutcomeLedgerHealth.mockResolvedValue({ available: true, lastReconciledAt: healthyAt })
    getConfirmationFacts.mockResolvedValue(confirmationFacts())
    readPaidTouchAdAssignments.mockImplementation(async (_db, _account, ids: string[]) => ({
      assignments: ids.includes(oid(1))
        ? [{ outcomeId: oid(1), linkId: 'link', touchId: 'touch', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '3', observedAt: '2026-09-01T10:00:00Z', linkedAt: '2026-09-02T10:00:00Z', policyVersion: 1 }]
        : [],
      requestedOutcomeCount: ids.length,
      unassignedOutcomeIds: ids.filter(id => id !== oid(1)),
      incompleteIdentityOutcomeIds: [],
    }))
  })

  it('counts only immutable links in the active value-bearing booking cohort', async () => {
    const fake = fakeClient([
      ledgerRow(1),
      ledgerRow(2, { business_state: 'active_zero_value', price: 0 }),
      ledgerRow(3, { business_state: 'cancelled', status: 'cancelled' }),
      ledgerRow(4, { booking_date_et: '2026-08-30' }),
    ])
    getAdminClient.mockReturnValue(fake.client)

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(requireOutcomeLedgerHealth).toHaveBeenCalledWith(
      fake.client, 'account-db', '2026-08-30', '2026-09-04', Date.parse(context.asOf),
    )
    expect(readPaidTouchAdAssignments).toHaveBeenNthCalledWith(1, fake.client, 'account-db', [oid(1)], healthyAt)
    expect(readPaidTouchAdAssignments).toHaveBeenNthCalledWith(2, fake.client, 'account-db', [oid(4)], healthyAt)
    const metric = section.data?.paidAssociation.linked_value_bearing_bookings
    expect(metric?.current.value).toBe(1)
    expect(metric?.previous?.value).toBeNull()
    expect(metric?.current).toMatchObject({
      source: { system: 'first_party_attribution', role: 'association_truth', evidencePlane: 'paid_association' },
      entity: { level: 'business', id: 'account-db' },
      measurementKind: 'associated_noncausal',
      window: { basis: 'booking_created_date_et' },
      coverage: { state: 'partial', numerator: 1, denominator: 1 },
      asOf: healthyAt,
    })
    expect(metric?.current.source.head).toBe(healthyAt)
    expect(section.state).toBe('partial')
    const capiClaim = section.data?.capi.accepted_live_confirmations.current
    expect(section.asOf).toBe(capiClaim?.asOf)
    expect(capiClaim?.asOf).not.toBe(healthyAt)
    expect(capiClaim?.source.head).toBe(capiClaim?.asOf)

    const { validateReportingPacket } = await import('@/lib/reporting/validation')
    expect(() => validateReportingPacket({
      context,
      section: 'measurement',
      result: section,
      notes: [],
    })).not.toThrow()
  })

  it('keeps the completed measurement read inside the report cutoff', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T05:30:00Z'))
    try {
      const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
      const section = await readMeasurementReport(context)

      expect(section.asOf).toBe(context.asOf)
      expect(section.data?.capi.accepted_live_confirmations.current.asOf).toBe(context.asOf)
      const { validateReportingPacket } = await import('@/lib/reporting/validation')
      expect(() => validateReportingPacket({ context, section: 'measurement', result: section, notes: [] })).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })


  it('reports observed paid-touch-to-booking lag for the validated linked eligible sample', async () => {
    getAdminClient.mockReturnValue(fakeClient([
      ledgerRow(1, { booking_date_et: '2026-09-04' }), ledgerRow(2, { booking_date_et: '2026-09-04' }), ledgerRow(3, { booking_date_et: '2026-09-04' }), ledgerRow(4, { booking_date_et: '2026-08-30' }),
    ]).client)
    readPaidTouchAdAssignments
      .mockResolvedValueOnce({
        assignments: [
          { outcomeId: oid(1), linkId: 'link-1', touchId: 'touch-1', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '3', observedAt: '2026-09-01T10:00:00Z', outcomeCreatedAt: '2026-09-04T10:00:00Z', linkedAt: '2026-09-04T11:00:00Z', policyVersion: 1 },
          { outcomeId: oid(2), linkId: 'link-2', touchId: 'touch-2', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '4', observedAt: '2026-09-03T10:00:00Z', outcomeCreatedAt: '2026-09-04T10:00:00Z', linkedAt: '2026-09-04T11:00:00Z', policyVersion: 1 },
        ],
        requestedOutcomeCount: 3,
        unassignedOutcomeIds: [oid(3)],
        incompleteIdentityOutcomeIds: [oid(3)],
      })
      .mockResolvedValueOnce({
        assignments: [
          { outcomeId: oid(4), linkId: 'link-4', touchId: 'touch-4', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '5', observedAt: '2026-08-29T00:00:00Z', outcomeCreatedAt: '2026-08-30T12:00:00Z', linkedAt: '2026-08-30T13:00:00Z', policyVersion: 1 },
        ],
        requestedOutcomeCount: 1,
        unassignedOutcomeIds: [],
        incompleteIdentityOutcomeIds: [],
      })

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    const sample = section.data?.paidAssociation.paid_touch_booking_lag_sample_bookings
    const median = section.data?.paidAssociation.median_paid_touch_to_booking_lag_days
    const p90 = section.data?.paidAssociation.p90_paid_touch_to_booking_lag_days
    const longest = section.data?.paidAssociation.longest_paid_touch_to_booking_lag_days
    expect(sample?.current.value).toBe(2)
    expect(sample?.previous?.value).toBe(1)
    expect(median?.current.value).toBe(2)
    expect(median?.previous?.value).toBe(1.5)
    expect(p90?.current.value).toBe(3)
    expect(p90?.previous?.value).toBe(1.5)
    expect(longest?.current.value).toBe(3)
    expect(longest?.previous?.value).toBe(1.5)
    expect(median?.current.coverage).toEqual({ state: 'partial', numerator: 2, denominator: 3 })
    expect(median?.definition).toContain('observed paid-touch timestamp')
    expect(median?.definition).not.toMatch(/click/i)
    expect(section.data?.paidAssociationNotes.join(' ')).toContain('not booking-to-service lead time')

    const { validateReportingPacket } = await import('@/lib/reporting/validation')
    expect(() => validateReportingPacket({ context, section: 'measurement', result: section, notes: [] })).not.toThrow()
  })

  it('withholds lag values for invalid or future touch-to-booking chronology without suppressing paid count or CAPI', async () => {
    getAdminClient.mockReturnValue(fakeClient([ledgerRow(1)]).client)
    readPaidTouchAdAssignments.mockResolvedValue({
      assignments: [{ outcomeId: oid(1), linkId: 'link', touchId: 'touch', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '3', observedAt: '2026-09-05T10:00:00Z', outcomeCreatedAt: '2026-09-06T10:00:00Z', linkedAt: '2026-09-06T11:00:00Z', policyVersion: 1 }],
      requestedOutcomeCount: 1,
      unassignedOutcomeIds: [],
      incompleteIdentityOutcomeIds: [],
    })

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.data?.paidAssociation.linked_value_bearing_bookings.current.value).toBe(1)
    expect(section.data?.paidAssociation.median_paid_touch_to_booking_lag_days.current.value).toBeNull()
    expect(section.data?.paidAssociation.longest_paid_touch_to_booking_lag_days.current.value).toBeNull()
    expect(section.data?.paidAssociation.p90_paid_touch_to_booking_lag_days.current.value).toBeNull()
    expect(section.data?.paidAssociation.median_paid_touch_to_booking_lag_days.current.availability.blockerCodes)
      .toContain('paid_touch_booking_lag_chronology_invalid')
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(3)
  })

  it('treats a null paid ledger response as unavailable instead of an empty cohort', async () => {
    getAdminClient.mockReturnValue(fakeClient(null).client)

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.state).toBe('partial')
    expect(section.notes).toContain('paid_association_read_unavailable')
    expect(section.data?.paidAssociation.linked_value_bearing_bookings.current.value).toBeNull()
    expect(section.data?.paidAssociation.paid_touch_booking_lag_sample_bookings.current.value).toBeNull()
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(3)
    expect(readPaidTouchAdAssignments).not.toHaveBeenCalled()
  })


  it('withholds lag when immutable booking-created date disagrees with the selected ledger booking date', async () => {
    getAdminClient.mockReturnValue(fakeClient([
      ledgerRow(1, { booking_date_et: '2026-09-02' }),
      ledgerRow(4, { booking_date_et: '2026-08-30' }),
    ]).client)
    readPaidTouchAdAssignments
      .mockResolvedValueOnce({
        assignments: [{ outcomeId: oid(1), linkId: 'link-1', touchId: 'touch-1', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '3', observedAt: '2026-08-01T10:00:00Z', outcomeCreatedAt: '2026-08-02T10:00:00Z', linkedAt: '2026-08-02T11:00:00Z', policyVersion: 1 }],
        requestedOutcomeCount: 1,
        unassignedOutcomeIds: [],
        incompleteIdentityOutcomeIds: [],
      })
      .mockResolvedValueOnce({
        assignments: [{ outcomeId: oid(4), linkId: 'link-4', touchId: 'touch-4', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '4', observedAt: '2026-08-29T00:00:00Z', outcomeCreatedAt: '2026-08-30T12:00:00Z', linkedAt: '2026-08-30T13:00:00Z', policyVersion: 1 }],
        requestedOutcomeCount: 1,
        unassignedOutcomeIds: [],
        incompleteIdentityOutcomeIds: [],
      })

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.data?.paidAssociation.linked_value_bearing_bookings.current.value).toBe(1)
    expect(section.data?.paidAssociation.median_paid_touch_to_booking_lag_days.current.value).toBeNull()
    expect(section.data?.paidAssociation.median_paid_touch_to_booking_lag_days.current.availability.blockerCodes)
      .toContain('paid_touch_booking_lag_booking_date_mismatch')
    expect(section.data?.paidAssociation.median_paid_touch_to_booking_lag_days.previous?.value).toBe(1.5)
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(3)
  })

  it('withholds an observed zero when exact-window linker completeness is unproven', async () => {
    const fake = fakeClient([ledgerRow(7)])
    getAdminClient.mockReturnValue(fake.client)
    readPaidTouchAdAssignments.mockResolvedValue({
      assignments: [], requestedOutcomeCount: 1,
      unassignedOutcomeIds: [oid(7)], incompleteIdentityOutcomeIds: [],
    })

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)
    const claim = section.data?.paidAssociation.linked_value_bearing_bookings.current

    expect(claim?.value).toBeNull()
    expect(claim?.coverage).toEqual({ state: 'partial', numerator: 0, denominator: 1 })
    expect(claim?.availability.blockerCodes).toContain('paid_linker_completeness_unproven')
    expect(section.data?.paidAssociationNotes.join(' ')).toContain('lower bound')
  })

  it('preserves a proven paid link whose Meta identity is incomplete without making an ad claim', async () => {
    getAdminClient.mockReturnValue(fakeClient([ledgerRow(7)]).client)
    readPaidTouchAdAssignments.mockResolvedValue({
      assignments: [], requestedOutcomeCount: 1,
      unassignedOutcomeIds: [oid(7)], incompleteIdentityOutcomeIds: [oid(7)],
    })

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)
    const claim = section.data?.paidAssociation.linked_value_bearing_bookings.current

    expect(claim?.value).toBe(1)
    expect(claim?.entity).toEqual({ level: 'business', id: 'account-db' })
    expect(claim?.coverage.state).toBe('partial')
  })

  it('preserves explicit CAPI zero only after the healthy exact-window read', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    getConfirmationFacts
      .mockResolvedValueOnce(confirmationFacts({ websiteConfirmations: 2, websiteWithAcceptedCapi: 0 }))
      .mockResolvedValueOnce(confirmationFacts({ websiteConfirmations: 0, websiteWithAcceptedCapi: 0 }))

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(getConfirmationFacts).toHaveBeenNthCalledWith(1, 'account-db', '2026-09-02', '2026-09-04', expect.anything())
    expect(getConfirmationFacts).toHaveBeenNthCalledWith(2, 'account-db', '2026-08-30', '2026-09-01', expect.anything())
    const accepted = section.data?.capi.accepted_live_confirmations
    expect(accepted?.current.value).toBe(0)
    expect(accepted?.previous?.value).toBe(0)
    expect(accepted?.current).toMatchObject({
      source: { system: 'capi', role: 'delivery_transport', evidencePlane: 'capi_delivery' },
      entity: { level: 'business', id: 'account-db' },
      attributionScope: 'capi_event_delivery',
      window: { basis: 'booking_created_date_et' },
      coverage: { state: 'complete', numerator: 2, denominator: 2 },
    })
  })

  it('keeps cancellation reporting out of the packet while preserving CAPI eligibility and unknown-origin evidence', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    getConfirmationFacts.mockResolvedValue(confirmationFacts({
      totalConfirmations: 9,
      websiteConfirmations: 4,
      staffOrManualConfirmations: 2,
      originUnknownConfirmations: 3,
      websiteWithAcceptedCapi: 2,
      websiteLaterCanceled: 2,
    }))

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.data?.capi.eligible_website_confirmations.current.value).toBe(4)
    expect(section.data?.capi.origin_unknown_confirmations.current.value).toBe(3)
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(2)
    expect(JSON.stringify(section)).not.toMatch(/cancel|refund|customer returns/i)
  })

  it('keeps CAPI evidence available when the paid-association read fails', async () => {
    getAdminClient.mockReturnValue(fakeClient([ledgerRow(1)]).client)
    readPaidTouchAdAssignments.mockRejectedValue(new Error('sensitive upstream detail'))

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.paidAssociation.linked_value_bearing_bookings.current.value).toBeNull()
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(3)
    expect(section.notes.join(' ')).not.toContain('sensitive upstream detail')
    expect(section.notes).toContain('paid_association_read_unavailable')
  })

  it('retains successful periods across crossed partial failures', async () => {
    getAdminClient.mockReturnValue(fakeClient([
      ledgerRow(1), ledgerRow(4, { booking_date_et: '2026-08-30' }),
    ]).client)
    readPaidTouchAdAssignments
      .mockRejectedValueOnce(new Error('current paid read failed'))
      .mockResolvedValueOnce({
        assignments: [{ outcomeId: oid(4), linkId: 'link', touchId: 'touch', metaCampaignId: '1', metaAdsetId: '2', metaAdId: '3', observedAt: '2026-08-29T10:00:00Z', linkedAt: '2026-08-30T10:00:00Z', policyVersion: 1 }],
        requestedOutcomeCount: 1,
        unassignedOutcomeIds: [],
        incompleteIdentityOutcomeIds: [],
      })
    getConfirmationFacts
      .mockResolvedValueOnce(confirmationFacts())
      .mockResolvedValueOnce(null)

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.paidAssociation.linked_value_bearing_bookings.current.value).toBeNull()
    expect(section.data?.paidAssociation.linked_value_bearing_bookings.previous?.value).toBe(1)
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBe(3)
    expect(section.data?.capi.accepted_live_confirmations.previous?.value).toBeNull()
  })

  it('withholds CAPI values when the exact-window confirmation read fails', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    getConfirmationFacts.mockResolvedValue(null)

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section.state).toBe('partial')
    expect(section.data?.capi.eligible_website_confirmations.current.value).toBeNull()
    expect(section.data?.capi.accepted_live_confirmations.current.value).toBeNull()
    expect(section.notes).toContain('capi_confirmation_read_unavailable')
  })

  it('fails closed before either source can report zero when ledger health is missing', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    requireOutcomeLedgerHealth.mockRejectedValue(new Error('outcome_ledger_health_missing'))

    const { readMeasurementReport } = await import('@/lib/reporting/measurement-reader')
    const section = await readMeasurementReport(context)

    expect(section).toEqual({
      state: 'unavailable', data: null, asOf: null, notes: ['outcome_ledger_health_missing'],
    })
    expect(readPaidTouchAdAssignments).not.toHaveBeenCalled()
    expect(getConfirmationFacts).not.toHaveBeenCalled()
  })
})
