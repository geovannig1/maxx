import './_support/outcome-noun-booking'
import { describe, expect, it } from 'vitest'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportingData } from '@/lib/reporting/contracts'
import { deriveBusinessReview } from '@/lib/reporting/review/business'
import { deriveExpertReview } from '@/lib/reporting/review'
import { findingEvidence, verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { platformBooking as booking, platformData, platformMeta } from './fixtures/reporting-business-platform'

const direct = (data: ReportingData) => deriveBusinessReview(data).find(row => row.id === 'business_platform_trend')!
function integrated(data: ReportingData) {
  for (const section of ['business', 'meta'] as const) validateReportingPacket({ context: data.context, section, result: data[section], notes: [] })
  const review = deriveExpertReview(data)
  expect(review.input.rejectedSources).toEqual([])
  return review.findings.find(row => row.id === 'business_platform_trend')!
}
const evidence = (finding: ReturnType<typeof direct>, key: string) => findingEvidence(finding).find(ref => ref.metric.key === key)
function replace(data: ReportingData, source: 'business' | 'meta', key: string, period: 'current' | 'previous', patch: Partial<MetricClaim>) {
  const metric = data[source].data!.metrics[key]
  data[source].data!.metrics[key] = { ...metric, [period]: { ...metric[period]!, ...patch } }
}

describe('native business and platform prepared comparison', () => {
  it('answers booked-demand gain, contrary recorded payments, and separately named Meta outcomes without other sources', () => {
    const data = platformData(), result = integrated(data)
    expect(result.observation.text).toMatch(/booked value (rose|increased)/i)
    expect(result.observation.text).toMatch(/recorded (payments|amount paid) (fell|decreased)/i)
    for (const value of ['$1,200', '$800', '$200', '$600', '$500', 'AppointmentConfirmed', 'Purchase', 'ROAS', '4×', '3×']) {
      expect(`${result.observation.text} ${result.counterEvidence.text}`).toContain(value)
    }
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/active bookings.*2.*1/i)
    expect(evidence(result, 'booked_value')?.metric.current.value).toBe(1200)
    expect(evidence(result, 'appointment_roas')?.metric.current.inputClaimIds).toEqual([
      data.meta.data!.metrics.appointment_value.current.claimId, data.meta.data!.metrics.spend.current.claimId,
    ])
    verifyFindingReferences(data, result)
    expect(result.authority).toEqual({ state: 'diagnostic', executable: false })
    expect(result.limitations.join(' ')).toMatch(/causal|causation/)
  })

  it('preserves complete booked demand when current payment fields are only an observed lower bound', () => {
    const result = integrated(platformData([booking(1, 600, 100), booking(2, 600, null)]))
    expect(result.observation.text).toMatch(/booked value (rose|increased)/i)
    expect(result.observation.text).toMatch(/\$100.*(partial|lower bound)/i)
    expect(result.observation.text).not.toMatch(/recorded (payments|amount paid) (fell|decreased)/i)
    expect(result.limitations.join(' ')).toMatch(/amount paid.*comparison.*(partial|coverage|incomplete)/i)
  })

  it('surfaces opposed booked value and active appointment movement instead of calling all business growth', () => {
    const result = integrated(platformData([booking(1, 1500, 500)], [booking(2, 400, 300), booking(3, 400, 300)]))
    expect(result.observation.text).toMatch(/booked value (rose|increased).*active bookings (fell|decreased)/i)
    expect(result.status).toBe('mixed')
  })

  it('compares aligned, opposed and unchanged supported evidence without inventing an account health or buying instruction', () => {
    const aligned = integrated(platformData([booking(1, 1000, 1000)], [booking(2, 500, 500)], platformMeta(600, 20, 2400, 4, 1200), platformMeta(500, 10, 1000, 2, 500)))
    expect(aligned.observation.text).toMatch(/(aligned|same direction)/i)
    expect(aligned.status).toBe('observed')
    const opposed = integrated(platformData([booking(1, 400, 400)], [booking(2, 800, 800)]))
    expect(opposed.observation.text).toMatch(/(opposed|opposite)/i)
    const stable = integrated(platformData([booking(1, 500, 500)], [booking(2, 500, 500)], platformMeta(), platformMeta()))
    expect(stable.status).toBe('unchanged')
    expect(stable.observation.text).toMatch(/unchanged/i)
    expect(stable.counterEvidence.text).toMatch(/(ad|entity|execution)/i)
    expect(stable.observation.text).not.toMatch(/healthy|no intervention|increase.*budget|pause/i)
  })

  it('does not hide a falling appointment count behind unchanged booked value', () => {
    const result = integrated(platformData([booking(1, 800, 800)], [booking(2, 400, 400), booking(3, 400, 400)],
      platformMeta(600, 20, 2400, 4, 1200), platformMeta(500, 10, 1000, 2, 500)))
    expect(result.status).toBe('mixed')
    expect(result.observation.text).toMatch(/active bookings fell/i)
    expect(result.observation.text).toMatch(/active bookings[^.]*oppos|oppos[^.]*active bookings/i)
    expect(result.observation.text).not.toMatch(/matched booked-demand measures were unchanged/i)
  })

  it('does not relabel an unavailable active-appointment comparison as unchanged', () => {
    const data = platformData([booking(1, 100, 100)], [booking(2, 100, 100)])
    delete data.business.data!.metrics.active_appointments
    const result = integrated(data)
    expect(result.observation.text).toMatch(/booked value was unchanged/i)
    expect(result.observation.text).toMatch(/active bookings: unavailable/i)
    expect(result.observation.text).not.toMatch(/booked value and active appointments were unchanged/i)
    expect(result.status).toBe('mixed')
  })

  it('retains actual zero and never fills a missing named event from the other event or its value', () => {
    const result = integrated(platformData([], [], platformMeta(50, 0, 0, 0, 0), platformMeta(50, 0, 0, 0, 0)))
    expect(result.observation.text).toContain('$0')
    expect(result.observation.text).toMatch(/AppointmentConfirmed.*0/)
    const missing = integrated(platformData(undefined, undefined, { spend: '600', actions: platformMeta().actions, action_values: platformMeta().action_values }))
    expect(evidence(missing, 'bookings')?.metric.current.availability.state ?? 'unavailable').toBe('unavailable')
    expect(missing.observation.text).not.toMatch(/AppointmentConfirmed[^;.]*20/)
    expect(missing.observation.text).toContain('Purchase')
  })

  it.each(['entity', 'unit', 'definition', 'window', 'clock'] as const)('withholds a rejected prior %s while retaining healthy current evidence and a precise presentation mask', reason => {
    const data = platformData(), metric = data.business.data!.metrics.booked_value, prior = metric.previous!
    replace(data, 'business', 'booked_value', 'previous', reason === 'entity' ? { entity: { ...prior.entity, id: 'another' } }
      : reason === 'unit' ? { unit: 'count' } : reason === 'definition' ? { formula: 'Invented booked demand.' }
        : reason === 'window' ? { window: { ...prior.window, start: '2026-08-29' } }
          : { asOf: '2026-09-20T17:00:00.000000001Z' })
    const result = direct(data), ref = evidence(result, 'booked_value')!
    expect(ref).toBeDefined()
    expect(result.evidencePeriods?.[ref.id]).toEqual(['current'])
    expect(result.observation.text).toContain('$1,200')
    expect(result.observation.text).not.toMatch(/booked value (rose|increased)/i)
  })

  it('retains a healthy prior when only the current native identity is invalid', () => {
    const data = platformData()
    replace(data, 'business', 'booked_value', 'current', { unit: 'count' })
    const result = direct(data), ref = evidence(result, 'booked_value')!
    expect(result.evidencePeriods?.[ref.id]).toEqual(['prior'])
    expect(result.observation.text).toMatch(/booked value: unavailable.*prior \$800/i)
    expect(result.observation.text).not.toContain('$1,200')
  })

  it.each(['stale', 'settling', 'partial'] as const)('qualifies %s current Meta outcomes without inventing a matched change', state => {
    const data = platformData(), claim = data.meta.data!.metrics.bookings.current
    replace(data, 'meta', 'bookings', 'current', state === 'stale' ? { freshness: { ...claim.freshness, state } }
      : { maturity: { state, matureThrough: null } })
    const result = direct(data)
    expect(result.observation.text).toMatch(new RegExp(`AppointmentConfirmed[^;]*20[^;]*${state}`, 'i'))
    expect(result.limitations.join(' ')).toMatch(/AppointmentConfirmed.*comparison/i)
  })

  it.each(['event', 'unit', 'head', 'input', 'arithmetic'] as const)('rejects wrong Meta %s meaning or ROAS lineage while keeping independent measures', reason => {
    const data = platformData(), metrics = data.meta.data!.metrics
    if (reason === 'event') metrics.appointment_roas = { ...metrics.appointment_roas, event: 'Purchase' }
    else replace(data, 'meta', 'appointment_roas', 'current', reason === 'unit' ? { unit: 'money' }
      : reason === 'head' ? { source: { ...metrics.appointment_roas.current.source, head: 'another' } }
        : reason === 'input' ? { inputClaimIds: [metrics.purchase_value.current.claimId, metrics.spend.current.claimId] }
          : { value: 999 })
    const result = direct(data), ref = evidence(result, 'appointment_roas')
    expect(ref ? result.evidencePeriods?.[ref.id] : []).not.toContain('current')
    expect(result.observation.text).not.toContain('999')
    expect(result.observation.text).toContain('$1,200')
    expect(result.observation.text).toContain('Purchase')
  })

  it('rejects malformed packets in the integrated entry point and preserves the independent source', () => {
    const data = platformData()
    replace(data, 'meta', 'bookings', 'current', { value: Number.NaN })
    const review = deriveExpertReview(data), result = review.findings.find(row => row.id === 'business_platform_trend')!
    expect(review.input.rejectedSources).toEqual(['meta'])
    expect(result.observation.text).toMatch(/booked value (rose|increased)/i)
    expect(result.observation.text).toMatch(/Meta.*unavailable/i)
    expect(result.observation.evidence.every(ref => ref.source === 'business')).toBe(true)
  })
})
