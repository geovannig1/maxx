import { describe, expect, it } from 'vitest'
import type { ReportMetricMap } from '@/lib/reporting/contracts'
import { deriveExpertReview } from '@/lib/reporting/review'
import { deriveCreativeReview } from '@/lib/reporting/review/creative'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { fixturePacket, reportingFixture } from '../scripts/demo/sample/reports'

const attention = (data = reportingFixture()) => deriveCreativeReview(data).find(finding => finding.id === 'creative_attention')!

describe('fictional reporting preview evidence', () => {
  it.each(['meta', 'business', 'website', 'measurement'])('validates the %s source packet', section => {
    expect(() => validateReportingPacket(fixturePacket(section, '2026-09-02', '2026-09-04'))).not.toThrow()
  })

  it('preserves the selected-account controls and native event attribution splits', () => {
    const data = reportingFixture()
    expect(data.context.account).toEqual({ id: 'fixture-db', metaAccountId: 'act_123', name: 'Studio test account' })
    const metrics = data.meta.data!.metrics
    for (const [key, value] of Object.entries({ spend: 120, bookings: 3, bookings_click: 2, bookings_view: 1,
      appointment_value: 300, purchase_count: 2, purchase_value: 200 })) {
      expect(metrics[key]?.current.value, key).toBe(value)
    }
    expect(metrics.bookings.event).toBe('AppointmentConfirmed')
    expect(metrics.purchase_count.event).toBe('Purchase')
    expect(data.meta.data!.sourceDescription).toContain('Synthetic')
    expect(data.business.data!.metrics.amount_paid.current.value).toBe(500)
  })

  it('preserves native metric definitions and lineage while disclosing fictional sources', () => {
    const data = reportingFixture()
    const nativeMeta = buildMetaMetrics(data.context, { spend: '120' }, { spend: '60' })
    const nativeBusiness = buildBusinessReport(data.context, [], [])
    for (const [actual, native] of [[data.meta.data!.metrics, nativeMeta], [data.business.data!.metrics, nativeBusiness.metrics]]) {
      for (const [key, metric] of Object.entries(actual)) {
        expect(metric.definition, key).toBe(native[key].definition)
        for (const period of ['current', 'previous'] as const) {
          expect(metric[period]?.formula, `${key}:${period}`).toBe(native[key][period]?.formula)
          expect(metric[period]?.source.head, `${key}:${period}`).toBe(native[key][period]?.source.head)
        }
      }
    }
    expect(data.business.data!.sourceDescription).toContain('Synthetic')
  })

  it.each(['2026-09-02', '2026-09-01'])('reconciles every additive Meta population for %s in both periods', from => {
    const meta = reportingFixture(from, '2026-09-04').meta.data!
    const additive = ['spend', 'bookings', 'bookings_click', 'bookings_view', 'appointment_value', 'purchase_count',
      'purchase_value', 'impressions', 'clicks', 'link_clicks', 'outbound_clicks', 'landing_page_views',
      'engagements', 'reactions', 'comments', 'shares', 'saves']
    for (const period of ['current', 'previous'] as const) {
      for (const key of additive) {
        const total = meta.metrics[key][period]!.value
        for (const level of ['campaign', 'adset', 'ad']) {
          const children = meta.entities.filter(entity => entity.level === level)
          for (const child of children) expect(child.metrics[key][period]).toMatchObject({
            value: expect.any(Number), availability: { state: 'available' }, coverage: { state: 'complete' },
          })
          expect(children.reduce((sum, entity) => sum + Number(entity.metrics[key][period]!.value), 0), `${level}:${period}:${key}`).toBe(total)
        }
      }
    }
    const [video, image] = meta.entities.filter(entity => entity.level === 'ad')
    expect(video.metrics.spend.current.value).toBe(from === '2026-09-02' ? 80 : 160)
    expect(image.metrics.spend.current.value).toBe(from === '2026-09-02' ? 40 : 80)
    expect(video.metrics.bookings.current.value).toBe(2)
    expect(image.metrics.bookings.current.value).toBe(1)
  })

  it('keeps image video evidence missing and explicit zero conversion evidence available', () => {
    const meta = reportingFixture().meta.data!
    const video = meta.entities.find(entity => entity.id === 'ad-1')!
    const image = meta.entities.find(entity => entity.id === 'ad-2')!
    for (const period of ['current', 'previous'] as const) {
      for (const key of ['video_plays', 'video_2s', 'thruplays', 'watch_p25', 'watch_p50', 'watch_p75', 'watch_p100',
        'retention_p25', 'retention_p50', 'retention_p75', 'retention_p100', 'average_watch_seconds']) {
        expect(image.metrics[key][period]).toMatchObject({ value: null, availability: { state: 'unavailable' }, coverage: { state: 'unknown' } })
        expect(video.metrics[key][period]!.value, `${period}:${key}`).toBe(meta.metrics[key][period]!.value)
      }
    }
    for (const key of ['bookings', 'bookings_click', 'bookings_view', 'purchase_count', 'purchase_value', 'appointment_value']) {
      expect(image.metrics[key].previous).toMatchObject({ value: 0, availability: { state: 'available' }, coverage: { state: 'complete' } })
    }
    expect(image.metrics.cost_per_booking.previous).toMatchObject({ value: null, availability: { state: 'unavailable' } })
  })

  it('keeps the GA4 comparison rate consistent with its native comparison counts', () => {
    const metrics = reportingFixture().website.data!.metrics
    for (const period of ['current', 'previous'] as const) {
      const sessions = Number(metrics.sessions[period]!.value)
      const engaged = Number(metrics.engaged_sessions[period]!.value)
      expect(metrics.engagement_rate[period]!.value).toBe(engaged / sessions * 100)
    }
    expect(metrics.sessions.previous?.value).toBe(100)
    expect(metrics.engaged_sessions.previous?.value).toBe(50)
    expect(metrics.engagement_rate.previous?.value).toBe(50)
  })

  it('derives website summaries from the native named event inventory', () => {
    const website = reportingFixture().website.data!
    for (const [key, event, current, previous] of [
      ['intent_events', 'begin_checkout', 20, 10],
      ['lead_events', 'generate_lead', 4, 2],
      ['confirmation_events', 'appointment_confirmed', 6, 3],
    ] as const) {
      expect(website.metrics[key]).toMatchObject({ event, current: { value: current }, previous: { value: previous } })
      const names = event.split(' + ')
      const observed = website.events.filter(row => names.includes(row.name))
      expect(new Set(observed.map(row => row.name))).toEqual(new Set(names))
      expect(observed.reduce((sum, row) => sum + Number(row.metrics.event_count.current.value), 0)).toBe(current)
    }
    expect(website.events.some(row => row.name === 'booking_confirmation')).toBe(false)
  })

  it('preserves native GA4 field semantics and separate query population coverage', () => {
    const website = reportingFixture().website.data!
    expect(Object.keys(website.metrics).sort()).toEqual(['sessions', 'engaged_sessions', 'engagement_rate', 'users', 'page_views',
      'intent_events', 'lead_events', 'confirmation_events'].sort())
    expect(website.metrics.users.current.value).toBe(150)
    expect(website.metrics.page_views.current.value).toBe(300)
    expect(website.metrics.users.previous?.value).toBe(75)
    expect(website.metrics.page_views.previous?.value).toBe(150)
    for (const metric of Object.values(website.metrics)) {
      const event = metric.event !== null
      for (const period of ['current', 'previous'] as const) {
        const population = event ? period === 'current' ? 6 : 4 : 1
        expect(metric[period]).toMatchObject({ measurementKind: 'telemetry', attributionScope: 'ga4_session_classified',
          source: { system: 'ga4', role: 'measurement_qa', evidencePlane: 'ga4_telemetry' },
          coverage: { state: 'complete', numerator: population, denominator: population },
          window: { basis: 'closed_account_days' }, inputClaimIds: [] })
      }
    }
    for (const row of website.rows) for (const metric of Object.values(row.metrics)) {
      expect(metric.current.coverage).toEqual({ state: 'complete', numerator: 2, denominator: 2 })
    }
    for (const row of website.events) {
      expect(row.metrics.event_count.current.coverage).toEqual({ state: 'complete', numerator: 6, denominator: 6 })
      expect(row.metrics.event_count.previous?.coverage).toEqual(row.metrics.event_count.previous?.value === null
        ? { state: 'unknown', numerator: null, denominator: null }
        : { state: 'complete', numerator: 4, denominator: 4 })
    }
    expect(website.metadata).toMatchObject({ returnedRows: website.rows.length + website.events.length, totalRows: 8 })
  })

  it('keeps paid association an attributed lower bound for the actual fictional eligible population', () => {
    const data = reportingFixture()
    const metric = data.measurement!.data!.paidAssociation.linked_value_bearing_bookings
    for (const [period, linked, eligible] of [['current', 2, 5], ['previous', 1, 2]] as const) {
      expect(metric[period]).toMatchObject({ value: linked, measurementKind: 'associated_noncausal',
        attributionScope: 'meta_click_associated_noncausal', coverage: { state: 'partial', numerator: linked, denominator: eligible },
        source: { system: 'first_party_attribution', role: 'association_truth', evidencePlane: 'paid_association' },
        entity: { level: 'business', id: data.context.account.id }, window: { basis: 'booking_created_date_et' } })
      expect(metric[period]!.coverage.denominator).toBe(data.business.data!.metrics.value_bearing_bookings[period]!.value)
    }
    expect(metric.event).toBeNull()
    expect(metric.definition).toMatch(/lower bound/i)
  })

  it('uses complete CAPI confirmation populations and accepted lineage while excluding cancellation reporting', () => {
    const capi = reportingFixture().measurement!.data!.capi
    const expected = [
      ['eligible_website_confirmations', 6, 3, 8, 4], ['accepted_live_confirmations', 4, 2, 6, 3],
      ['origin_unknown_confirmations', 1, 0, 8, 4], ['legacy_stamp_unverified', 1, 0, 6, 3],
    ] as const
    expect(Object.keys(capi).sort()).toEqual(expected.map(([key]) => key).sort())
    for (const [key, current, previous, currentPopulation, previousPopulation] of expected) {
      expect(capi[key].event).toBeNull()
      for (const [period, value, population] of [['current', current, currentPopulation], ['previous', previous, previousPopulation]] as const) {
        expect(capi[key][period]).toMatchObject({ value, unit: 'count', measurementKind: 'measured', attributionScope: 'capi_event_delivery',
          source: { system: 'capi', role: 'delivery_transport', evidencePlane: 'capi_delivery' },
          coverage: { state: 'complete', numerator: population, denominator: population },
          window: { basis: 'booking_created_date_et' }, availability: { state: 'available' } })
      }
    }
  })

  it('uses integer native comparison counts for each Meta population', () => {
    const meta = reportingFixture().meta.data!
    expect(meta.entities.map(entity => entity.id)).toEqual(['campaign-1', 'set-1', 'ad-1', 'ad-2'])
    for (const map of [meta.metrics, ...meta.entities.map(entity => entity.metrics)]) {
      for (const metric of Object.values(map)) {
        for (const claim of [metric.current, metric.previous]) {
          if (claim?.unit === 'count' && claim.value !== null) expect(Number.isInteger(claim.value), claim.claimId).toBe(true)
        }
      }
      const image = map.spend.current.entity.id === 'ad-2'
      expect(map.bookings.previous?.value).toBe(image ? 0 : 1)
      expect(map.bookings_click.previous?.value).toBe(image ? 0 : 1)
      expect(map.bookings_view.previous?.value).toBe(0)
    }
  })

  it('preserves native definitions and derived input lineage without claiming a live retrieval', () => {
    const data = reportingFixture(), meta = data.meta.data!
    expect(fixturePacket('meta', data.context.range.from, data.context.range.to).notes).toContain('Sample-data preview: fictional metrics, not Example Studio results.')
    for (const map of [meta.metrics, ...meta.entities.map(entity => entity.metrics)]) {
      const id = map.spend.current.entity.id
      expect(map.video_plays.current).toMatchObject({ measurementKind: 'modelled', attributionScope: 'meta_platform_modelled' })
      expect(map.spend.current).toMatchObject({ measurementKind: 'measured', attributionScope: 'none' })
      for (const [key, inputs, value] of [
        ['retention_p50', ['watch_p50', 'video_plays'], id === 'ad-2' ? null : 20],
        ['outbound_ctr', ['outbound_clicks', 'impressions'], id === 'ad-1' ? 1 : id === 'ad-2' ? .75 : .9],
      ] as const) {
        for (const period of ['current', 'previous'] as const) {
          if (value === null) expect(map[key][period]?.value).toBeNull()
          else expect(map[key][period]?.value).toBeCloseTo(value)
          expect(map[key][period]).toMatchObject({ measurementKind: 'derived', attributionScope: 'meta_platform_modelled',
            inputClaimIds: inputs.map(input => map[input][period]!.claimId) })
        }
      }
      const native = buildMetaMetrics(data.context, null, null, map.spend.current.entity)
      for (const metric of Object.values(map)) {
        expect(metric.definition).toBe(native[metric.key].definition)
        for (const claim of [metric.current, metric.previous]) {
          expect(claim?.formula).toBe(metric.definition.slice(0, 500))
          expect(claim?.source.head).toBe(native[metric.key].current.source.head)
        }
      }
    }
  })

  it('recomputes efficiency when the selected fictional spend changes', () => {
    const metrics = reportingFixture('2026-09-01', '2026-09-04').meta.data!.metrics
    for (const [key, value] of Object.entries({ spend: 240, cost_per_booking: 80, appointment_roas: 1.25,
      purchase_roas: 200 / 240, cpm: 24, outbound_cpc: 240 / 90 })) {
      expect(metrics[key].current.value, key).toBeCloseTo(value)
    }
  })

  it('derives actual payment coverage, booking types and daily controls from fictional ledger rows', () => {
    const data = reportingFixture()
    const business = data.business.data!
    for (const [key, value] of Object.entries({ paid_bookings: 5, amount_paid: 500, active_appointments: 7,
      value_bearing_bookings: 5, booked_value: 500, unknown_payment_count: 0, payment_coverage: 100 })) {
      expect(business.metrics[key]?.current.value, key).toBe(value)
    }
    expect(JSON.stringify(business)).not.toMatch(/cancel|refund|customer returns/i)
    expect(business.metrics.amount_paid.current.coverage).toEqual({ state: 'complete', numerator: 7, denominator: 7 })
    expect(business.metrics.paid_bookings.previous?.value).toBe(2)
    expect(business.types).toHaveLength(1)
    expect(business.types[0]).toMatchObject({ name: 'Synthetic studio rental', category: 'rental' })
    expect(business.types[0].metrics.amount_paid.current.value).toBe(500)
    expect(business.types[0].metrics.amount_paid.previous?.value).toBe(250)
    expect(business.types[0].metrics.paid_bookings.previous?.value).toBe(2)
    expect(business.types[0].metrics.amount_paid.previous?.window).toMatchObject({ start: data.context.comparison.from, end: data.context.comparison.to })
    expect(business.series.map(point => point.metrics.amount_paid.current.value)).toEqual([500, 0, 0])
    expect(business.sourceDescription).toMatch(/synthetic/i)
    expect(deriveExpertReview(data).businessContext).toEqual({ status: 'not_loaded', versionId: null, approvalId: null })
  })

  it('retains current-only GA4 journeys and native event tuple comparisons without inventing missing prior values', () => {
    const website = reportingFixture().website.data!
    expect(website.rows.map(row => row.id)).toEqual([
      JSON.stringify(['/studio-rentals', 'desktop', 'Paid Social']), JSON.stringify(['/studio-rentals', 'mobile', 'Paid Social']),
    ])
    expect(website.events.map(event => [event.name, event.device, event.channel,
      event.metrics.event_count.current.value, event.metrics.event_count.previous?.value])).toEqual([
      ['appointment_confirmed', 'desktop', 'Paid Social', 4, 3], ['appointment_confirmed', 'mobile', 'Paid Social', 2, null],
      ['begin_checkout', 'desktop', 'Paid Social', 6, null], ['begin_checkout', 'mobile', 'Paid Social', 14, 10],
      ['generate_lead', 'desktop', 'Paid Social', 1, 1], ['generate_lead', 'mobile', 'Paid Social', 3, 1],
    ])
    const maps: ReportMetricMap[] = website.rows.map(row => row.metrics)
    expect(maps.every(map => Object.values(map).every(metric => metric.previous === null))).toBe(true)
    expect(website.metadata).toMatchObject({ returnedRows: 8, totalRows: 8 })
  })

  it('supports a useful native creative observation with valid report references', () => {
    const data = reportingFixture()
    const finding = attention(data)
    expect(finding.status).toBe('observed')
    expect(finding.observation.text).toContain('200 50% watches from 1,000 video starts (20%)')
    expect(finding.observation.text).toContain('1% outbound CTR')
    expect(finding.observation.text).toContain('20 seconds')
    expect(finding.observation.text).toContain('historical media duration is not established by this preview')
    expect(finding.observation.text).not.toContain('the 50% point is 10 seconds')
    expect(finding.exposure).toMatchObject({ value: 80, unit: 'money' })
    expect(() => verifyFindingReferences(data, finding)).not.toThrow()
    const review = deriveExpertReview(data)
    expect(review.input.rejectedSources).toEqual([])
    expect(review.findings.find(item => item.id === finding.id)?.status).toBe('observed')
  })

  it.each(['retention_p50', 'outbound_ctr'])('withdraws an inconsistent %s observation while retaining native counts', key => {
    const data = reportingFixture()
    expect(attention(data).status).toBe('observed')
    const changed = { ...data, meta: { ...data.meta, data: { ...data.meta.data!,
      entities: data.meta.data!.entities.map(entity => entity.id !== 'ad-1' ? entity : { ...entity,
        metrics: { ...entity.metrics, [key]: { ...entity.metrics[key], current: { ...entity.metrics[key].current, value: 99 } } } }),
    } } }
    expect(() => validateReportingPacket({ section: 'meta', context: changed.context, result: changed.meta, notes: [] })).not.toThrow()
    const finding = attention(changed)
    expect(finding.status).toBe('unavailable')
    expect(finding.observation.text).toContain('200 50% watches from 1,000 video starts')
    expect(finding.observation.text).toContain('60 outbound clicks')
    expect(finding.observation.text).not.toContain('99%')
    expect(finding.observation.evidence.some(ref => ref.metric.key === key)).toBe(false)
    expect(finding.nextInspection.question).toMatch(/arithmetic|rate|denominator/i)
  })
})
