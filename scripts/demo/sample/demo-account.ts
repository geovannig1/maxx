// The demo's reporting data: the fictional Example Studio account, its Meta delivery
// (./demo-delivery.ts), its outcomes, GA4 and tracking evidence, run through the real reporting
// builders. The demo is anchored to the day it starts: the default range is the 28 days ending
// yesterday in the account timezone, so the database pages (which read "the last N days") and the
// reports show the same period. Figures depend only on a day's distance from that anchor.
import { buildBusinessReport, type BusinessLedgerRow } from '../../../src/lib/reporting/business-metrics'
import { buildMetaMetrics } from '../../../src/lib/reporting/meta-metrics'
import { buildMetaSeries } from '../../../src/lib/reporting/meta-breakdowns'
import { aggregateConfirmationFacts } from '../../../src/lib/outcomes/confirmation-facts'
import { previousReportingRange } from '../../../src/lib/reporting/range'
import type { ReportEntity, ReportingContext, ReportingData, ReportingPacket, ReportingRange } from '../../../src/lib/reporting/contracts'
import {
  DEMO_ADS, DEMO_ADSETS, DEMO_CAMPAIGNS, addDays, dayOffset, datesOf, deliveryFor, draw, graphRow, sumTotals, type DayTotals,
} from './demo-delivery'
import { nativeWebsite, sampleMeasurement } from './reports'

export const DEMO_TIMEZONE = 'America/New_York'
export const DEMO_ACCOUNT = { id: '00000000-0000-4000-8000-00000000d001', metaAccountId: 'act_1000000000', name: 'Example Studio (sample)' }
const DEFAULT_DAYS = 28

export interface DemoCalendar {
  /** The account day the demo started on; yesterday is the last complete day. */
  today: string
  /** Evidence cutoff: the start of `today` in the account timezone, so every shown day is complete. */
  asOf: string
  /** The default report range: 28 complete days ending yesterday. */
  range: ReportingRange
}

export function demoCalendar(now: Date = new Date()): DemoCalendar {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: DEMO_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  const to = addDays(today, -1)
  // 13:00Z is 08:00 or 09:00 in New York: after the day's sync, before the day ends.
  return { today, asOf: `${today}T13:00:00Z`, range: { from: addDays(to, 1 - DEFAULT_DAYS), to } }
}

// Cumulative share of outcomes per service: most clients book two hours, few book a full day.
const STUDIO_TYPES = [
  { name: 'Studio rental · 2 hours', price: 180, hours: 2, upTo: 0.45 }, { name: 'Studio rental · half day', price: 340, hours: 4, upTo: 0.75 },
  { name: 'Product shoot package', price: 450, hours: 5, upTo: 0.92 }, { name: 'Studio rental · full day', price: 620, hours: 8, upTo: 1 },
] as const
/** Outcomes per day of a repeating week: steady, with two busier days. */
const WEEKDAY_OUTCOMES = [1, 0, 1, 0, 1, 1, 2]

/** All outcomes recorded on one day (every source: ads, organic, repeat clients, walk-ins). */
export function outcomesOn(date: string, anchor: string): BusinessLedgerRow[] {
  const offset = dayOffset(date, anchor)
  const seed = 70_001 + offset * 17
  // By distance from the anchor, not calendar weekday, so the default range reads the same any day.
  const weekday = ((offset % 7) + 7) % 7
  // A slow upward trend: an extra outcome is a little likelier on recent days.
  const extra = draw(seed) < 0.25 - Math.min(56, -offset) * 0.002 ? 1 : 0
  const count = Math.max(0, WEEKDAY_OUTCOMES[weekday] + extra - (draw(seed + 1) < 0.12 ? 1 : 0))
  return Array.from({ length: count }, (_, i) => {
    const pick = draw(seed + 10 + i)
    const type = STUDIO_TYPES.find((t) => pick < t.upTo)!
    const canceled = draw(seed + 20 + i) < 0.08
    const unpaid = !canceled && draw(seed + 30 + i) < 0.1
    return { id: `demo-outcome-${date}-${i + 1}`, price: type.price, amount_paid: canceled || unpaid ? 0 : type.price, canceled,
      booking_date_et: date, appointment_type: type.name, appointment_duration: type.hours * 60 }
  })
}
const outcomesIn = (range: ReportingRange, anchor: string) => datesOf(range).flatMap((date) => outcomesOn(date, anchor))

type AdDays = ReturnType<typeof deliveryFor>
const totalsOf = (days: AdDays, adIds: readonly string[], dates?: readonly string[]): DayTotals =>
  sumTotals(adIds.flatMap((id) => [...days.get(id)!.entries()].filter(([date]) => !dates || dates.includes(date)).map(([, t]) => t)))

function metaReport(context: ReportingContext, anchor: string, imageFor: (index: number) => string | null) {
  const current = deliveryFor(context.range, anchor), previous = deliveryFor(context.comparison, anchor)
  const days = datesOf(context.range).length
  const row = (adIds: readonly string[], prior: boolean) => graphRow(totalsOf(prior ? previous : current, adIds), days)
  const allAds = DEMO_ADS.map((ad) => ad.id)
  const adsOf = (level: 'campaign' | 'adset' | 'ad', id: string) => DEMO_ADS.filter((ad) => level === 'ad' ? ad.id === id
    : level === 'adset' ? ad.adsetId === id : DEMO_ADSETS.find((set) => set.id === ad.adsetId)!.campaignId === id).map((ad) => ad.id)
  const entity = (level: 'campaign' | 'adset' | 'ad', id: string): ReportEntity => {
    const ad = level === 'ad' ? DEMO_ADS.find((a) => a.id === id)! : null
    const adset = DEMO_ADSETS.find((set) => set.id === (level === 'adset' ? id : ad?.adsetId)) ?? null
    const campaign = DEMO_CAMPAIGNS.find((c) => c.id === (level === 'campaign' ? id : adset!.campaignId))!
    const ads = adsOf(level, id)
    const audiences = new Set(ads.map((adId) => DEMO_ADSETS.find((set) => set.id === DEMO_ADS.find((a) => a.id === adId)!.adsetId)!.audience))
    const audience = audiences.size === 1 ? [...audiences][0] : 'mixed'
    const name = level === 'campaign' ? campaign.name : level === 'adset' ? adset!.name : ad!.name
    const index = ad ? DEMO_ADS.indexOf(ad) : -1
    const image = ad ? imageFor(index) : null
    return { id, level, name, campaignId: campaign.id, campaignName: campaign.name, adsetId: adset?.id ?? null, adsetName: adset?.name ?? null,
      status: ad?.status ?? (ads.every((adId) => DEMO_ADS.find((a) => a.id === adId)!.status === 'PAUSED') ? 'PAUSED' : 'ACTIVE'),
      configurationAsOf: context.asOf, audience, audienceLabel: adset && level !== 'campaign' ? adset.audienceLabel
        : audience === 'warm' ? 'Warm · retargeting' : audience === 'cold' ? 'Cold · prospecting' : 'Mixed audiences',
      creative: ad ? { id: `12000000000000040${index + 1}`, name: ad.name, format: ad.format, imageUrl: image, thumbnailUrl: image, videoUrl: null,
        durationSeconds: ad.durationSeconds, body: ad.body, headline: ad.headline, destination: 'https://example.test/book' } : null,
      metrics: buildMetaMetrics(context, row(ads, false), row(ads, true), { level, id }),
      series: [], comparisonSeries: [], breakdowns: [] }
  }
  const daily = (days: AdDays, range: ReportingRange) => datesOf(range).map((date) => graphRow(totalsOf(days, allAds, [date]), 1, date))
  return {
    metrics: buildMetaMetrics(context, row(allAds, false), row(allAds, true)),
    entities: [...DEMO_CAMPAIGNS.map((c) => entity('campaign', c.id)), ...DEMO_ADSETS.map((s) => entity('adset', s.id)), ...DEMO_ADS.map((a) => entity('ad', a.id))],
    series: buildMetaSeries(context, daily(current, context.range), daily(previous, context.comparison)),
    comparisonSeries: buildMetaSeries({ ...context, range: context.comparison, comparison: previousReportingRange(context.comparison) }, daily(previous, context.comparison), null),
    breakdowns: [], observations: [], attributionWindow: '7-day click / 1-day view', reportingTime: 'Impression date',
    sourceDescription: 'Synthetic Meta evidence for a fictional account',
  }
}

function confirmationFacts(rows: BusinessLedgerRow[]) {
  return aggregateConfirmationFacts(rows.map((row, i) => ({ id: row.id, canceled: row.canceled,
    web_origin_state: i % 6 === 5 ? 'staff_or_manual' : i % 9 === 8 ? 'origin_unknown' : 'website', capi_sent_at: null })),
  new Set(rows.filter((_, i) => i % 6 !== 5 && i % 9 !== 8 && i % 7 !== 3).map((row) => String(row.id))))
}

/** The demo's reporting data for any range (the gateway's /api/reporting answers from it). */
export function demoReportingData(range: ReportingRange, calendar: DemoCalendar, imageFor: (index: number) => string | null = () => null): ReportingData {
  const context: ReportingContext = { account: DEMO_ACCOUNT, range, comparison: previousReportingRange(range), timezone: DEMO_TIMEZONE, currency: 'USD', asOf: calendar.asOf }
  const anchor = calendar.today
  const current = outcomesIn(range, anchor), previous = outcomesIn(context.comparison, anchor)
  const native = buildBusinessReport(context, current, previous)
  const business = { ...native, sourceDescription: `Synthetic outcome evidence. ${native.sourceDescription}` }
  const linked = (rows: BusinessLedgerRow[]) => Math.round(rows.filter((row) => !row.canceled && (row.amount_paid ?? 0) > 0).length * 0.45)
  const days = datesOf(range).length
  const meta = metaReport(context, anchor, imageFor)
  return { context,
    meta: { state: 'available', asOf: context.asOf, notes: [], data: meta },
    business: { state: 'available', asOf: context.asOf, notes: [], data: business },
    website: { state: 'available', asOf: context.asOf, notes: [], data: nativeWebsite(context, Math.max(1, days / 3)) },
    measurement: { state: 'partial', asOf: context.asOf, notes: [], data: sampleMeasurement(context, native,
      { current: confirmationFacts(current), previous: confirmationFacts(previous) }, { current: linked(current), previous: linked(previous) }) } }
}

export function demoPacket(section: string, range: ReportingRange, calendar: DemoCalendar, imageFor?: (index: number) => string | null): ReportingPacket {
  const data = demoReportingData(range, calendar, imageFor)
  const notes = ['Sample data: fictional metrics for a fictional business.']
  if (section === 'meta') return { section, context: data.context, result: data.meta, notes }
  if (section === 'business') return { section, context: data.context, result: data.business, notes }
  if (section === 'measurement') return { section, context: data.context, result: data.measurement!, notes }
  return { section: 'website', context: data.context, result: data.website, notes }
}
