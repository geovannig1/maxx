import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OverviewReading } from '@/components/reporting/OverviewReading'
import { OverviewResults } from '@/components/reporting/OverviewResults'
import { deriveExpertReview } from '@/lib/reporting/review'
import { overviewBusinessMovementReading, overviewMerMovementReading } from '@/lib/reporting/overview-interpretation'
import { overviewBusinessSummary } from '@/lib/reporting/overview-business-summary'
import type { ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { platformBooking, platformData, platformMeta } from './fixtures/reporting-business-platform'
import { referenceReportingFixture } from './reporting-browser/reference-fixture'

const unavailable = { state: 'unavailable' as const, data: null, asOf: null, notes: ['Missing source.'] }
const plain = (html: string) => html.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'")
const paragraphs = (html: string) => [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(match => plain(match[1]))
const opening = (html: string) => paragraphs(html.split('<details')[0]).slice(0, 2)
function reading(data: ReportingData, savedId?: string) {
  return renderToStaticMarkup(<OverviewReading data={data} review={deriveExpertReview(data)} savedId={savedId} />)
}
function change(data: ReportingData, source: 'business' | 'meta', key: string, edit: (metric: ReportMetric) => ReportMetric): ReportingData {
  const section = data[source]
  return { ...data, [source]: { ...section, data: { ...section.data!, metrics: {
    ...section.data!.metrics, [key]: edit(section.data!.metrics[key]),
  } } } }
}
function scenario(value: number, count: number, priorValue: number, priorCount: number, spend = 100, priorSpend = 100) {
  return platformData(Array.from({ length: count }, (_, id) => ({ ...platformBooking(id, value / count, value / count), appointment_duration: '120' })),
    Array.from({ length: priorCount }, (_, id) => ({ ...platformBooking(100 + id, priorValue / priorCount, priorValue / priorCount), appointment_duration: '120' })),
    platformMeta(spend), platformMeta(priorSpend))
}

describe('bounded executive comparisons', () => {
  it('keeps scale, flat MER and concentration together, with the opposing unit relationships in the second visible field', () => {
    const html = reading(referenceReportingFixture()), fields = opening(html)
    expect(fields).toHaveLength(2)
    expect(fields[0]).toMatch(/Meta spend doubled while all-source MER held at 4\.17×; Sep 2 supplied 86% of booked value/)
    expect(fields[1]).toMatch(/Average booking value fell 20% to \$100, while booked value per recorded hour rose 33% to \$55\.56/)
    const why = plain(html.slice(html.indexOf('<details')))
    expect(why).toContain('3.0 → 1.8 hours (−40%)')
    expect(why).toContain('$30.00 → $24.00 (−20%)')
    expect(why).toContain('not Meta-attributed revenue')
  })

  it('does not label a doubled MER as good when booked value halves', () => {
    const input = scenario(500, 2, 1000, 2, 25, 100)
    const text = opening(reading(input)).join(' ')
    expect(text).toContain('MER rose from 10.00× to 20.00×')
    expect(text).toContain('Average booking value fell 50%')
    expect(text).not.toMatch(/improved|good|better|efficient|profit|scale/i)
    expect(plain(reading(input))).toMatch(/booked value fell 50%/i)
  })

  it.each([
    [500, 2, 250, 2, 'rose 100% to $250'],
    [500, 4, 500, 2, 'fell 50% to $125'],
  ])('reads one changed business input (%s / %s versus %s / %s)', (value, count, priorValue, priorCount, expected) => {
    const movement = overviewBusinessMovementReading(scenario(Number(value), Number(count), Number(priorValue), Number(priorCount)))
    expect(movement?.observation).toContain(expected)
  })

  it('describes supported stable ratios without claiming missing evidence or scale change', () => {
    const text = opening(reading(scenario(500, 2, 500, 2))).join(' ')
    expect(text).toContain('MER held at 5.00×')
    expect(text).toContain('Average booking value held at $250')
    expect(text).not.toMatch(/cannot support|does not support|unavailable|doubled|Meta spend rose|Meta spend fell/)
  })

  it('distinguishes a display tie from a numerically equal MER', () => {
    const data = scenario(500.04, 2, 500, 2, 120, 120)
    const text = overviewMerMovementReading(data)?.observation
    expect(text).toContain('4.17× at displayed precision')
    expect(text).not.toMatch(/held|unchanged/i)
    expect(plain(reading(data).split('<details')[0])).toContain('4.17× at displayed precision')
  })

  it('treats floating-point noise as numerically stable', () => {
    const data = scenario(0.1 + 0.2, 1, 0.3, 1, 0.1, 0.1)
    const text = overviewMerMovementReading(data)?.observation
    expect(text).toContain('held at 3.00×')
    expect(text).not.toMatch(/rose|fell|at displayed precision/)
  })

  it('keeps a changed value per hour visible when value per booking is stable', () => {
    const data = platformData([1, 2].map(id => ({ ...platformBooking(id, 250, 250), appointment_duration: '60' })),
      [3, 4].map(id => ({ ...platformBooking(id, 250, 250), appointment_duration: '120' })), platformMeta(100), platformMeta(100))
    const text = overviewBusinessMovementReading(data)?.observation
    expect(text).toContain('Average booking value held at $250.00')
    expect(text).toContain('booked value per recorded hour rose 100% to $250.00')
  })

  it('retains a valid AOV comparison when duration coverage is incomplete', () => {
    const data = platformData(Array.from({ length: 5 }, (_, id) => ({ ...platformBooking(id, 100, 100),
      appointment_duration: id ? '120' : null })),
    Array.from({ length: 2 }, (_, id) => ({ ...platformBooking(id + 100, 125, 125), appointment_duration: '180' })),
    platformMeta(120), platformMeta(60))
    const text = overviewBusinessMovementReading(data)?.observation
    expect(text).toContain('Average booking value fell 20% to $100.00')
    expect(text).not.toContain('per recorded hour')
    expect(opening(reading(data))[1]).toContain('Average booking value fell 20%')
  })

  it('keeps valid business comparisons when Meta independently fails', () => {
    const data = { ...referenceReportingFixture(), meta: unavailable }
    const text = opening(reading(data)).join(' ')
    expect(text).toContain('Average booking value fell 20%')
    expect(text).toContain('per recorded hour rose 33%')
    expect(text).not.toContain('MER held')
  })

  it.each(['source', 'cohort', 'head', 'prior_head'] as const)('excludes incompatible %s from business unit comparisons', defect => {
    const data = change(referenceReportingFixture(), 'business', 'value_bearing_bookings', metric => ({ ...metric,
      current: { ...metric.current,
        source: { ...metric.current.source, system: defect === 'source' ? 'meta' : metric.current.source.system,
          head: defect === 'head' ? 'other' : metric.current.source.head },
        window: { ...metric.current.window, basis: defect === 'cohort' ? 'service_date_et' : metric.current.window.basis },
      },
      previous: defect === 'prior_head' ? { ...metric.previous!, source: { ...metric.previous!.source, head: 'other' } } : metric.previous,
    }))
    expect(overviewBusinessMovementReading(data)?.observation ?? '').not.toMatch(/Average booking value|per recorded hour/)
  })

  it('keeps saved wording frozen even with a newly supported unit contrast', () => {
    const data = referenceReportingFixture(), review = deriveExpertReview(data)
    const text = 'Saved observation 4.17×. Original qualifier remains available.'
    const frozen = { ...review, findings: review.findings.map(item => item.id === 'business_platform_trend'
      ? { ...item, observation: { ...item.observation, text } } : item) }
    const html = renderToStaticMarkup(<OverviewReading data={data} review={frozen} savedId="frozen" />)
    expect(plain(html)).toContain(text)
    expect(plain(html)).not.toContain('Average booking value fell 20%')
    expect(opening(html)[0]).toBe('Saved observation 4.17×.')
  })
})

describe('visible ratio basis and comparisons', () => {
  it('shows the prior spend per booking and change in its existing tile', () => {
    const html = renderToStaticMarkup(<OverviewResults data={referenceReportingFixture()} selected="appointment_confirmed" />)
    const tile = html.match(/aria-label="Blended business context"[\s\S]*?<\/dl>/)?.[0] ?? ''
    expect(plain(tile)).toContain('Prior $30.00 · −20%')
  })

  it('labels a flat MER comparison in both existing locations', () => {
    const data = referenceReportingFixture()
    const primary = reading(data).split('<details')[0]
    const fallback = renderToStaticMarkup(<OverviewResults data={data} selected="appointment_confirmed" showMerFallback />)
      .match(/aria-label="All-source booked value ÷ Meta spend:[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(plain(primary)).toContain('Prior 4.17× · Unchanged')
    expect(plain(fallback)).toContain('Prior 4.17× · Unchanged')
  })

  it('uses neutral unavailable MER text in the primary and fallback locations', () => {
    const data = { ...referenceReportingFixture(), meta: unavailable }
    for (const html of [reading(data), renderToStaticMarkup(<OverviewResults data={data} selected="appointment_confirmed" showMerFallback />)]) {
      const value = html.match(/<(?:span|p)[^>]*class="[^"]*"[^>]*>Unavailable<\/(?:span|p)>/)?.[0] ?? ''
      expect(value).toContain('text-[var(--text-secondary)]')
      expect(value).not.toContain('text-[var(--chart-2)]')
    }
  })

  it.each([
    ['meta', 'spend', /Meta spend.*MER.*comparison/i],
    ['business', 'booked_value', /Business booked value.*MER.*comparison/i],
    ['business', 'paid_bookings', /Business paid bookings.*spend per booking.*comparison/i],
  ] as const)('names the invalid %s %s and the blocked comparison', (source, key, expected) => {
    const data = change(referenceReportingFixture(), source, key, metric => ({ ...metric,
      current: { ...metric.current, availability: { state: 'unavailable', blockerCodes: ['missing'] }, value: null },
    }))
    const summary = overviewBusinessSummary(data)
    expect(key === 'paid_bookings' ? summary.spendPerBooking.reason : summary.mer.reason).toMatch(expected)
  })

  it('names zero denominators without replacing valid zero ratios', () => {
    const data = change(referenceReportingFixture(), 'meta', 'spend', metric => ({ ...metric, current: { ...metric.current, value: 0 } }))
    expect(overviewBusinessSummary(data).mer.reason).toMatch(/Meta spend is zero.*MER.*comparison/i)
    expect(overviewBusinessSummary(data).spendPerBooking.value).toBe(0)
  })

  it('retains account ratios when creative detail or a refresh fails with valid retained account data', () => {
    const original = scenario(500, 5, 250, 2, 120, 60)
    const data = { ...original, meta: { ...original.meta, state: 'partial' as const, notes: ['Refresh failed; retained account data.'],
      data: { ...original.meta.data!, detailState: 'unavailable' as const, entities: [], observations: [] } } }
    const summary = overviewBusinessSummary(data)
    expect(summary.mer.value).toBeCloseTo(4.1666667)
    expect(summary.mer.reason).toBeNull()
    expect(opening(reading(data))[0]).toContain('MER held at 4.17×')
  })

  it('shows undefined cost per result as no results only for a validated selected zero count', () => {
    const data = platformData(undefined, undefined, platformMeta(100, 0, 0, 2, 300))
    const html = renderToStaticMarkup(<OverviewResults data={data} selected="appointment_confirmed" />)
    expect(html).toContain('Cost / result: — · No results')
    expect(html).toContain('Reported ROAS: 0.00×')
    const purchase = renderToStaticMarkup(<OverviewResults data={data} selected="purchase" />)
    expect(purchase).toContain('Cost / result: $50.00')
    expect(purchase).not.toContain('No results')
    const wrong = change(data, 'meta', 'bookings', metric => ({ ...metric,
      current: { ...metric.current, coverage: { state: 'partial', numerator: 1, denominator: 2 } },
    }))
    expect(renderToStaticMarkup(<OverviewResults data={wrong} selected="appointment_confirmed" />)).not.toContain('No results')
    const withheld = change(data, 'meta', 'cost_per_booking', metric => ({ ...metric,
      current: { ...metric.current, availability: { state: 'unavailable', blockerCodes: ['meta_outcome_hierarchy_unreconciled'] } },
    }))
    expect(renderToStaticMarkup(<OverviewResults data={withheld} selected="appointment_confirmed" />)).not.toContain('No results')
  })

  it('does not crowd out an existing consequential finding with two stable ratio statements', () => {
    const data = scenario(500, 2, 500, 2), review = deriveExpertReview(data)
    const original = review.findings.find(item => item.id === 'business_platform_trend')!
    const exception = { ...original, id: 'creative.zero', area: 'creative' as const, priority: 'investigate' as const,
      direction: 'declined' as const, observation: { ...original.observation, text: 'Creative 7 spent $500 with 0 AppointmentConfirmed events.' } }
    const html = renderToStaticMarkup(<OverviewReading data={data} review={{ ...review, findings: [original, exception] }} />)
    expect(opening(html).join(' ')).toContain('Creative 7 spent $500 with 0 AppointmentConfirmed events.')
    expect(plain(html.slice(html.indexOf('<details')))).toContain('Average booking value held at $250.00')
  })
})
