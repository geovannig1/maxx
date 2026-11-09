import { describe, expect, it } from 'vitest'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { EXECUTIVE_ANSWER_MODES, executiveAnswerFixture, executiveAnswerInputs } from './reporting-browser/executive-answer-fixture'

const clock = '2026-09-07T05:30:00.000Z'
const fixture = (mode: typeof EXECUTIVE_ANSWER_MODES[number]) => executiveAnswerFixture(undefined, undefined, mode, mode === 'settling' ? undefined : clock)
const finding = (mode: typeof EXECUTIVE_ANSWER_MODES[number]) => deriveExpertReview(fixture(mode)).findings.find(row => row.id === 'business_platform_trend')!

describe('fictional native executive opening scenarios', () => {
  it.each(EXECUTIVE_ANSWER_MODES)('validates every source packet in %s without rejected inputs', mode => {
    const data = fixture(mode)
    for (const section of ['business', 'meta', 'website', 'measurement'] as const)
      validateReportingPacket({ context: data.context, section, result: data[section]!, notes: ['Fictional native scenario.'] })
    expect(deriveExpertReview(data).input.rejectedSources).toEqual([])
  })
  it('retains original native definitions, raw values and both-period input lineage', () => {
    const data = fixture('opposing'), input = executiveAnswerInputs('opposing')
    expect(data.business.data).toEqual(buildBusinessReport(data.context, input.current, input.prior))
    expect(data.meta.data!.metrics).toEqual(buildMetaMetrics(data.context, input.metaCurrent, input.metaPrior, { level: 'account', id: data.context.account.id }))
    for (const metric of Object.values(data.meta.data!.metrics)) for (const claim of [metric.current, metric.previous!]) {
      expect(claim.formula).not.toMatch(/synthetic|fictional|browser-test/i)
      if (claim.measurementKind === 'derived') expect(claim.inputClaimIds.length).toBeGreaterThan(0)
    }
  })
  it('shows opposite booked demand and Meta changes, and independently contrary payments', () => {
    expect(finding('opposing').observation.text).toMatch(/booked value fell.*(opposed|opposite)/i)
    expect(finding('opposing').observation.text).toContain('$400')
    expect(finding('payments').observation.text).toMatch(/booked value rose.*recorded amount paid fell/i)
    expect(finding('payments').observation.text).toContain('$200')
    expect(finding('aligned').observation.text).toMatch(/aligned/i)
  })
  it('keeps stable account totals beside lower-ranked zero, unknown and improving native entities', () => {
    const data = fixture('stable'), review = deriveExpertReview(data), sets = data.meta.data!.entities.filter(row => row.level === 'adset')
    expect(finding('stable').status).toBe('unchanged')
    expect(finding('stable').observation.text).not.toMatch(/healthy|no intervention|increase.*budget|pause/i)
    expect(sets).toHaveLength(10)
    expect(sets[6].metrics.bookings.current.value).toBe(0)
    expect(sets[9].metrics.bookings.current.availability.state).toBe('unavailable')
    expect(sets[7].metrics.spend.current.value).toBe(15)
    expect(sets[7].metrics.spend.previous!.value).toBe(75)
    expect(overviewFindings(review).some(row => row.zeroOutcomeSpend)).toBe(true)
    expect(overviewFindings(review).some(row => row.direction === 'improved')).toBe(true)
    for (const period of ['current', 'previous'] as const) for (const level of ['campaign', 'adset', 'ad'])
      expect(data.meta.data!.entities.filter(row => row.level === level).reduce((sum, row) => sum + Number(row.metrics.spend[period]!.value), 0)).toBe(data.meta.data!.metrics.spend[period]!.value)
  })
  it('withholds one unavailable source without erasing the independent native observations', () => {
    expect(finding('business-missing').observation.text).toMatch(/booked value: unavailable.*Meta:.*20/i)
    expect(finding('meta-missing').observation.text).toMatch(/booked value.*\$400.*Meta observations are unavailable/i)
    expect(finding('partial-payment').observation.text).toMatch(/booked value rose/i)
    expect(finding('partial-payment').observation.text).not.toMatch(/recorded amount paid (fell|rose)/i)
  })
  it('uses an explicit fictional settling clock and keeps current observations without matched outcome changes', () => {
    const data = fixture('settling')
    expect(data.context.asOf).toBe('2026-08-22T17:00:00.000Z')
    expect(data.meta.data!.metrics.bookings.current.maturity.state).not.toBe('settled')
    expect(finding('settling').observation.text).toMatch(/AppointmentConfirmed[^;]*20[^;]*(settling|partial)/i)
    expect(data.meta.notes.join(' ')).toMatch(/fictional.*clock/i)
  })
  it('changes both native cohorts for a different historical date range, not merely their labels', () => {
    const data = executiveAnswerFixture('2026-08-16', '2026-08-18', 'opposing', clock)
    expect(data.business.data!.metrics.booked_value.current.value).toBe(1000)
    expect(data.business.data!.metrics.booked_value.previous!.value).toBe(0)
    expect(data.meta.data!.metrics.bookings.current.value).toBe(10)
    expect(data.meta.data!.metrics.bookings.previous!.value).toBe(0)
    expect(data.meta.data!.metrics.impressions.previous!.value).toBe(0)
    expect(data.context.comparison).toEqual({ from: '2026-08-13', to: '2026-08-15' })
  })
})
