import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportingContext } from '@/lib/reporting/contracts'
import { ACCOUNT, freshOutcomeDb, insertAppt, outcomeUuid } from './db/acuity-harness'

const buildBusinessCustomers = vi.fn()
const buildBusinessLeadTime = vi.fn()
const buildBusinessUpcoming = vi.fn()
const upcomingBusinessContext = vi.fn()

vi.mock('@/lib/reporting/business-intelligence-metrics', () => ({
  buildBusinessCustomers,
  buildBusinessLeadTime,
  buildBusinessUpcoming,
}))
vi.mock('@/lib/reporting/business-intelligence-context', () => ({ upcomingBusinessContext }))

const context: ReportingContext = {
  account: { id: 'account-db', metaAccountId: 'act_123', name: 'Studio' },
  range: { from: '2026-03-09', to: '2026-03-10' },
  comparison: { from: '2026-03-07', to: '2026-03-08' },
  timezone: 'America/New_York',
  currency: 'USD',
  asOf: '2026-03-07T17:00:00Z',
}

const upcomingContext = {
  ...context,
  range: { from: '2026-03-08', to: '2026-04-04' },
  comparison: { from: '2026-02-08', to: '2026-03-07' },
}

type Row = {
  id: string
  currency: string
  ad_account_id: string
  email: string | null
  outcome_label: string | null
  appointment_type_id: number | null
  category: string | null
  calendar_id: number | null
  fulfilment_at: string | null
  occurred_at: string | null
  business_date: string | null
  gross_value: number | null
  collected_value: number | null
  status: string
}

/** Outcome uuid fixture for a numeric case id (identity is the outcome uuid). */
const oid = (n: number): string => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`

/** One `v_business_outcomes` row as the database returns it for the reader's projection. */
function row(id: number, values: Partial<Row> = {}): Row {
  return {
    id: oid(id),
    currency: 'USD',
    ad_account_id: 'account-db',
    email: `client-${id}@example.test`,
    outcome_label: 'Studio Rental',
    appointment_type_id: 10,
    category: 'Rental',
    calendar_id: 20,
    fulfilment_at: '2026-03-09T14:00:00-04:00',
    occurred_at: '2026-03-07T12:00:00-05:00',
    business_date: '2026-03-07',
    gross_value: 125,
    collected_value: 125,
    status: 'confirmed',
    ...values,
  }
}

/** The Acuity-flavoured row the reader hands to the builders for a database row. */
function read(value: Row) {
  return {
    id: value.id,
    ad_account_id: value.ad_account_id,
    email: value.email,
    appointment_type: value.outcome_label,
    appointment_type_id: value.appointment_type_id,
    category: value.category,
    calendar_id: value.calendar_id,
    datetime: value.fulfilment_at,
    datetime_created: value.occurred_at,
    booking_date_et: value.business_date,
    price: value.gross_value,
    amount_paid: value.collected_value,
    canceled: value.status === 'cancelled',
  }
}

const customersDto = {
  metrics: {}, groups: [], historyFrom: null, historyTo: '2026-03-10',
  identityBasis: 'normalized_email' as const, historyCoverage: 'retained_ledger' as const,
}
const leadTimeDto = { metrics: {}, buckets: [] }
const upcomingDto = { range: upcomingContext.range, metrics: {}, days: [], types: [] }
const customersSection = { state: 'available' as const, data: customersDto, asOf: context.asOf, notes: [] }
const leadTimeSection = { state: 'available' as const, data: leadTimeDto, asOf: context.asOf, notes: [] }
const upcomingSection = { state: 'available' as const, data: upcomingDto, asOf: context.asOf, notes: [] }

type QueryCall = {
  table: string
  select: string | null
  equals: Array<[string, unknown]>
  gtes: Array<[string, unknown]>
  ltes: Array<[string, unknown]>
  lts: Array<[string, unknown]>
  orders: Array<[string, unknown]>
  ranges: Array<[number, number]>
  abortSignals: AbortSignal[]
}

type Dataset = Record<string, Row[] | Error | null>

function fakeClient(dataset: Dataset) {
  const calls: QueryCall[] = []
  const client = {
    from(table: string) {
      const call: QueryCall = { table, select: null, equals: [], gtes: [], ltes: [], lts: [], orders: [], ranges: [], abortSignals: [] }
      calls.push(call)
      const query = {
        select(value: string) { call.select = value; return query },
        eq(field: string, value: unknown) { call.equals.push([field, value]); return query },
        gte(field: string, value: unknown) { call.gtes.push([field, value]); return query },
        lte(field: string, value: unknown) { call.ltes.push([field, value]); return query },
        lt(field: string, value: unknown) { call.lts.push([field, value]); return query },
        order(field: string, options: unknown) { call.orders.push([field, options]); return query },
        abortSignal(signal: AbortSignal) { call.abortSignals.push(signal); return query },
        range(from: number, to: number) {
          call.ranges.push([from, to])
          const source = dataset[table]
          if (source instanceof Error) return Promise.resolve({ data: null, error: { message: source.message } })
          if (source === null) return Promise.resolve({ data: null, error: null })
          const rows = source.filter(candidate => matches(call, candidate))
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        },
      }
      return query
    },
  }
  return { client, calls }
}

function matches(call: QueryCall, candidate: Row): boolean {
  for (const [field, value] of call.equals) {
    // Fixture rows all belong to an enabled outcome source; the filter itself is asserted below.
    if (field === 'source_enabled') continue
    if ((candidate as unknown as Record<string, unknown>)[field] !== value) return false
  }
  for (const [field, value] of call.gtes) if (compareField(candidate, field, value) < 0) return false
  for (const [field, value] of call.ltes) if (compareField(candidate, field, value) > 0) return false
  for (const [field, value] of call.lts) if (compareField(candidate, field, value) >= 0) return false
  return true
}

function compareField(candidate: Row, field: string, value: unknown): number {
  const actual = (candidate as unknown as Record<string, unknown>)[field]
  if (field === 'fulfilment_at' && typeof actual === 'string' && typeof value === 'string') {
    return Date.parse(actual) - Date.parse(value)
  }
  return String(actual).localeCompare(String(value))
}

function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('business intelligence reader', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T17:00:00Z'))
    upcomingBusinessContext.mockReturnValue(upcomingContext)
    buildBusinessCustomers.mockReturnValue(customersSection)
    buildBusinessLeadTime.mockReturnValue(leadTimeSection)
    buildBusinessUpcoming.mockReturnValue(upcomingSection)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scopes all three reads to the account, pages beyond 1000 rows, and passes selected/history/upcoming cohorts to their builders', async () => {
    const selectedAndPrior = Array.from({ length: 1001 }, (_, index) => row(index + 1, {
      business_date: index < 2 ? '2026-03-09' : '2026-03-07',
    }))
    const history = [row(2001, { business_date: '2026-03-01', email: 'repeat@example.test' })]
    const upcoming = [row(3001, { fulfilment_at: '2026-03-08T03:30:00-04:00', business_date: '2026-03-07' })]
    const fake = fakeClient({ v_business_outcomes: [...selectedAndPrior, ...history, ...upcoming] })

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers).toEqual(customersSection)
    expect(result.leadTime).toEqual(leadTimeSection)
    expect(result.upcoming).toEqual(upcomingSection)
    expect(buildBusinessCustomers).toHaveBeenCalledWith(context,
      expect.arrayContaining([expect.objectContaining({ id: oid(1) }), expect.objectContaining({ id: oid(2001) })]),
      '2026-03-07')
    expect(buildBusinessLeadTime).toHaveBeenCalledWith(context, expect.arrayContaining([expect.objectContaining({ id: oid(1) })]))
    expect(buildBusinessUpcoming).toHaveBeenCalledWith(upcomingContext, expect.arrayContaining([expect.objectContaining({ id: oid(3001) })]), expect.any(String))
    // every read is restricted to enabled outcome sources.
    expect(fake.calls.every(call => call.equals.some(([field, value]) => field === 'source_enabled' && value === true))).toBe(true)
    expect(fake.calls).toHaveLength(5)
    expect(fake.calls.every(call => call.table === 'v_business_outcomes')).toBe(true)
    expect(fake.calls.every(call => call.equals.some(([field, value]) => field === 'ad_account_id' && value === 'account-db'))).toBe(true)
    expect(fake.calls.every(call => call.orders.some(([field, options]) => field === 'id' && (options as { ascending?: boolean }).ascending === true))).toBe(true)
    expect(fake.calls.flatMap(call => call.ranges).filter(([from]) => from === 1000)).toHaveLength(2)
    expect(fake.calls.every(call => call.abortSignals.length === call.ranges.length)).toBe(true)
    const selectedSignals = fake.calls.filter(call => call.gtes.some(([field]) => field === 'business_date')).flatMap(call => call.abortSignals)
    const upcomingSignals = fake.calls.filter(call => call.gtes.some(([field]) => field === 'fulfilment_at')).flatMap(call => call.abortSignals)
    expect(new Set(selectedSignals).size).toBe(1)
    expect(new Set(upcomingSignals).size).toBe(1)
  })

  it('uses ET-safe UTC service boundaries for upcoming reads across the spring DST transition and filters returned rows by local service date', async () => {
    const fake = fakeClient({ v_business_outcomes: [
      row(1, { fulfilment_at: '2026-03-08T00:30:00-05:00' }),
      row(2, { fulfilment_at: '2026-04-04T23:30:00-04:00' }),
      row(3, { fulfilment_at: '2026-04-05T00:30:00-04:00' }),
    ] })

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    await readBusinessIntelligence(fake.client as never, context)

    const upcomingCall = fake.calls.find(call => call.gtes.some(([field]) => field === 'fulfilment_at'))!
    expect(upcomingCall.gtes).toContainEqual(['fulfilment_at', '2026-03-08T05:00:00.000Z'])
    expect(upcomingCall.lts).toContainEqual(['fulfilment_at', '2026-04-05T04:00:00.000Z'])
    expect(buildBusinessUpcoming).toHaveBeenCalledWith(upcomingContext, [expect.objectContaining({ id: oid(1) }), expect.objectContaining({ id: oid(2) })], expect.any(String))
  })

  it('reads booking-created follow-up through the ET observation date without widening selected lead-time cohorts', async () => {
    vi.setSystemTime(new Date('2026-03-21T03:30:00Z')) // March 20 in ET
    const fake = fakeClient({ v_business_outcomes: [
      row(1, { business_date: '2026-03-09' }),
      row(2, { business_date: '2026-03-15' }),
      row(3, { business_date: '2026-03-21' }),
      row(4, { business_date: '2026-03-01' }),
    ] })

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    await readBusinessIntelligence(fake.client as never, context, { customerObservedThrough: '2026-03-20' })

    expect(fake.calls.some(call => call.gtes.some(([field, value]) => field === 'business_date' && value === context.comparison.from)
      && call.ltes.some(([field, value]) => field === 'business_date' && value === '2026-03-20'))).toBe(true)
    expect(buildBusinessCustomers).toHaveBeenCalledWith(context, [
      expect.objectContaining({ id: oid(1) }), expect.objectContaining({ id: oid(2) }), expect.objectContaining({ id: oid(4) }),
    ], '2026-03-20')
    expect(buildBusinessLeadTime).toHaveBeenCalledWith(context, [expect.objectContaining({ id: oid(1) })])
    expect(buildBusinessLeadTime).not.toHaveBeenCalledWith(context, expect.arrayContaining([expect.objectContaining({ id: oid(2) })]))
  })

  it('isolates an extended follow-up read failure from selected lead-time and upcoming evidence', async () => {
    vi.setSystemTime(new Date('2026-03-21T03:30:00Z'))
    let callIndex = 0
    const fake = fakeClient({ v_business_outcomes: [] })
    const originalFrom = fake.client.from.bind(fake.client)
    fake.client.from = ((table: string) => {
      const query = originalFrom(table)
      query.range = (from: number, to: number) => {
        callIndex += 1
        if (callIndex === 1) return Promise.resolve({ data: [row(1, { business_date: '2026-03-09' })].slice(from, to + 1), error: null })
        if (callIndex === 2) return Promise.resolve({ data: null, error: { message: 'follow-up failed private@example.test' } })
        if (callIndex === 3) return Promise.resolve({ data: [row(2, { business_date: '2026-03-01' })].slice(from, to + 1), error: null })
        return Promise.resolve({ data: [row(3, { fulfilment_at: '2026-03-09T10:00:00-04:00' })].slice(from, to + 1), error: null })
      }
      return query
    }) as typeof fake.client.from

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context, { customerObservedThrough: '2026-03-20' })

    expect(result.customers).toMatchObject({ state: 'unavailable', data: null, notes: ['business_customer_read_unavailable'] })
    expect(result.leadTime).toEqual(leadTimeSection)
    expect(result.upcoming).toEqual(upcomingSection)
    expect(buildBusinessLeadTime).toHaveBeenCalledWith(context, [expect.objectContaining({ id: oid(1) })])
    expect(serialized(result)).not.toContain('private@example.test')
  })

  it('isolates source failures by section and never exposes raw errors, identifiers, or PII in serialized notes or DTOs', async () => {
    const fake = fakeClient({ v_business_outcomes: new Error('db says token=secret client@example.test appointment 42') })

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(result.leadTime).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(result.upcoming).toMatchObject({ state: 'unavailable', data: null, asOf: null })
    expect(serialized(result)).not.toMatch(/secret|client@example\.test|appointment 42/i)
    expect(result.customers.notes).toEqual(['business_customer_read_unavailable'])
    expect(result.leadTime.notes).toEqual(['business_lead_time_read_unavailable'])
    expect(result.upcoming.notes).toEqual(['business_upcoming_read_unavailable'])
  })

  it('keeps lead-time and upcoming evidence available when only retained customer history fails', async () => {
    let callIndex = 0
    const selected = [row(1, { business_date: '2026-03-09' })]
    const upcoming = [row(2, { fulfilment_at: '2026-03-09T10:00:00-04:00' })]
    const fake = fakeClient({ v_business_outcomes: [] })
    const originalFrom = fake.client.from.bind(fake.client)
    fake.client.from = ((table: string) => {
      const query = originalFrom(table)
      query.range = (from: number, to: number) => {
        callIndex += 1
        if (callIndex === 1) return Promise.resolve({ data: selected.slice(from, to + 1), error: null })
        if (callIndex === 2) return Promise.resolve({ data: null, error: { message: 'history exploded' } })
        return Promise.resolve({ data: upcoming.slice(from, to + 1), error: null })
      }
      return query
    }) as typeof fake.client.from

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers.state).toBe('unavailable')
    expect(result.leadTime.state).toBe('available')
    expect(result.upcoming.state).toBe('available')
    expect(buildBusinessCustomers).not.toHaveBeenCalled()
    expect(buildBusinessLeadTime).toHaveBeenCalledWith(context, selected.map(read))
    expect(buildBusinessUpcoming).toHaveBeenCalledWith(upcomingContext, upcoming.map(read), expect.any(String))
  })

  it('rejects conflicting duplicate ids and malformed rows instead of silently coercing missing values', async () => {
    const good = row(1, { collected_value: null })
    const duplicateConflict = row(1, { collected_value: 0 })
    const fake = fakeClient({ v_business_outcomes: [good, duplicateConflict, row(2, { id: 'not-an-outcome-uuid' })] })

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers.state).toBe('unavailable')
    expect(result.leadTime.state).toBe('unavailable')
    expect(result.upcoming.state).toBe('unavailable')
    expect(buildBusinessLeadTime).not.toHaveBeenCalled()
    expect(serialized(result)).not.toMatch(/NaN|client-1@example\.test/)
  })

  it('keeps current cohort results when the upcoming source read fails independently', async () => {
    let callIndex = 0
    const selected = [row(1, { business_date: '2026-03-09' })]
    const history = [row(2, { business_date: '2026-03-01' })]
    const fake = fakeClient({ v_business_outcomes: [] })
    const originalFrom = fake.client.from.bind(fake.client)
    fake.client.from = ((table: string) => {
      const query = originalFrom(table)
      query.range = (from: number, to: number) => {
        callIndex += 1
        if (callIndex === 1) return Promise.resolve({ data: selected.slice(from, to + 1), error: null })
        if (callIndex === 2) return Promise.resolve({ data: history.slice(from, to + 1), error: null })
        return Promise.resolve({ data: null, error: { message: 'upcoming leaked email@example.test' } })
      }
      return query
    }) as typeof fake.client.from

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers.state).toBe('available')
    expect(result.leadTime.state).toBe('available')
    expect(result.upcoming.state).toBe('unavailable')
    expect(serialized(result)).not.toContain('email@example.test')
  })

  it('isolates metric-building failures to the affected sections', async () => {
    const fake = fakeClient({ v_business_outcomes: [row(1, { business_date: '2026-03-09' }), row(2, { business_date: '2026-03-01' })] })
    buildBusinessCustomers.mockImplementation(() => { throw new Error('customer builder leaked client@example.test') })
    buildBusinessLeadTime.mockReturnValue(leadTimeSection)
    buildBusinessUpcoming.mockReturnValue(upcomingSection)

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers).toMatchObject({ state: 'unavailable', data: null, asOf: null, notes: ['business_customer_read_unavailable'] })
    expect(result.leadTime).toEqual(leadTimeSection)
    expect(result.upcoming).toEqual(upcomingSection)
    expect(serialized(result)).not.toContain('client@example.test')
  })


  it('accepts an empty selected result but treats success-shaped null selected data as unavailable for customers and lead time only', async () => {
    const emptyFake = fakeClient({ v_business_outcomes: [] })
    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const emptyResult = await readBusinessIntelligence(emptyFake.client as never, context)
    expect(emptyResult.customers).toEqual(customersSection)
    expect(emptyResult.leadTime).toEqual(leadTimeSection)
    expect(emptyResult.upcoming).toEqual(upcomingSection)

    let callIndex = 0
    const upcoming = [row(77, { fulfilment_at: '2026-03-09T10:00:00-04:00' })]
    const fake = fakeClient({ v_business_outcomes: [] })
    const originalFrom = fake.client.from.bind(fake.client)
    fake.client.from = ((table: string) => {
      const query = originalFrom(table)
      query.range = (from: number, to: number) => {
        callIndex += 1
        if (callIndex === 1) return Promise.resolve({ data: null, error: null })
        if (callIndex === 2) return Promise.resolve({ data: [], error: null })
        return Promise.resolve({ data: upcoming.slice(from, to + 1), error: null })
      }
      return query
    }) as typeof fake.client.from

    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers).toMatchObject({ state: 'unavailable', data: null, asOf: null, notes: ['business_customer_read_unavailable'] })
    expect(result.leadTime).toMatchObject({ state: 'unavailable', data: null, asOf: null, notes: ['business_lead_time_read_unavailable'] })
    expect(result.upcoming).toEqual(upcomingSection)
    expect(buildBusinessCustomers).toHaveBeenCalledTimes(1)
    expect(buildBusinessLeadTime).toHaveBeenCalledTimes(1)
    expect(buildBusinessUpcoming).toHaveBeenCalledTimes(2)
  })

  it('does not classify success-shaped null upcoming data as no upcoming work', async () => {
    let callIndex = 0
    const selected = [row(1, { business_date: '2026-03-09' })]
    const history = [row(2, { business_date: '2026-03-01' })]
    const fake = fakeClient({ v_business_outcomes: [] })
    const originalFrom = fake.client.from.bind(fake.client)
    fake.client.from = ((table: string) => {
      const query = originalFrom(table)
      query.range = (from: number, to: number) => {
        callIndex += 1
        if (callIndex === 1) return Promise.resolve({ data: selected.slice(from, to + 1), error: null })
        if (callIndex === 2) return Promise.resolve({ data: history.slice(from, to + 1), error: null })
        return Promise.resolve({ data: null, error: null })
      }
      return query
    }) as typeof fake.client.from

    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    const result = await readBusinessIntelligence(fake.client as never, context)

    expect(result.customers).toEqual(customersSection)
    expect(result.leadTime).toEqual(leadTimeSection)
    expect(result.upcoming).toMatchObject({ state: 'unavailable', data: null, asOf: null, notes: ['business_upcoming_read_unavailable'] })
    expect(buildBusinessUpcoming).not.toHaveBeenCalled()
  })


  it('matches the real base Acuity schema with the projection captured from readBusinessIntelligence', async () => {
    const fake = fakeClient({ v_business_outcomes: [] })
    const { readBusinessIntelligence } = await import('@/lib/reporting/business-intelligence-reader')
    await readBusinessIntelligence(fake.client as never, context)
    const projection = fake.calls.find(call => call.table === 'v_business_outcomes')?.select

    expect(projection).toEqual(expect.any(String))
    const sqlProjection = projection?.split(',').map(field => {
      const column = field.trim()
      if (column === 'appointment_duration:raw->duration') return "raw->'duration' AS appointment_duration"
      // Dropped Acuity columns are read from raw under their old names (PostgREST alias:raw->key / ->>key).
      const rawPath = column.match(/^([a-z_]+):raw(->>?)([A-Za-z]+)$/)
      if (rawPath) return `raw${rawPath[2]}'${rawPath[3]}' AS ${rawPath[1]}`
      expect(column).toMatch(/^[a-z_]+$/)
      return column
    }).join(', ')
    expect(projection).toContain('appointment_duration:raw->duration')
    expect(projection?.split(',').map(field => field.trim())).toContain('id')

    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 8901, account: ACCOUNT, price: 125, canceled: false })
    await db.query(`UPDATE outcomes SET raw = $1::jsonb WHERE external_id = $2`, [JSON.stringify({ duration: '90', privateField: 'not-projected' }), '8901'])

    await expect(db.query(`SELECT external_id, business_state FROM outcomes WHERE external_id = $1`, ['8901']))
      .rejects.toThrow(/business_state|42703|column/i)

    const result = await db.query<{ id: string; appointment_duration: string }>(`
      SELECT ${sqlProjection}
      FROM v_business_outcomes
      WHERE external_id = $1
    `, ['8901'])
    expect(String(result.rows[0].id)).toBe(outcomeUuid(8901))
    expect(result.rows[0].appointment_duration).toBe('90')
    expect(JSON.stringify(result.rows)).not.toContain('not-projected')
    await db.close()
  })

})
