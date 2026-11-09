import './_support/outcome-noun-booking'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OverviewResults } from '@/components/reporting/OverviewResults'
import { OverviewReading } from '@/components/reporting/OverviewReading'
import { deriveExpertReview } from '@/lib/reporting/review'
import { makeReportMetric, COMPLETE_FIELD_COVERAGE } from '@/lib/reporting/claims'
import type { ReportMetric, ReportingData } from '@/lib/reporting/contracts'
import { platformBooking, platformData, platformMeta } from './fixtures/reporting-business-platform'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'

function data(): ReportingData {
  return platformData([platformBooking(1, 700, 700), platformBooking(2, 200, 200), platformBooking(3, 100, 100)],
    [platformBooking(4, 1000, 1000)], platformMeta(200), platformMeta(100))
}
function change(input: ReportingData, source: 'business' | 'meta', key: string, edit: (metric: ReportMetric) => ReportMetric): ReportingData {
  const section = input[source]
  return { ...input, [source]: { ...section, data: { ...section.data!, metrics: {
    ...section.data!.metrics, [key]: edit(section.data!.metrics[key]),
  } } } }
}
const results = (input: ReportingData) => renderToStaticMarkup(<OverviewResults data={input} selected="appointment_confirmed" />)
const blended = (html: string) => html.match(/<div[^>]*aria-label="Blended business context"[\s\S]*?<\/dl>/)?.[0] ?? ''
const plain = (html: string) => html.replace(/<[^>]*>/g, '')

describe('overview business and blended context', () => {
  it('retains booking value, count and hours while recording payment once in supporting detail', () => {
    const html = results(data())
    expect(html).not.toMatch(/deposits|full-payment split/i)
    expect(html).toContain('Booked value: $1,000.00')
    expect(html).toContain('Bookings with recorded payment: 3')
    expect(html).toContain('Recorded booked hours')
    expect(html).toContain('Recorded amount paid')
    expect(blended(html)).not.toContain('MER')
    expect(blended(html)).toContain('Ad spend per booking')
    expect(blended(html)).toContain('$66.67')
    expect(blended(html)).not.toContain('CAC')
    expect(reading(data())).toContain('aria-label="All-source booked value ÷ Meta spend: 5.00×"')
  })
  it('accepts independent source clocks and retains qualified stale values', () => {
    const input = change(data(), 'meta', 'spend', metric => ({ ...metric, current: { ...metric.current,
      freshness: { ...metric.current.freshness, state: 'stale' },
    } }))
    expect(input.business.asOf).not.toBe(input.meta.asOf)
    const html = blended(results(input))
    expect(reading(input)).toContain('aria-label="All-source booked value ÷ Meta spend: 5.00×"')
    expect(html).toContain('Stale')
  })
  it.each(['account', 'currency', 'window', 'cohort', 'event', 'coverage', 'partial', 'unavailable', 'negative', 'clock', 'source', 'nonfinite'] as const)
    ('withholds blended dollars for invalid %s while keeping independent business results', mismatch => {
      const input = change(data(), 'meta', 'spend', metric => ({ ...metric,
        event: mismatch === 'event' ? 'Purchase' : metric.event, current: { ...metric.current,
          entity: mismatch === 'account' ? { level: 'account', id: 'other' } : metric.current.entity,
          unit: mismatch === 'currency' ? 'count' : metric.current.unit,
          window: { ...metric.current.window, start: mismatch === 'window' ? '2026-09-01' : metric.current.window.start,
            basis: mismatch === 'cohort' ? 'service_date_et' : metric.current.window.basis },
          coverage: mismatch === 'coverage' ? { state: 'partial', numerator: 1, denominator: 2 } : metric.current.coverage,
          maturity: mismatch === 'partial' ? { state: 'partial', matureThrough: null } : metric.current.maturity,
          availability: mismatch === 'unavailable' ? { state: 'unavailable', blockerCodes: ['missing'] } : metric.current.availability,
          value: mismatch === 'negative' ? -200 : mismatch === 'nonfinite' ? Infinity : metric.current.value,
          asOf: mismatch === 'clock' ? '2026-09-21T16:55:00.000Z' : metric.current.asOf,
          source: mismatch === 'source' ? { ...metric.current.source, role: 'business_truth' } : metric.current.source,
        },
      }))
      const html = results(input)
      expect(blended(html)).toContain('Unavailable')
      expect(blended(html)).not.toContain('5.00×')
      expect(html).toContain('Booked value: $1,000.00')
    })
  it('keeps zero ratios observable but zero denominators undefined', () => {
    const noSpend = change(data(), 'meta', 'spend', metric => ({ ...metric, current: { ...metric.current, value: 0 } }))
    expect(reading(noSpend)).toContain('aria-label="All-source booked value ÷ Meta spend: Unavailable"')
    expect(blended(results(noSpend))).toContain('Ad spend per booking: $0.00')
    const noValue = change(data(), 'business', 'booked_value', metric => ({ ...metric, current: { ...metric.current, value: 0 } }))
    expect(reading(noValue)).toContain('aria-label="All-source booked value ÷ Meta spend: 0.00×"')
    const noBookings = change(data(), 'business', 'paid_bookings', metric => ({ ...metric, current: { ...metric.current, value: 0 } }))
    expect(reading(noBookings)).toContain('aria-label="All-source booked value ÷ Meta spend: 5.00×"')
    expect(blended(results(noBookings))).toContain('Ad spend per booking: Unavailable')
  })
})

describe('overview executive business read', () => {
  it('decides when fewer paid bookings produce greater value and booked hours', () => {
    const current = [
      { ...platformBooking(11, 800, 800), appointment_duration: '300' },
      { ...platformBooking(12, 600, 600), appointment_duration: '300' },
    ]
    const prior = [
      { ...platformBooking(21, 300, 300), appointment_duration: '120' },
      { ...platformBooking(22, 300, 300), appointment_duration: '120' },
      { ...platformBooking(23, 300, 300), appointment_duration: '120' },
    ]
    const input = platformData(current, prior, platformMeta(200), platformMeta(100))
    const html = reading(input)
    const opening = html.split('<details')[0]

    expect(plain(opening)).toContain('Average booking value rose 133% to $700')
    expect(plain(opening)).toContain('booked value per recorded hour fell 7% to $140')
    expect(plain(html)).toContain('eligible bookings 3 → 2')
    expect(plain(html)).toContain('All-source booked value rose 56%')
    expect(plain(html)).toContain('Recorded hours rose 67%')
    expect(opening).not.toContain('alongside $200')
    expect(html).toContain('aria-label="All-source booked value ÷ Meta spend: 7.00×"')
  })
})

function dailyData(values = [700, 200, 100], counts = [1, 1, 1], spend = [50, 50, 100]): ReportingData {
  const base = data(), shift = (offset: number) => new Date(Date.parse('2026-09-02T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10)
  const dates = values.map((_, index) => shift(index))
  const context = { ...base.context, range: { from: dates[0], to: dates.at(-1)! }, comparison: { from: shift(-values.length), to: shift(-1) } }
  const rows = values.flatMap((value, index) => Array.from({ length: counts[index] }, (_, n) => ({
    ...platformBooking(index * 100 + n, value / counts[index], value / counts[index]), booking_date_et: dates[index],
  })))
  const input = { ...base, context, business: { ...base.business, data: buildBusinessReport(context, rows,
    [{ ...platformBooking(999, values.reduce((total, value) => total + value, 0), 1000), booking_date_et: context.comparison.from }]) },
  meta: { ...base.meta, data: { ...base.meta.data!, metrics: buildMetaMetrics({ ...context, asOf: base.meta.asOf! },
    platformMeta(spend.reduce((total, value) => total + value, 0)), platformMeta(100)) } } }
  function day(source: 'business' | 'meta', date: string, key: string, value: number) {
    const context = { ...input.context, range: { from: date, to: date }, asOf: input[source].asOf! }
    return makeReportMetric({ context, key, label: key, definition: `Native daily ${key}`, current: value,
      source: source === 'business' ? 'outcomes' : 'meta', unit: key === 'paid_bookings' ? 'count' : 'money',
      sourceHead: input[source].data!.metrics[key].current.source.head, coverage: COMPLETE_FIELD_COVERAGE,
      basis: source === 'business' ? 'booking_created_date_et' : 'impression_date_et',
      entity: { level: source === 'business' ? 'business' : 'account', id: source === 'business' ? `${context.account.id}:day:${date}` : context.account.id },
      freshness: { state: 'fresh', observedAt: context.asOf, maxAgeHours: 24 },
    })
  }
  return { ...input, business: { ...input.business, data: { ...input.business.data!, series: dates.map((date, i) => ({ date,
    metrics: { booked_value: day('business', date, 'booked_value', values[i]), paid_bookings: day('business', date, 'paid_bookings', counts[i]) },
  })) } }, meta: { ...input.meta, data: { ...input.meta.data!, series: dates.map((date, i) => ({ date,
    metrics: { spend: day('meta', date, 'spend', spend[i]) },
  })) } } }
}
function reading(input: ReportingData, savedId?: string) {
  const review = deriveExpertReview({ ...input, business: { ...input.business, data: { ...input.business.data!, series: [], comparisonSeries: [] } },
    meta: { ...input.meta, data: { ...input.meta.data!, series: [], comparisonSeries: [] } } })
  return renderToStaticMarkup(<OverviewReading {...{ review, data: input, savedId }} />)
}
describe('overview material daily interpretation', () => {
  it('names the date, amount and sample hidden by an unchanged period total', () => {
    const html = reading(dailyData())
    expect(html).toContain('2026-09-02')
    expect(html).toContain('$700.00')
    expect(html).toContain('70%')
    expect(html).toContain('1 of 3 paid bookings')
    expect(html).toContain('#overview-trends')
    expect(html).not.toMatch(/scale|cut spend|forecast|deterioration|40%/i)
  })
  it('keeps saved assessments frozen even when a new daily contrast could be derived', () => {
    const html = reading(dailyData(), 'saved-1')
    expect(html).not.toContain('70%')
    expect(html).toContain('saved=saved-1')
  })
  it('shows opposing within-period movement even when no single day dominates', () => {
    const html = reading(dailyData([350, 350, 150, 150], [2, 2, 1, 1], [25, 25, 75, 75]))
    expect(html).toContain('2026-09-02 – 2026-09-03')
    expect(html).toContain('2026-09-04 – 2026-09-05')
    expect(html).toContain('$350.00 to $150.00 per day')
    expect(html).toContain('$25.00 to $75.00 per day')
    expect(html).toContain('4 to 2 paid bookings')
    expect(html).not.toMatch(/fatigue|scale|cut spend|deterioration|forecast/i)
  })
  it.each([1, 2])('does not diagnose concentration from a %s-day period', days => {
    const html = reading(dailyData(Array.from({ length: days }, (_, i) => i ? 0 : 1000),
      Array.from({ length: days }, (_, i) => i ? 0 : 1), Array.from({ length: days }, () => 100)))
    expect(html).not.toContain('supplied $1,000.00 of')
    expect(html).not.toMatch(/deterioration|concentration warning|fatigue/i)
  })
  it('does not diagnose sparse bookings as deterioration across a longer range', () => {
    const html = reading(dailyData([1000, 0, 0, 0], [1, 0, 0, 0], [50, 50, 50, 50]))
    expect(html).not.toContain('supplied $1,000.00 of')
    expect(html).not.toMatch(/deterioration|concentration warning|fatigue/i)
  })
  it('uses actual window lengths for unequal halves and declines causal attribution', () => {
    const html = reading(dailyData([200, 200, 100, 100, 100], [1, 1, 1, 1, 1], [10, 10, 20, 20, 20]))
    expect(html).toContain('$200.00 to $100.00 per day')
    expect(html).toContain('$10.00 to $20.00 per day')
    expect(html).toContain('2 to 3 paid bookings')
    expect(html).toContain('do not establish attribution')
  })
  it('keeps stale period evidence qualified when the daily pattern is still available', () => {
    const input = change(dailyData(), 'business', 'booked_value', metric => ({ ...metric, current: { ...metric.current,
      freshness: { ...metric.current.freshness, state: 'stale' },
    } }))
    const html = reading(input)
    expect(html).toContain('$700.00')
    expect(html).toContain('Stale source evidence')
  })
  it('retains business concentration without using Meta evidence rejected by the prepared review', () => {
    const input = dailyData(), review = deriveExpertReview(data())
    const html = renderToStaticMarkup(<OverviewReading data={input} review={{ ...review,
      input: { ...review.input, rejectedSources: ['meta'] } }} />)
    expect(html).toContain('$700.00')
    expect(html).not.toContain('$150.00 in Meta spend')
    expect(html).toContain('Meta daily spend is unavailable')
  })
  it('does not replace a useful lower-level exception with a generic source relationship', () => {
    const review = deriveExpertReview(data()), original = review.findings.find(item => item.id === 'business_platform_trend')!
    const exception = { ...original, id: 'creative.test', area: 'creative' as const, priority: 'investigate' as const,
      direction: 'declined' as const, observation: { text: 'Creative 7 spent $500 with 0 AppointmentConfirmed events.', evidence: original.observation.evidence },
      nextInspection: { ...original.nextInspection, href: '/creative?ad=ad-7' } }
    const html = renderToStaticMarkup(<OverviewReading review={{ ...review, findings: [original, exception] }} />)
    expect(html).toContain('Creative 7 spent $500 with 0 AppointmentConfirmed events.')
    expect(html).toContain('ad=ad-7')
  })
  it.each(['missing', 'duplicate', 'wrong_day', 'wrong_count', 'wrong_total', 'account', 'head', 'clock', 'partial'] as const)
    ('withholds concentration when %s invalidates complete comparable daily inputs', mismatch => {
      const input = dailyData(), original = input.business.data!.series
      const metric = original[0].metrics.booked_value
      const altered = { ...original[0], metrics: { ...original[0].metrics,
        booked_value: { ...metric, current: { ...metric.current,
          value: mismatch === 'wrong_total' ? 900 : metric.current.value,
          entity: mismatch === 'account' ? { level: 'business' as const, id: 'other' } : metric.current.entity,
          window: mismatch === 'wrong_day' ? { ...metric.current.window, end: '2026-09-03' } : metric.current.window,
          source: mismatch === 'head' ? { ...metric.current.source, head: 'other' } : metric.current.source,
          asOf: mismatch === 'clock' ? '2026-09-20T16:00:00Z' : metric.current.asOf,
          coverage: mismatch === 'partial' ? { state: 'partial' as const, numerator: 1, denominator: 2 } : metric.current.coverage,
        } },
        paid_bookings: mismatch === 'wrong_count' ? { ...original[0].metrics.paid_bookings,
          current: { ...original[0].metrics.paid_bookings.current, value: 10 } } : original[0].metrics.paid_bookings,
      } }
      const points = mismatch === 'missing' ? original.slice(1) : mismatch === 'duplicate' ? [...original, original[0]]
        : [altered, ...original.slice(1)]
      expect(reading({ ...input, business: { ...input.business, data: { ...input.business.data!, series: points } } })).not.toContain('70%')
    })
})
