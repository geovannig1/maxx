import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MeasurementEvidence } from '@/components/reporting/MeasurementEvidence'
import { collectReportExportRows } from '@/components/reporting/ReportsReport'
import { makeReportMetric } from '@/lib/reporting/claims'
import type { ReportingData } from '@/lib/reporting/contracts'
import { reportingFixture } from '../scripts/demo/sample/reports'

const context: ReportingData['context'] = { account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00Z' }
const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
const data: ReportingData = { context, meta: unavailable, business: unavailable, website: unavailable }

describe('booking association and transport evidence', () => {
  it('omits refund and cancellation reporting from the visible evidence and exports while preserving delivery counts', () => {
    const fixture = reportingFixture()
    const html = renderToStaticMarkup(<MeasurementEvidence data={fixture} />)
    expect(html).toContain('Live-accepted CAPI confirmations')
    expect(html).not.toMatch(/cancel|refund|customer returns/i)
    for (const preset of ['results', 'website'] as const) {
      const rows = collectReportExportRows(fixture, preset)
      expect(JSON.stringify(rows).match(/cancel|refund|customer returns/i)?.[0]).toBeUndefined()
      expect(rows.find(row => row.metric === 'Live-accepted CAPI confirmations')?.value).toBe(4)
    }
  })
  it('shows a measured lower bound with its caveat while transport is independently unavailable', () => {
    const metric = makeReportMetric({ context, source: 'first_party_attribution', key: 'linked_value_bearing_bookings',
      label: 'Observed linked bookings', definition: 'Active positive-price bookings linked to an immutable paid touch.',
      unit: 'count', current: 2, previous: null, basis: 'booking_created_date_et',
      entity: { level: 'business', id: context.account.id },
      coverage: { state: 'partial', numerator: 2, denominator: 8 } })
    const html = renderToStaticMarkup(<MeasurementEvidence data={{ ...data, measurement: { state: 'partial',
      asOf: context.asOf, notes: [], data: { paidAssociation: { linked_value_bearing_bookings: metric }, capi: {},
        paidAssociationNotes: ['Observed lower bound; linker completeness unverified.'],
        capiNotes: ['CAPI receipts could not be read.'], sourceDescription: 'Exact selected booking dates.' } } }} />)
    expect(html).toContain('Observed linked bookings')
    expect(html).toContain('Observed lower bound')
    expect(html).toContain('Partial evidence')
    expect(html).toContain('CAPI receipts could not be read')
    expect(html).not.toContain('Paid CPA')
    expect(html).not.toContain('0 receipts')
  })
  it('explains absent measurement evidence without inventing zero linked bookings', () => {
    const html = renderToStaticMarkup(<MeasurementEvidence data={data} />)
    expect(html).toContain('Booking links and tracking')
    expect(html).toContain('unavailable')
    expect(html).not.toContain('0 linked')
  })

  it('renders paid-touch lag evidence as association timing and exports it with the existing measurement rows', () => {
    const lag = makeReportMetric({ context, source: 'first_party_attribution', key: 'median_paid_touch_to_booking_lag_days',
      label: 'Median paid-touch to booking lag', definition: 'Median elapsed days from the observed paid-touch timestamp to booking creation among linked eligible bookings.',
      unit: 'days', current: 2.5, basis: 'booking_created_date_et', entity: { level: 'business', id: context.account.id },
      coverage: { state: 'partial', numerator: 2, denominator: 3 }, measurementKind: 'associated_noncausal' })
    const withMeasurement: ReportingData = { ...data, measurement: { state: 'partial', asOf: context.asOf,
      notes: [], data: { paidAssociation: { median_paid_touch_to_booking_lag_days: lag }, capi: {},
        paidAssociationNotes: ['Lag is observed only among linked eligible bookings and is not booking-to-service lead time.'],
        capiNotes: [], sourceDescription: 'Paid touch timing evidence.' } } }
    const html = renderToStaticMarkup(<MeasurementEvidence data={withMeasurement} />)
    expect(html).toContain('Median paid-touch to booking lag')
    expect(html).toContain('not booking-to-service lead time')
    expect(html).not.toMatch(/click/i)
    const rows = collectReportExportRows(withMeasurement, 'website')
    expect(rows[0]).toMatchObject({ metric: 'Median paid-touch to booking lag', unit: 'days', value: 2.5 })
  })
  it('retains association source, date basis and completeness limits in the Results and Website CSVs', () => {
    const metric = makeReportMetric({ context, source: 'first_party_attribution', key: 'linked_value_bearing_bookings',
      label: 'Observed linked bookings', definition: 'Observed links, not a complete paid cohort.',
      unit: 'count', current: 2, basis: 'booking_created_date_et', entity: { level: 'business', id: context.account.id },
      coverage: { state: 'partial', numerator: 2, denominator: 8 } })
    const withMeasurement: ReportingData = { ...data, measurement: { state: 'partial', asOf: context.asOf,
      notes: [], data: { paidAssociation: { linked_value_bearing_bookings: metric }, capi: {},
        paidAssociationNotes: ['Linker completeness unverified.'], capiNotes: [], sourceDescription: 'Selected cohorts.' } } }
    for (const preset of ['results', 'website'] as const) {
      const rows = collectReportExportRows(withMeasurement, preset)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ source: 'first_party_attribution', date_basis: 'booking_created_date_et',
        from: '2026-09-02', to: '2026-09-04', value: 2 })
      expect(rows[0].limitations).toContain('Linker completeness unverified')
    }
  })
})
