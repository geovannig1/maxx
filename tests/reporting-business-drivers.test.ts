import { describe, expect, it } from 'vitest'
import { buildBusinessReport, type BusinessLedgerRow } from '@/lib/reporting/business-metrics'
import { deriveBusinessDrivers } from '@/lib/reporting/business-drivers'
import { deriveBusinessDriverReview } from '@/lib/reporting/review/business-drivers'
import { deriveBusinessReview } from '@/lib/reporting/review/business'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import type { ReportingData } from '@/lib/reporting/contracts'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { snapshotContext as context } from './fixtures/reporting-snapshot'

function rows(type: number, prices: number[], prior = false, options: Partial<BusinessLedgerRow> = {}): BusinessLedgerRow[] {
  return prices.map((price, index) => ({ id: type * 100 + index, price, amount_paid: price,
    canceled: false, booking_date_et: prior ? context.comparison.from : context.range.from,
    appointment_type_id: type, appointment_type: `Service ${type}`, appointment_duration: 60, ...options }))
}
function fixture(current = [...rows(10, [100, 200]), ...rows(20, [50])],
  prior = [...rows(10, [100], true), ...rows(20, [150, 150], true)]): ReportingData {
  const unavailable = { state: 'unavailable' as const, asOf: null, data: null, notes: [] }
  const business = { state: 'available' as const, asOf: context.asOf, notes: [], data: buildBusinessReport(context, current, prior) }
  validateReportingPacket({ section: 'business', context, result: business, notes: [] })
  return structuredClone({ context, business, meta: unavailable, website: unavailable })
}
const service = (data: ReportingData, id = 10) => deriveBusinessDrivers(data).services.find(row => row.id === `outcome-type:${id}`)!

describe('native booked-value driver model', () => {
  it('reconciles native headline and every service with symmetric count and value-per-booking components', () => {
    const data = fixture(), result = deriveBusinessDrivers(data)
    expect(result.state).toBe('available')
    expect(result.account).toMatchObject({ current: { bookedValue: 350, bookings: 3 }, prior: { bookedValue: 400, bookings: 3 }, change: { bookedValue: -50 } })
    expect(service(data)).toMatchObject({ current: { bookedValue: 300, bookings: 2, valuePerBooking: 150 },
      prior: { bookedValue: 100, bookings: 1, valuePerBooking: 100 }, change: { bookedValue: 200 },
      decomposition: { state: 'matched', bookingCount: 125, valuePerBooking: 75, wholeContribution: null } })
    expect(service(data, 20).decomposition).toMatchObject({ bookingCount: -100, valuePerBooking: -150 })
    expect(result.reconciliation).toEqual({ current: { headline: 350, serviceSum: 350, residual: 0, state: 'reconciled' },
      prior: { headline: 400, serviceSum: 400, residual: 0, state: 'reconciled' } })
    expect(service(data).evidence.bookedValue?.path).toBe('/business/data/types/0/metrics/booked_value')
  })

  it('preserves offsetting gains and losses when the headline change is zero', () => {
    const data = fixture([...rows(10, [300]), ...rows(20, [100])], [...rows(10, [100], true), ...rows(20, [300], true)])
    expect(deriveBusinessDrivers(data).account.change.bookedValue).toBe(0)
    expect(deriveBusinessDrivers(data).services.map(row => row.change.bookedValue)).toEqual([200, -200])
  })

  it('retains smaller, current-only, prior-only and same-named native service IDs without absent-period means', () => {
    const data = fixture([...rows(10, [900], false, { appointment_type: 'Shared' }), ...rows(20, [10], false, { appointment_type: 'Shared' })],
      [...rows(10, [800], true, { appointment_type: 'Shared' }), ...rows(30, [5], true)])
    expect(deriveBusinessDrivers(data).services).toHaveLength(3)
    expect(service(data, 20)).toMatchObject({ name: 'Shared', prior: { bookedValue: 0, bookings: 0, valuePerBooking: null },
      decomposition: { state: 'current_only', bookingCount: null, valuePerBooking: null, wholeContribution: 10 } })
    expect(service(data, 30)).toMatchObject({ current: { bookedValue: 0, bookings: 0, valuePerBooking: null },
      decomposition: { state: 'prior_only', wholeContribution: -5 } })
  })

  it('excludes zero-price payment from driver counts and keeps missing payment, duration and optional intelligence local', () => {
    const data = fixture([...rows(10, [100, 100], false, { amount_paid: null, appointment_duration: null }), ...rows(20, [0], false, { amount_paid: 500 })], rows(10, [100], true))
    data.business.state = 'partial'
    data.business.notes = ['Optional customer intelligence is unavailable.']
    const result = deriveBusinessDrivers(data)
    expect(result.account).toMatchObject({ current: { bookedValue: 200, bookings: 2, valuePerBooking: 100, recordedHours: null }, change: { bookedValue: 100 } })
    expect(service(data).decomposition).toMatchObject({ state: 'matched', bookingCount: 100, valuePerBooking: 0 })
    expect(service(data).limitations.join(' ')).toMatch(/duration|hours/i)
    expect(result.state).toBe('available')
  })

  it('checks residuals in each period even when omitted service movement cancels', () => {
    const data = fixture([...rows(10, [100]), ...rows(20, [50])], [...rows(10, [100], true), ...rows(20, [50], true)])
    data.business.data!.types = data.business.data!.types.slice(0, 1)
    const result = deriveBusinessDrivers(data)
    expect(result.account.change.bookedValue).toBe(0)
    expect(result.reconciliation).toEqual({ current: { headline: 150, serviceSum: 100, residual: 50, state: 'residual' },
      prior: { headline: 150, serviceSum: 100, residual: 50, state: 'residual' } })
    expect(result.state).toBe('partial')
  })

  it('distinguishes an unavailable population from a measured empty source and a missing service breakdown', () => {
    const absent = fixture()
    absent.business = { state: 'unavailable', data: null, asOf: null, notes: ['Source unavailable.'] }
    expect(deriveBusinessDrivers(absent).reconciliation.current).toEqual({ headline: null, serviceSum: null, residual: null, state: 'unavailable' })
    expect(deriveBusinessDrivers(fixture([], [])).reconciliation.current).toEqual({ headline: 0, serviceSum: 0, residual: 0, state: 'reconciled' })
    const missingTypes = fixture(rows(10, [50]), rows(10, [40], true))
    missingTypes.business.data!.types = []
    expect(deriveBusinessDrivers(missingTypes).reconciliation.current).toEqual({ headline: 50, serviceSum: 0, residual: 50, state: 'residual' })
    const missingAccount = fixture()
    delete missingAccount.business.data!.metrics.booked_value
    expect(deriveBusinessDrivers(missingAccount).reconciliation.current).toEqual({ headline: null, serviceSum: 350, residual: null, state: 'unavailable' })
    missingAccount.business.data!.types = []
    expect(deriveBusinessDrivers(missingAccount).reconciliation.current.serviceSum).toBeNull()
  })

  it('retains duplicate native rows visibly but excludes their ambiguous arithmetic and reconciliation', () => {
    const data = fixture()
    data.business.data!.types = [...data.business.data!.types, structuredClone(data.business.data!.types[0])]
    const result = deriveBusinessDrivers(data)
    expect(result.services).toHaveLength(3)
    expect(result.services.filter(row => row.id === 'outcome-type:10').every(row => row.change.bookedValue === null)).toBe(true)
    expect(result.reconciliation.current.state).toBe('unavailable')
    expect(result.services[0].limitations.join(' ')).toMatch(/duplicate|ambiguous/i)
  })

  it('keeps complete legacy IDs and withholds ambiguous truncated claim identities', () => {
    const prefix = 'Legacy '.repeat(30)
    const data = fixture()
    data.business.data = buildBusinessReport(context, [...rows(10, [100], false, { appointment_type_id: null, appointment_type: `${prefix}A` }),
      ...rows(20, [100], false, { appointment_type_id: null, appointment_type: `${prefix}B` })], [])
    expect(() => validateReportingPacket({ section: 'business', context, result: data.business, notes: [] })).toThrow(/duplicate business type populations/)
    const result = deriveBusinessDrivers(data)
    expect(result.services.map(row => row.id)).toEqual([`${prefix}A`, `${prefix}B`])
    expect(result.services.every(row => row.current.bookedValue === null)).toBe(true)
    expect(result.account.current.bookedValue).toBe(200)
    expect(result.reconciliation.current.state).toBe('unavailable')
  })

  it.each(['definition', 'version', 'account', 'window', 'source', 'event', 'unit', 'scope', 'stale', 'maturity', 'asOf', 'future_ns', 'head', 'coverage', 'zero_count'] as const)(
    'withholds unsupported current arithmetic for %s while retaining the valid prior', defect => {
      const data = fixture(), metrics = data.business.data!.types[0].metrics, value = metrics.booked_value.current
      if (defect === 'definition') { metrics.booked_value.definition = 'Another measure'; value.formula = 'Another measure' }
      else if (defect === 'version') value.definitionVersion = 2
      else if (defect === 'account') value.entity.id = 'another-account'
      else if (defect === 'window') value.window.start = '2026-08-01'
      else if (defect === 'source') value.source.system = 'meta'
      else if (defect === 'event') metrics.booked_value.event = 'Purchase'
      else if (defect === 'unit') value.unit = 'count'
      else if (defect === 'scope') value.attributionScope = 'none'
      else if (defect === 'stale') value.freshness.state = 'stale'
      else if (defect === 'maturity') value.maturity.state = 'partial'
      else if (defect === 'asOf') value.asOf = '2026-09-05T16:00:00Z'
      else if (defect === 'future_ns') value.asOf = '2026-09-05T17:00:00.000000001Z'
      else if (defect === 'head') value.source.head = 'different-ledger'
      else if (defect === 'coverage') metrics.value_bearing_bookings.current.coverage = { state: 'complete', numerator: 9, denominator: 9 }
      else metrics.value_bearing_bookings.current.value = 0
      const row = service(data)
      expect(row.current.bookedValue).toBe(['coverage', 'zero_count', 'head'].includes(defect) ? 300 : null)
      expect(row.change.bookedValue).toBe(['coverage', 'zero_count'].includes(defect) ? 200 : null)
      expect(row.current.valuePerBooking).toBeNull()
      expect(row.decomposition.state).toBe('unavailable')
      if (!['definition', 'event'].includes(defect)) expect(row.prior.bookedValue).toBe(100)
    },
  )

  it('retains native monetary observations, signed change and reconciliation when the current count is missing', () => {
    const data = fixture()
    delete data.business.data!.types[0].metrics.value_bearing_bookings
    const row = service(data), result = deriveBusinessDrivers(data)
    expect(row).toMatchObject({ current: { bookedValue: 300, bookings: null, valuePerBooking: null },
      prior: { bookedValue: 100, bookings: null }, change: { bookedValue: 200 }, decomposition: { state: 'unavailable' } })
    expect(result.reconciliation.current.state).toBe('reconciled')
    expect(result.reconciliation.prior.state).toBe('reconciled')
    expect(row.limitations.join(' ')).toMatch(/count.*unavailable|unavailable.*count/i)
  })

  it('retains independently supported hours and count when booked value is invalid, and current money when prior is invalid', () => {
    const data = fixture()
    data.business.data!.types[0].metrics.booked_value.current.unit = 'count'
    expect(service(data).current).toMatchObject({ bookedValue: null, bookings: 2, recordedHours: 2 })
    const badPrior = fixture()
    badPrior.business.data!.types[0].metrics.booked_value.previous!.asOf = '2026-09-05T17:00:00.000000001Z'
    expect(service(badPrior)).toMatchObject({ current: { bookedValue: 300, bookings: 2, recordedHours: 2 }, prior: { bookedValue: null }, change: { bookedValue: null } })
  })

  it('rejects an active-appointment denominator and impossible zero recorded hours locally', () => {
    const data = fixture()
    data.business.data!.types[0].metrics.value_bearing_bookings = data.business.data!.types[0].metrics.active_appointments
    expect(service(data)).toMatchObject({ current: { bookedValue: 300, bookings: null, valuePerBooking: null }, change: { bookedValue: 200 } })
    const hours = fixture()
    hours.business.data!.types[0].metrics.recorded_booked_hours.current.value = 0
    expect(service(hours).current).toMatchObject({ bookedValue: 300, bookings: 2, recordedHours: null })
  })

  it('accepts a healthy older native business observation under a newer combined context', () => {
    const data = fixture()
    data.context.asOf = '2026-09-05T19:00:00Z'
    expect(deriveBusinessDrivers(data).state).toBe('available')
    expect(service(data).change.bookedValue).toBe(200)
    expect(service(data).evidence.bookedValue?.sourceAsOf).toBe(context.asOf)
  })

  it('keeps future source cutoffs and nonfinite service sums unavailable', () => {
    const data = fixture()
    data.business.asOf = '2026-09-05T17:00:00.000000001Z'
    expect(deriveBusinessDrivers(data).state).toBe('unavailable')
    const overflow = fixture()
    for (const row of overflow.business.data!.types) row.metrics.booked_value.current.value = Number.MAX_VALUE
    const result = deriveBusinessDrivers(overflow)
    expect(result.reconciliation.current.serviceSum).toBeNull()
    expect(service(overflow, 20).decomposition.state).toBe('unavailable')
    const values = result.services.flatMap(row => [...Object.values(row.current), ...Object.values(row.prior), ...Object.values(row.change),
      row.decomposition.bookingCount, row.decomposition.valuePerBooking, row.decomposition.wholeContribution])
    expect(values.every(value => value === null || Number.isFinite(value))).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/)
  })

  it('does not present an underflowed positive value-per-booking average as zero', () => {
    const data = fixture()
    data.business.data!.types[0].metrics.booked_value.current.value = Number.MIN_VALUE
    expect(service(data).current.bookedValue).toBe(Number.MIN_VALUE)
    expect(service(data).current.valuePerBooking).toBeNull()
    expect(service(data).decomposition.state).toBe('unavailable')
  })
})

describe('prepared booked-value driver finding', () => {
  it('answers the headline with a named decrease and gain, arithmetic and exact Business destination', () => {
    const data = fixture(), finding = deriveBusinessDriverReview(data)
    expect(finding.id).toBe('business_booked_value_drivers')
    expect(finding.observation.text).toMatch(/\$350.*\$400|\$400.*\$350/)
    expect(finding.observation.text).toMatch(/Service 20.*250/)
    expect(finding.observation.text).toMatch(/Service 10.*200/)
    expect(finding.nextInspection.href).toBe('/reports?report=business&from=2026-09-02&to=2026-09-04#business-drivers')
    expect(finding.limitations.join(' ')).toMatch(/arithmetic.*not.*cause|not.*causal/i)
    expect(finding.observation.text).not.toMatch(/profit|pure price|caused|refund|cancel|return/i)
    verifyFindingReferences(data, finding)
    expect(deriveBusinessReview(data).some(row => row.id === finding.id)).toBe(true)
  })

  it('states offsetting movement and residual limits without inventing healthy performance or urgency', () => {
    const data = fixture([...rows(10, [300]), ...rows(20, [100])], [...rows(10, [100], true), ...rows(20, [300], true)])
    const finding = deriveBusinessDriverReview(data)
    expect(finding.observation.text).toMatch(/unchanged|net.*zero|offset/i)
    expect(finding.observation.text).toMatch(/Service 10.*200|Service 20.*200/)
    expect(finding.priority).toBe('context')
    expect(finding.observation.text).not.toMatch(/healthy|urgent|pause|increase budget/i)
    data.business.data!.types = data.business.data!.types.slice(0, 1)
    expect(deriveBusinessDriverReview(data).counterEvidence.text).toMatch(/residual|not reconcile|incomplete/i)
  })

  it('qualifies the highlighted gain when another supplied service has no supported prior value', () => {
    const data = fixture()
    data.business.data!.types[1].metrics.booked_value.previous!.asOf = '2026-09-05T17:00:00.000000001Z'
    const finding = deriveBusinessDriverReview(data)
    expect(finding.observation.text).toMatch(/Largest supported gain: Service 10/)
    expect(finding.observation.text).toMatch(/do not fully reconcile/)
    expect(finding.observation.text).not.toMatch(/Service 20.*250/)
  })
})
