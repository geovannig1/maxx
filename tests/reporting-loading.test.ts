import { describe, expect, it } from 'vitest'
import { mergeReportingPackets } from '@/lib/reporting/use-reporting-data'
import type { ReportingContext, ReportingPacket } from '@/lib/reporting/contracts'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessUpcoming, type BusinessIntelligenceRow } from '@/lib/reporting/business-intelligence-metrics'
import { creativeReportingFixture } from './reporting-browser/creative-fixture'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { deriveExpertReview } from '@/lib/reporting/review'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { businessExportRows } from '@/lib/reporting/business-export'
import { metricsToExportRows } from '@/lib/reporting/export'
import { pendingBusinessIntelligence } from '@/lib/reporting/business-progress'

function independentPackets() {
  const data = creativeReportingFixture()
  const meta = { section: 'meta' as const, context: data.context, result: data.meta, notes: [] }
  const rows: BusinessIntelligenceRow[] = [
    { id: 1, booking_date_et: data.context.range.from, appointment_type: 'Studio', appointment_type_id: 1,
      price: 200, amount_paid: 150, canceled: false, email: 'fictional@example.test', appointment_duration: '60', datetime_created: null, datetime: null },
    { id: 2, booking_date_et: data.context.comparison.from, appointment_type: 'Studio', appointment_type_id: 1,
      price: 100, amount_paid: 100, canceled: false, email: 'fictional@example.test', appointment_duration: '60', datetime_created: null, datetime: null },
  ]
  const businessAt = (asOf: string, pending = false): Extract<ReportingPacket, { section: 'business' }> => {
    const context: ReportingContext = { ...data.context, asOf }
    const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
    return { section: 'business', context, result: { state: pending ? 'partial' : 'available', asOf, notes: [], data: {
      ...buildBusinessReport(context, [rows[0]], [rows[1]]), intelligence: pending ? pendingBusinessIntelligence() : {
        customers: buildBusinessCustomers(context, rows), leadTime: unavailable,
        // The upcoming read has its own later actual observation; it is not the booking-cohort cutoff.
        upcoming: buildBusinessUpcoming(context, [], '2026-09-05T17:00:01Z'),
      },
    } }, notes: [] }
  }
  return { meta, businessAt }
}
const packet: ReportingPacket = { section: 'meta', context: {
  account: { id: 'db', metaAccountId: 'act_1', name: 'Studio' }, range: { from: '2026-09-02', to: '2026-09-04' },
  comparison: { from: '2026-08-30', to: '2026-09-01' }, timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00Z',
}, result: { state: 'unavailable', data: null, asOf: null, notes: [] }, notes: [] }
describe('independent reporting responses', () => {
  it('does not fabricate an account before a source resolves and leaves other sources loading', () => {
    expect(mergeReportingPackets({})).toBeNull()
    expect(mergeReportingPackets({ meta: packet, business: undefined })).not.toBeNull()
    expect(mergeReportingPackets({ meta: packet })).toMatchObject({ meta: { state: 'unavailable' }, business: { state: 'loading' }, website: { state: 'loading' } })
  })
  it('rejects mixing different account or date responses', () => {
    const business: ReportingPacket = { ...packet, section: 'business', result: { state: 'unavailable', data: null, asOf: null, notes: [] }, context: { ...packet.context, account: { ...packet.context.account, id: 'other' } } }
    expect(() => mergeReportingPackets({ meta: packet, business })).toThrow('contexts do not match')
  })
  it('accepts a cosmetic account rename across immutable reports while still checking both IDs', () => {
    const business: ReportingPacket = { ...packet, section: 'business', result: { state: 'unavailable', data: null, asOf: null, notes: [] },
      context: { ...packet.context, account: { ...packet.context.account, name: 'Renamed studio' } } }
    expect(() => mergeReportingPackets({ meta: packet, business })).not.toThrow()
    expect(packet.context.account.name).toBe('Studio')
    expect(() => mergeReportingPackets({ meta: packet, business: { ...business, context: { ...business.context,
      account: { ...business.context.account, metaAccountId: 'act_2' } } } })).toThrow()
  })

  it('merges independently timed native Meta assignment and business packets without losing either review', () => {
    const { meta, businessAt } = independentPackets(), business = businessAt('2026-09-05T17:00:00.000000001Z')
    expect(() => validateReportingPacket(meta)).not.toThrow()
    expect(() => validateReportingPacket(business)).not.toThrow()
    const before = JSON.stringify({ meta, business }), merged = mergeReportingPackets({ meta, business })!
    expect(merged.context.asOf).toBe(business.context.asOf)
    expect(merged.meta).toBe(meta.result)
    expect(merged.business).toBe(business.result)
    const review = deriveExpertReview(merged)
    expect(review.input.rejectedSources).toEqual([])
    expect(review.findings.find(finding => finding.id === 'business_customers')!.status).not.toBe('unavailable')
    expect(review.findings.find(finding => finding.id === 'creative_response:301')!.observation.text).toContain('AppointmentConfirmed 0')
    expect(buildCreativeGroups(merged).groups.map(group => group.id)).toEqual(buildCreativeGroups({ context: meta.context, meta: meta.result }).groups.map(group => group.id))
    expect(merged.meta.data!.creativeAssignmentEvidence!.asOf).toBe(meta.context.asOf)
    expect(merged.business.data!.intelligence!.upcoming.asOf).toBe('2026-09-05T17:00:01Z')
    expect(JSON.stringify({ meta, business })).toBe(before)
  })

  it('does not let a later independent packet legitimize a source beyond its own cutoff', () => {
    const { meta, businessAt } = independentPackets(), source = businessAt('2026-09-05T17:00:00.000000002Z')
    expect(() => mergeReportingPackets({ business: source })).not.toThrow()
    const bad = { ...source, context: { ...source.context, asOf: '2026-09-05T17:00:00.000000001Z' } }
    const website: ReportingPacket = { section: 'website', context: { ...meta.context, asOf: '2026-09-05T17:00:02Z' },
      result: { state: 'unavailable', data: null, asOf: null, notes: [] }, notes: [] }
    expect(() => mergeReportingPackets({ meta, business: bad, website })).toThrow(/observation|cutoff|clock/i)
  })

  it('preserves progressive source values and native export clocks as independently prepared sections complete', () => {
    const { meta, businessAt } = independentPackets()
    const progress = businessAt('2026-09-05T17:00:00.000000001Z', true), business = businessAt('2026-09-05T17:00:00.000000002Z')
    const first = mergeReportingPackets({ meta })!, pending = mergeReportingPackets({ meta, business: progress })!
    const final = mergeReportingPackets({ meta, business })!
    expect(first.business.state).toBe('loading')
    expect(pending.business.data!.metrics.booked_value.current.value).toBe(200)
    expect(pending.business.data!.intelligence!.customers.state).toBe('loading')
    expect(final.business.data!.intelligence!.customers.state).toBe('partial')
    expect(pending.context.asOf).toBe(progress.context.asOf)
    expect(final.context.asOf).toBe(business.context.asOf)
    expect(metricsToExportRows(final.meta.data!.metrics, 'Meta account', final.context))
      .toEqual(metricsToExportRows(meta.result.data!.metrics, 'Meta account', meta.context))
    expect(businessExportRows(final)).toEqual(businessExportRows({ ...final, context: business.context }))
    expect(businessExportRows(final).filter(row => row.entity.startsWith('Acuity customer'))
      .every(row => row.as_of === business.context.asOf && row.previous_as_of === business.context.asOf)).toBe(true)
    expect(deriveExpertReview(final).input.snapshotBinding).toBe('not_attached')
  })
})
