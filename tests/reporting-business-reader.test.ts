import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAdminClient = vi.fn()
const requireOutcomeLedgerHealth = vi.fn()
const readBusinessIntelligence = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient }))
// the gate is per enabled outcome source (src/lib/outcomes/source-health.ts).
vi.mock('@/lib/outcomes/source-health', () => ({ requireOutcomeLedgerHealth }))
vi.mock('@/lib/reporting/business-intelligence-reader', () => ({ readBusinessIntelligence }))

const context = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York' as const,
  currency: 'USD' as const,
  asOf: '2026-09-05T16:00:00Z',
}

/** Outcome uuid fixture for a numeric case id (identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const RECONCILED = [{ sourceId: 'source-1', kind: 'acuity', completeness: 'reconciled' }]

function fakeClient(rows: Array<Record<string, unknown>>, invalidPage?: unknown) {
  const calls: Array<{ table: string; select: string; ranges: Array<[number, number]>; equals: Array<[string, string]> }> = []
  return {
    calls,
    client: {
      from(table: string) {
        const call = { table, select: '', ranges: [] as Array<[number, number]>, equals: [] as Array<[string, string]> }
        calls.push(call)
        const query = {
          select(fields: string) { call.select = fields; return query },
          eq(field: string, value: string) { call.equals.push([field, value]); return query },
          gte() { return query },
          lte() { return query },
          order() { return query },
          range(from: number, to: number) {
            call.ranges.push([from, to])
            return Promise.resolve({ data: invalidPage === undefined ? rows.slice(from, to + 1) : invalidPage, error: null })
          },
        }
        return query
      },
    },
  }
}

describe('business report reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireOutcomeLedgerHealth.mockResolvedValue({
      available: true,
      lastReconciledAt: '2026-09-05T15:00:00Z',
      windowEndDate: '2026-09-04',
      sources: RECONCILED,
    })
  })

  it('health-gates the full current/comparison window and scopes stable reads to the account', async () => {
    const fake = fakeClient([])
    getAdminClient.mockReturnValue(fake.client)
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const section = await readBusinessReport(context)

    expect(requireOutcomeLedgerHealth).toHaveBeenCalledWith(
      fake.client, 'account-db', '2026-08-30', '2026-09-04',
    )
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.every(call => call.table === 'v_business_outcomes')).toBe(true)
    expect(fake.calls.every(call => call.select.includes('appointment_type_id') && !call.select.includes('business_state'))).toBe(true)
    expect(fake.calls.every(call => call.equals.some(
      ([field, value]) => field === 'ad_account_id' && value === 'account-db',
    ))).toBe(true)
    expect(readBusinessIntelligence).not.toHaveBeenCalled()
    expect(section.state).toBe('available')
    expect(section.data?.metrics.active_appointments.current.value).toBe(0)
    expect(section.asOf).toBe('2026-09-05T15:00:00Z')
    expect(section.data?.metrics.active_appointments.current.asOf).toBe('2026-09-05T15:00:00Z')
    expect(section.data?.series[0].metrics.active_appointments.current.asOf).toBe('2026-09-05T15:00:00Z')
  })

  it('never converts a failed source-health/window gate into empty business totals', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    requireOutcomeLedgerHealth.mockRejectedValue(new Error('outcome_ledger_window_not_covered: requested outside source'))
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const section = await readBusinessReport(context)

    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(section.notes.join(' ')).toContain('outcome_ledger_window_not_covered')
  })

  it('withholds the business report when a nominally healthy ledger omits its proven window end', async () => {
    getAdminClient.mockReturnValue(fakeClient([]).client)
    requireOutcomeLedgerHealth.mockResolvedValue({
      available: true, lastReconciledAt: '2026-09-05T15:00:00Z', windowEndDate: null, sources: RECONCILED,
    })
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const section = await readBusinessReport(context, { includeIntelligence: true })
    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(section.notes).toContain('outcome_ledger_health_window_unknown')
    expect(readBusinessIntelligence).not.toHaveBeenCalled()
  })

  it.each([null, {}])('rejects a malformed success response instead of publishing empty totals: %s', async page => {
    getAdminClient.mockReturnValue(fakeClient([], page).client)
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const section = await readBusinessReport(context)
    expect(section).toMatchObject({ state: 'unavailable', data: null, asOf: null })
  })

  it('pages deterministically beyond the warehouse row cap', async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => ({
      id: oid(index + 1), currency: 'USD', gross_value: 125, collected_value: 125, status: 'confirmed',
      business_state: 'active_value_bearing', business_date: '2026-09-02',
      outcome_label: 'Hourly Studio Rental',
    }))
    const fake = fakeClient(rows)
    getAdminClient.mockReturnValue(fake.client)
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const section = await readBusinessReport(context)

    expect(section.data?.metrics.active_appointments.current.value).toBe(1_001)
    expect(fake.calls.flatMap(call => call.ranges)).toEqual([
      [0, 999], [0, 999], [1000, 1999], [1000, 1999],
    ])
  })
})


describe('business core before optional intelligence', () => {
  it('publishes validated core before private history completes and preserves its original clock', async () => {
    const fake = fakeClient([{ id: oid(1), currency: 'USD', gross_value: 125, collected_value: 125, status: 'confirmed', business_state: 'active_value_bearing', business_date: '2026-09-02', outcome_label: 'Rental' }])
    getAdminClient.mockReturnValue(fake.client)
    requireOutcomeLedgerHealth.mockResolvedValue({ lastReconciledAt: '2026-09-05T15:00:00Z', windowEndDate: '2026-09-04', sources: RECONCILED })
    let release!: (value: unknown) => void
    readBusinessIntelligence.mockReturnValue(new Promise(resolve => { release = resolve }))
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    const onProgress = vi.fn()
    let settled = false
    const pending = readBusinessReport(context, { includeIntelligence: true, onProgress }).then(value => { settled = true; return value })
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce())
    const core = onProgress.mock.calls[0][0]
    expect(core).toMatchObject({ state: 'partial', asOf: '2026-09-05T15:00:00Z', data: { intelligence: { customers: { state: 'loading' }, leadTime: { state: 'loading' }, upcoming: { state: 'loading' } } } })
    expect(core.data.metrics.active_appointments.current.value).toBe(1)
    expect(settled).toBe(false)
    expect(readBusinessIntelligence).toHaveBeenLastCalledWith(
      fake.client,
      expect.objectContaining({ asOf: '2026-09-05T15:00:00Z' }),
      { customerObservedThrough: '2026-09-04' },
    )
    const unavailable = { state: 'unavailable', data: null, asOf: null, notes: ['Customer history is temporarily unavailable.'] }
    release({ customers: unavailable, leadTime: unavailable, upcoming: unavailable })
    const final = await pending
    expect(final.state).toBe('partial')
    expect(final.data?.metrics).toEqual(core.data.metrics)
    expect(final.data?.intelligence?.customers.state).toBe('unavailable')
    expect(final.notes.join(' ')).not.toMatch(/are loading/i)
  })
  it('keeps healthy core after rejected, malformed or terminal-loading extras without leaking private errors', async () => {
    const { readBusinessReport } = await import('@/lib/reporting/business-reader')
    getAdminClient.mockReturnValue(fakeClient([]).client)
    requireOutcomeLedgerHealth.mockResolvedValue({ lastReconciledAt: '2026-09-05T15:00:00Z', windowEndDate: '2026-09-04', sources: RECONCILED })
    const loading = { state: 'loading', data: null, asOf: null, notes: [] }
    for (const outcome of [() => Promise.reject(new Error('token=private-secret')), () => Promise.resolve({ unexpected: 'private-secret' }), () => Promise.resolve({ customers: loading, leadTime: loading, upcoming: loading })]) {
      readBusinessIntelligence.mockImplementationOnce(outcome)
      const result = await readBusinessReport(context, { includeIntelligence: true, onProgress: () => { throw new Error('observer failed') } })
      expect(result).toMatchObject({ state: 'partial', data: { intelligence: { customers: { state: 'unavailable' }, leadTime: { state: 'unavailable' }, upcoming: { state: 'unavailable' } } } })
      expect(result.data?.metrics.active_appointments.current.value).toBe(0)
      expect(JSON.stringify(result)).not.toContain('private-secret')
    }
  })
})
