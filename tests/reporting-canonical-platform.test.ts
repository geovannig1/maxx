import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { businessPlatformFields } from '@/lib/reporting/review/business-platform-evidence'
import { deriveBusinessPlatformReview } from '@/lib/reporting/review/business-platform'
import { validateReportingPacket } from '@/lib/reporting/validation'
import type { ReportingContext, ReportingData } from '@/lib/reporting/contracts'

const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
const context: ReportingContext = { account: { id: 'account-db', metaAccountId: '123', name: 'Fictional canonical studio' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-20T16:00:00Z' }
let mode: 'normal' | 'missing-current' | 'two' = 'normal'
function response(path: string, params: Record<string, string>) {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (path.endsWith('/campaigns')) return { data: [{ id: 'c', name: 'Campaign' }, { id: 'configured-only', name: 'Configured only' }] }
  if (path.endsWith('/adsets')) return { data: [{ id: 's', campaign_id: 'c', name: 'Ad set' }] }
  if (path.endsWith('/ads')) return { data: [{ id: 'a', campaign_id: 'c', adset_id: 's', name: 'Ad' }] }
  if (path.endsWith('/customaudiences')) return { data: [] }
  if (!path.endsWith('/insights')) throw new Error(`Unexpected fictional source path ${path}`)
  const range = JSON.parse(params.time_range)
  const row = { date_start: range.since, date_stop: params.time_increment === '1' ? range.since : range.until,
    spend: '100', reach: '90', impressions: '180', frequency: '2', campaign_id: 'c', campaign_name: 'Campaign',
    adset_id: 's', adset_name: 'Ad set', ad_id: 'a', ad_name: 'Ad',
    results: [{ indicator: 'AppointmentConfirmed', values: [{ value: '2', attribution_windows: ['default'] }, { value: '2', attribution_windows: ['7d_click'] }] }],
    conversion_values: [{ action_type: 'AppointmentConfirmed', value: '200' }],
    actions: [{ action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '100' }] }
  if (params.breakdowns === 'publisher_platform,platform_position') return { data: [{ ...row, publisher_platform: 'instagram', platform_position: 'reels' }] }
  if (params.breakdowns) return { data: [{ ...row, [params.breakdowns]: 'test' }] }
  return { data: params.level === 'campaign' && mode !== 'normal' ? [row, { ...row, campaign_id: 'second', campaign_name: 'Second', spend: '20',
    ...(mode === 'missing-current' && range.since === context.range.from ? { results: undefined } : {}) }] : [row] }
}
async function view(scope = context): Promise<ReportingData> {
  const meta = await readMetaReport(scope)
  validateReportingPacket({ context: scope, section: 'meta', result: meta, notes: [] })
  const missing = { state: 'unavailable' as const, data: null, asOf: null, notes: ['Fictional source not supplied.'] }
  return { context: scope, meta, business: missing, website: missing, measurement: missing }
}
beforeEach(() => {
  mode = 'normal'; get.mockReset(); get.mockImplementation(response); history.mockReset()
  history.mockImplementation(async (scope: ReportingContext) => ({ accountId: scope.account.id, asOf: scope.asOf,
    state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] }))
})

describe('actual adapter campaign authority in the opening review', () => {
  it('accepts valid full-reader canonical account claims while retaining inventory-only unknowns', async () => {
    const data = await view(), metrics = data.meta.data!.metrics, fields = businessPlatformFields(data)
    expect(metrics.bookings.current.measurementKind).toBe('derived')
    expect(metrics.bookings.current.inputClaimIds).toHaveLength(1)
    expect(data.meta.data!.entities.filter(row => row.level === 'campaign')).toHaveLength(2)
    expect(fields.bookings.current?.value).toBe(2)
    expect(fields.bookings.prior?.value).toBe(2)
    expect(fields.appointment_value.current?.value).toBe(200)
    expect(fields.appointment_roas.current?.value).toBe(2)
    expect(fields.appointment_roas.change).toBe(0)
    expect(fields.purchase_count.current?.value).toBe(1)
    expect(fields.spend.current?.value).toBe(100)
    expect(deriveBusinessPlatformReview(data).observation.text).toContain('AppointmentConfirmed')
    const bad = structuredClone(data); bad.meta.data!.metrics.bookings.current.window.start = '2026-09-03'
    expect(businessPlatformFields(bad).bookings.current).toBeNull()
  })

  it('preserves a valid prior count and independent value/ROAS when current count is missing', async () => {
    mode = 'missing-current'
    const data = await view(), fields = businessPlatformFields(data)
    expect(data.meta.data!.metrics.bookings.current.value).toBeNull()
    expect(fields.bookings.current).toBeNull()
    expect(fields.bookings.prior?.value).toBe(4)
    expect(fields.bookings.change).toBeNull()
    expect(fields.appointment_value.current?.value).toBe(400)
    expect(fields.appointment_roas.current?.value).toBe(4)
  })

  it.each(['value', 'formula', 'duplicate', 'unresolved', 'coverage', 'wrong-event', 'source-clock', 'input-maturity', 'omitted-member'] as const)
  ('rejects %s corruption without erasing independent Purchase/spend', async change => {
    mode = 'two'
    const data = structuredClone(await view())
    expect(businessPlatformFields(data).bookings.current?.value).toBe(4)
    const metric = data.meta.data!.metrics.bookings, claim = metric.current
    if (change === 'value') claim.value = 99
    if (change === 'formula') claim.formula = 'SUM of invented values'
    if (change === 'duplicate') claim.inputClaimIds = [claim.inputClaimIds[0], claim.inputClaimIds[0]]
    if (change === 'unresolved') claim.inputClaimIds = ['missing-campaign-claim']
    if (change === 'coverage') claim.coverage = { state: 'complete', numerator: 1, denominator: 1 }
    if (change === 'wrong-event') data.meta.data!.entities.find(row => row.level === 'campaign' && row.id === 'c')!.metrics.bookings.event = 'Purchase'
    if (change === 'source-clock') data.meta.data!.entities.find(row => row.level === 'campaign' && row.id === 'c')!.metrics.bookings.current.asOf = '2026-09-19T16:00:00Z'
    if (change === 'input-maturity') data.meta.data!.entities.find(row => row.level === 'campaign' && row.id === 'c')!.metrics.bookings.current.maturity = { state: 'settling', matureThrough: '2026-09-01' }
    if (change === 'omitted-member') { claim.inputClaimIds = [claim.inputClaimIds[0]]; claim.value = 2; claim.coverage = { state: 'complete', numerator: 1, denominator: 1 } }
    const fields = businessPlatformFields(data)
    expect(fields.bookings.current).toBeNull()
    // Duplicate lineage violates the whole metric schema; a wrong metric event affects both periods.
    if (change === 'duplicate') expect(() => validateReportingPacket({ context, section: 'meta', result: data.meta, notes: [] })).toThrow()
    expect(fields.bookings.prior?.value ?? null).toBe(['wrong-event', 'duplicate'].includes(change) ? null : 4)
    expect(fields.purchase_count.current?.value).toBe(1)
    expect(fields.spend.current?.value).toBe(100)
  })

  it('does not reconstruct deliberately withheld efficiency', async () => {
    mode = 'two'
    const data = await view()
    expect(data.meta.data!.metrics.purchase_value.current.value).toBe(100)
    expect(data.meta.data!.metrics.purchase_roas.current.value).toBeNull()
    const fields = businessPlatformFields(data)
    expect(fields.purchase_value.current?.value).toBe(100)
    expect(fields.purchase_roas.current).toBeNull()
  })

  it('retains qualified recent canonical observations without accepting a forged settled verdict', async () => {
    const data = structuredClone(await view({ ...context, asOf: '2026-09-05T16:00:00Z' }))
    const fields = businessPlatformFields(data)
    expect(fields.bookings.current?.value).toBe(2)
    expect(fields.bookings.current?.eligible).toBe(false)
    expect(fields.bookings.change).toBeNull()
    data.meta.data!.metrics.bookings.current.maturity = { state: 'settled', matureThrough: context.range.to }
    const forged = businessPlatformFields(data).bookings
    expect(forged.current?.value).toBe(2)
    expect(forged.current?.qualifications).toContain('settling native observation window')
    expect(forged.change).toBeNull()
  })

  it('retains qualified partial-day canonical observations without inventing a complete-period change', async () => {
    const data = await view({ ...context, asOf: '2026-09-04T16:00:00Z' })
    expect(data.meta.data!.metrics.bookings.current.value).toBe(2)
    expect(data.meta.data!.metrics.bookings.current.maturity.state).toBe('partial')
    const fields = businessPlatformFields(data)
    expect(fields.bookings.current?.value).toBe(2)
    expect(fields.bookings.current?.qualifications).toContain('partial period')
    expect(fields.bookings.change).toBeNull()
    expect(fields.appointment_roas.current?.value).toBe(2)
  })
})
