import { creativeReportingFixture, type CreativeMediaMode } from './creative-fixture'
import { buildBusinessReport } from '../../src/lib/reporting/business-metrics'
import { buildBusinessCustomers, buildBusinessLeadTime, buildBusinessUpcoming, type BusinessIntelligenceRow } from '../../src/lib/reporting/business-intelligence-metrics'
import { buildMetaMetrics } from '../../src/lib/reporting/meta-metrics'
import { buildMetaSeries, previousContext, dayOffset } from '../../src/lib/reporting/meta-breakdowns'
import { describeCreativeIdentity } from '../../src/lib/reporting/creative-identity'
import type { ReportEntity, ReportMetricMap } from '../../src/lib/reporting/contracts'

function rebindMetrics(metrics: ReportMetricMap, level: ReportEntity['level'], id: string): ReportMetricMap {
  const entity = { level, id }
  const claims = Object.values(metrics).flatMap(metric => [metric.current, ...(metric.previous ? [metric.previous] : [])])
  const claimIds = new Map(claims.map(claim => [claim.claimId,
    `report:meta:${level}:${id}:${claim.metricKey.slice('meta.'.length)}:${claim.window.start}:${claim.window.end}`]))
  const rebind = (claim: typeof claims[number]) => ({ ...claim, entity, claimId: claimIds.get(claim.claimId)!,
    inputClaimIds: claim.inputClaimIds.map(input => claimIds.get(input) ?? input),
  })
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, { ...metric,
    current: rebind(metric.current), previous: metric.previous ? rebind(metric.previous) : null,
  }]))
}

/** Fictional native-shaped evidence: flat MER, concentrated bookings, complete payment and mixed ad results. */
export function referenceReportingFixture(from = '2026-09-02', to = '2026-09-04', origin?: string | null,
  mode: CreativeMediaMode = 'ok', detailIds: readonly string[] = []) {
  const base = creativeReportingFixture(from, to, origin, mode, detailIds), context = base.context
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  const row = (id: number, date: string, price: number, duration: number, customer: string, service: string): BusinessIntelligenceRow => ({
    id, booking_date_et: date, price, amount_paid: price, canceled: false, appointment_duration: String(duration),
    appointment_type: service, email: `${customer}@example.test`, datetime_created: `${date}T12:00:00Z`,
    datetime: `${dayOffset(date, 7)}T12:00:00Z`,
  })
  const current = [
    row(1, from, 210, 180, 'repeat', 'Studio rental — full production'),
    row(2, from, 150, 120, 'second', 'Studio rental — full production'),
    row(3, from, 70, 90, 'third', 'Studio rental — hourly'),
    row(4, dayOffset(from, Math.min(1, days - 1)), 40, 60, 'fourth', 'Studio rental — hourly'),
    row(5, to, 30, 90, 'repeat', 'Studio rental — hourly'),
  ]
  const previous = [row(101, context.comparison.from, 125, 180, 'prior', 'Studio rental — hourly'),
    row(102, context.comparison.to, 125, 180, 'prior-other', 'Studio rental — hourly')]
  const history = [row(1001, dayOffset(from, -90), 100, 120, 'repeat', 'Studio rental — hourly'), ...previous, ...current]
  const future = [{ ...row(2001, dayOffset(from, -2), 180, 180, 'future', 'Studio rental — full production'),
    datetime: `${dayOffset(to, 7)}T12:00:00Z` }]
  const retained = [...history, ...future]
  const business = { state: 'available' as const, asOf: context.asOf, notes: [], data: {
    ...buildBusinessReport(context, current, previous), intelligence: {
      customers: buildBusinessCustomers(context, retained), leadTime: buildBusinessLeadTime(context, retained),
      upcoming: buildBusinessUpcoming(context, retained, context.asOf),
    },
  } }
  const totalSpend = base.meta.data!.metrics.spend.current.value as number
  const daily = (prior: boolean) => Array.from({ length: days }, (_, i) => ({
    date_start: dayOffset((prior ? context.comparison : context.range).from, i),
    date_stop: dayOffset((prior ? context.comparison : context.range).from, i),
    spend: String(days === 3 ? (prior ? [20, 25, 15] : [50, 40, 30])[i] * totalSpend / 120 : totalSpend / (prior ? 2 : 1) / days),
  }))
  const nativeDelivery = buildMetaMetrics(context, { spend: String(totalSpend), impressions: '19100', reach: '9000', frequency: String(19100 / 9000) },
    { spend: String(totalSpend / 2), impressions: '9550', reach: '4500', frequency: String(9550 / 4500) })
  const meta = { ...base.meta, data: { ...base.meta.data!,
    metrics: { ...base.meta.data!.metrics, ...Object.fromEntries(['reach', 'frequency', 'cpm'].map(key => [key, nativeDelivery[key]])) },
    series: buildMetaSeries(context, daily(false), daily(true)),
    comparisonSeries: buildMetaSeries(previousContext(context), daily(true), null),
  } }
  const campaigns = meta.data.entities.filter(entity => entity.level === 'campaign')
  const ads = meta.data.entities.filter(entity => entity.level === 'ad').map((entity, index) => index === 0 && entity.creative
    ? { ...entity, creative: { ...entity.creative, identity: describeCreativeIdentity({ asset_feed_spec: {
      videos: [{ video_id: 'reference_video_primary' }, { video_id: 'reference_video_variant' }],
      images: [{ hash: 'reference_image_variant' }],
    } }, context.asOf) } }
    : entity)
  const adsets = Array.from({ length: 13 }, (_, index): ReportEntity => {
    const source = ads[index % ads.length]
    const id = `reference-set-${String(index + 1).padStart(2, '0')}`
    return { ...source, id, level: 'adset', adsetId: id,
      name: index === 12 ? 'Springfield production decision-makers and recent studio visitors · long-name control' : `Synthetic studio audience ${index + 1}`,
      creative: null, metrics: rebindMetrics(source.metrics, 'adset', id), series: [], comparisonSeries: [], breakdowns: [],
    }
  })
  return { ...base, business, meta: { ...meta, data: { ...meta.data, entities: [...campaigns, ...adsets, ...ads],
    sourceDescription: `${meta.data.sourceDescription} Includes 13 fictional ad-set rows for dashboard density acceptance.`,
  } } }
}
