import { describe, expect, it } from 'vitest'
import { deriveAdvertisingReview } from '@/lib/reporting/review/advertising'
import { derivePerformanceReview } from '@/lib/reporting/review/performance'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { mediaMovementFixture } from './reporting-browser/media-movement-fixture'

const allocation = (data = mediaMovementFixture()) => deriveAdvertisingReview(data).find(row => row.id === 'advertising.allocation')!
const member = (data = mediaMovementFixture()) => derivePerformanceReview(data).findings.find(row => row.id === 'performance:campaign:lower')!
describe('media movement answers from native campaigns and adapter claims', () => {
  it('shows complete same-level gains and losses, including smaller offsets and separate events', () => {
    const data = mediaMovementFixture(), result = allocation(data)
    expect(() => validateReportingPacket({ context: data.context, section: 'meta', result: data.meta, notes: [] })).not.toThrow()
    expect(result.observation.text).toContain('3 supplied campaigns')
    expect(result.observation.text).toMatch(/AppointmentConfirmed value.*\+\$200.*-\$300/)
    expect(result.observation.text).toContain('Largest loss: Smaller loss (-$200)')
    expect(result.counterEvidence.text).toMatch(/Smaller loss.*-\$200/)
    expect(result.counterEvidence.text).toMatch(/Lower spend and value.*-\$100/)
    expect(result.observation.text).toContain('Purchase value')
    expect(result.exposure?.value).toBe(950)
    expect(result.observation.evidence.filter(ref => ref.path.includes('/entities/')).every(ref => ref.metric.current.entity.level === 'campaign')).toBe(true)
    expect(() => verifyFindingReferences(data, result)).not.toThrow()
  })
  it('explains a better ratio alongside falling value and count, rather than implying more business', () => {
    const result = member()
    expect(result.observation.text).toMatch(/AppointmentConfirmed ROAS increased from 3× to 10×/)
    expect(result.observation.text).toMatch(/value fell from \$300 to \$200/)
    expect(result.observation.text).toMatch(/count fell from 3 to 2/)
    expect(result.observation.text).toMatch(/spend fell from \$100 to \$20/)
    expect(result.observation.text).toMatch(/ROAS rose with lower spend despite lower reported value/)
    expect(result.direction).toBe('mixed')
  })
  it('retains a prior-only count without inventing its current value or signed change', () => {
    const data = structuredClone(mediaMovementFixture()), row = data.meta.data!.entities.find(row => row.id === 'lower')!
    row.metrics.bookings.current.availability = { state: 'unavailable', blockerCodes: ['missing_source_count'] }
    row.metrics.bookings.current.value = null
    const result = member(data)
    expect(result.observation.text).toMatch(/AppointmentConfirmed count: unavailable \(prior 3\)/)
    expect(result.observation.text).not.toContain('count fell from 3')
    const ref = result.observation.evidence.find(ref => ref.metric.key === 'bookings')!
    expect(result.evidencePeriods?.[ref.id]).toEqual(['prior'])
    expect(result.observation.text).toContain('10×')
  })
  it.each(['formula', 'clock', 'head', 'fingerprint'] as const)('rejects a forged current %s and preserves independent prior/count fields', kind => {
    const data = structuredClone(mediaMovementFixture()), row = data.meta.data!.entities.find(row => row.id === 'lower')!
    const claim = row.metrics.appointment_value.current
    if (kind === 'formula') claim.formula = 'Invented business value'
    if (kind === 'clock') claim.asOf = '2026-09-19T16:00:00Z'
    if (kind === 'head') claim.source.head = 'other-source'
    if (kind === 'fingerprint') claim.setupFingerprint = 'different'
    const result = member(data)
    expect(result.observation.text).toMatch(/AppointmentConfirmed value: unavailable \(prior \$300\)/)
    expect(result.observation.text).not.toContain('ROAS increased from 3×')
    expect(result.observation.text).toContain('count fell from 3 to 2')
  })
  it('does not recreate explicitly withheld efficiency from valid numerator and spend', () => {
    const data = structuredClone(mediaMovementFixture()), row = data.meta.data!.entities.find(row => row.id === 'lower')!
    row.metrics.purchase_roas.current.value = null
    row.metrics.purchase_roas.current.availability = { state: 'unavailable', blockerCodes: ['missing_source_value'] }
    const result = member(data)
    expect(result.observation.text).toContain('Purchase ROAS: unavailable (prior 1×)')
    expect(result.observation.text).toContain('Purchase value')
    expect(result.observation.text).not.toContain('Purchase ROAS increased')
  })
  it('states incomplete population and unresolved account differences without treating unknowns as zero', () => {
    const data = structuredClone(mediaMovementFixture()), row = data.meta.data!.entities.find(row => row.id === 'small')!
    row.metrics.purchase_value.current.value = null
    row.metrics.purchase_value.current.availability = { state: 'unavailable', blockerCodes: ['missing_source_count'] }
    const result = allocation(data)
    expect(result.observation.text).toMatch(/Purchase value.*2\/3.*unresolved account difference \+\$200/)
    expect(result.limitations.join(' ')).toMatch(/unknown.*zero|missing.*zero/i)
    expect(result.observation.text).not.toMatch(/lost revenue|recoverable|attributed revenue/)
  })
  it('does not add duplicate identities or blend campaign, ad-set and ad exposure', () => {
    const data = structuredClone(mediaMovementFixture())
    data.meta.data!.entities.push(data.meta.data!.entities[0])
    const result = allocation(data)
    expect(result.observation.text).toMatch(/duplicate campaign identit/i)
    expect(result.exposure?.value).toBe(950)
    expect(result.observation.text).not.toContain('$1,850')
  })
  it('preserves unavailable account/campaign separation, zero spend, and rejects a wrong prior window', () => {
    const data = structuredClone(mediaMovementFixture())
    data.meta.data!.entities = []
    const result = allocation(data)
    expect(result.observation.text).toContain('Account outcomes are not assigned')
    expect(result.nextInspection.href).toContain('level=campaign')
    const invalid = structuredClone(mediaMovementFixture())
    const row = invalid.meta.data!.entities.find(row => row.id === 'lower')!
    row.metrics.spend.previous!.window.start = '2026-07-01'
    expect(member(invalid).observation.text).not.toContain('spend fell from')
    expect(member(invalid).observation.text).toContain('Meta spend: $20 (prior unavailable)')
    const missing = { ...invalid, meta: { state: 'unavailable' as const, data: null, asOf: null, notes: [] } }
    expect(allocation(missing).status).toBe('unavailable')
    expect(allocation(missing).exposure).toBeNull()
  })
  it('labels settling snapshot movement as provisional and rejects partial or forged mature comparisons', () => {
    const recent = mediaMovementFixture('2026-08-20', '2026-08-22', undefined, '2026-08-23T16:00:00Z')
    expect(member(recent).observation.text).toContain('Observed changes are provisional')
    expect(member(recent).direction).toBe('mixed')
    const partial = mediaMovementFixture('2026-08-20', '2026-08-22', undefined, '2026-08-22T16:00:00Z')
    expect(member(partial).direction).toBeUndefined()
    expect(member(partial).observation.text).toContain('partial period')
    expect(member(partial).observation.text).not.toContain('ROAS increased')
    const forged = structuredClone(recent), row = forged.meta.data!.entities.find(row => row.id === 'lower')!
    row.metrics.appointment_value.current.maturity = { state: 'settled', matureThrough: '2026-08-22' }
    const finding = member(forged)
    expect(finding.observation.text).not.toContain('AppointmentConfirmed ROAS increased')
    expect(finding.observation.text).toContain('maturity differs from the native window')
  })

})
