import { buildBusinessReport, type BusinessLedgerRow } from '../../src/lib/reporting/business-metrics'
import { buildMetaMetrics, type MetaRow } from '../../src/lib/reporting/meta-metrics'
import { previousReportingRange } from '../../src/lib/reporting/range'
import type { ReportEntity, ReportingContext, ReportingData, ReportingRange } from '../../src/lib/reporting/contracts'
import { platformMeta } from '../fixtures/reporting-business-platform'

export const EXECUTIVE_ANSWER_MODES = ['opposing', 'payments', 'aligned', 'stable', 'business-missing', 'meta-missing', 'partial-payment', 'settling'] as const
export type ExecutiveAnswerMode = typeof EXECUTIVE_ANSWER_MODES[number]
export const EXECUTIVE_ANSWER_RANGE = { from: '2026-08-19', to: '2026-08-21' }
export const executiveAnswerMode = (scenario?: string | null) => EXECUTIVE_ANSWER_MODES.find(mode => scenario === `executive-answer-${mode}`) ?? null
const CURRENT_DAY = '2026-08-19', PRIOR_DAY = '2026-08-16'
const account = { id: '00000000-0000-4000-8000-000000000901', metaAccountId: 'act_123', name: 'Fictional executive answer studio' }
type NativeInput = { spend: number; bookings: number | null; value: number | null; purchases: number; purchaseValue: number }
const zero: NativeInput = { spend: 0, bookings: 0, value: 0, purchases: 0, purchaseValue: 0 }
function nativeRow(input: NativeInput, units = 10): MetaRow {
  const row = platformMeta(input.spend, input.bookings ?? 0, input.value ?? 0, input.purchases, input.purchaseValue)
  return { spend: row.spend, actions: row.actions, action_values: row.action_values,
    ...(input.bookings === null ? {} : { results: row.results, conversion_values: row.conversion_values }),
    impressions: String(units * 1000), clicks: String(units * 30), inline_link_clicks: String(units * 25),
    outbound_clicks: [{ action_type: 'outbound_click', value: String(units * 20) }] }
}
const currentAccount: NativeInput = { spend: 600, bookings: 20, value: 2400, purchases: 4, purchaseValue: 1200 }
const priorAccount: NativeInput = { spend: 500, bookings: 10, value: 1000, purchases: 2, purchaseValue: 500 }
function booking(id: number, date: string, price: number, paid: number | null): BusinessLedgerRow {
  return { id, booking_date_et: date, price, amount_paid: paid, canceled: false, appointment_type_id: 10,
    appointment_type: 'Fictional studio rental', appointment_duration: '60' }
}
export function executiveAnswerInputs(mode: ExecutiveAnswerMode) {
  const pairs = mode === 'stable' ? [[500, 500], [500, 500]] : ['payments', 'partial-payment', 'settling'].includes(mode)
    ? [[600, 100], [600, mode === 'partial-payment' ? null : 100]] : mode === 'aligned' ? [[600, 600], [600, 600]] : [[400, 400]]
  const priorPairs = mode === 'stable' ? [[500, 500], [500, 500]] : ['payments', 'aligned', 'partial-payment', 'settling'].includes(mode)
    ? [[800, 800]] : [[500, 500], [500, 500]]
  return {
    current: pairs.map(([price, paid], index) => booking(index + 1, CURRENT_DAY, price!, paid)),
    prior: priorPairs.map(([price, paid], index) => booking(index + 101, PRIOR_DAY, price, paid)),
    metaCurrent: nativeRow(currentAccount), metaPrior: nativeRow(mode === 'stable' ? currentAccount : priorAccount),
  }
}
function combine(rows: NativeInput[]): NativeInput {
  return rows.reduce<NativeInput>((sum, row) => ({ spend: sum.spend + row.spend,
    bookings: sum.bookings === null || row.bookings === null ? null : sum.bookings + row.bookings,
    value: sum.value === null || row.value === null ? null : sum.value + row.value,
    purchases: sum.purchases + row.purchases, purchaseValue: sum.purchaseValue + row.purchaseValue }), zero)
}
function selected(range: ReportingRange, current: NativeInput, prior: NativeInput) {
  const rows = [[CURRENT_DAY, current], [PRIOR_DAY, prior]] as const
  return combine(rows.filter(([day]) => day >= range.from && day <= range.to).map(([, input]) => input))
}
function member(index: number, prior: boolean, stable: boolean): NativeInput {
  const currentSpend = [200, 120, 90, 60, 40, 30, 25, 15, 0, 20]
  const spend = !prior ? currentSpend : stable ? [140, 120, 90, 60, 40, 30, 25, 75, 0, 20] : [160, 90, 70, 50, 30, 20, 10, 50, 0, 20]
  const bookings = !prior || stable ? [6, 4, 2, 2, 1, 1, 0, 3, 0, null] : [3, 2, 1, 1, 0, 0, 0, 1, 0, null]
  const purchases = !prior || stable ? [1, 1, 0, 0, 0, 0, 0, 1, 0, 1] : [1, 0, 0, 0, 0, 0, 0, 0, 0, 1]
  const count = bookings[index]
  return { spend: spend[index], bookings: count, value: count === null ? null : count * (index === 7 ? 200 : 100),
    purchases: purchases[index], purchaseValue: purchases[index] * (!prior || stable ? 300 : 250) }
}

// Fixed fictional native rows: a changed window selects different records, never re-dates a claim.
export function executiveAnswerFixture(from = EXECUTIVE_ANSWER_RANGE.from, to = EXECUTIVE_ANSWER_RANGE.to,
  mode: ExecutiveAnswerMode = 'opposing', asOf = mode === 'settling' ? '2026-08-22T17:00:00.000Z' : new Date().toISOString()): ReportingData {
  const context: ReportingContext = { account, range: { from, to }, comparison: previousReportingRange({ from, to }),
    timezone: 'America/New_York', currency: 'USD' as const, asOf }
  const input = executiveAnswerInputs(mode), rows = [...input.current, ...input.prior]
  const cohort = (range: ReportingRange) => rows.filter(row => row.booking_date_et! >= range.from && row.booking_date_et! <= range.to)
  const stable = mode === 'stable', campaigns = ['Studio rentals', 'Professional productions', 'Returning clients']
  const units = (range: ReportingRange, members: number) => [CURRENT_DAY, PRIOR_DAY].filter(day => day >= range.from && day <= range.to).length * members
  const groupIndex = (index: number) => index < 4 ? 0 : index < 8 ? 1 : 2
  const entity = (level: ReportEntity['level'], index: number, indexes = [index]): ReportEntity => {
    const group = groupIndex(index), id = level === 'campaign' ? `campaign-${group + 1}` : `${level === 'adset' ? 'set' : 'ad'}-${index + 1}`
    const name = level === 'campaign' ? campaigns[group] : index === 6 ? 'Lower-spend exception'
      : index === 7 ? 'Improving lower-spend result' : index === 9 ? 'Unmeasured bookings' : `${level === 'adset' ? 'Audience' : 'Creative'} ${index + 1}`
    const current = combine(indexes.map(item => member(item, false, stable))), prior = combine(indexes.map(item => member(item, true, stable)))
    return { id, name, level, campaignId: `campaign-${group + 1}`, campaignName: campaigns[group],
      adsetId: level === 'campaign' ? null : `set-${index + 1}`, adsetName: level === 'campaign' ? null : `Audience ${index + 1}`,
      status: index === 6 ? 'PAUSED' : 'ACTIVE', configurationAsOf: asOf, audience: 'cold', audienceLabel: 'Cold · fictional broad targeting',
      creative: null, metrics: buildMetaMetrics(context, nativeRow(selected(context.range, current, prior), units(context.range, indexes.length)),
        nativeRow(selected(context.comparison, current, prior), units(context.comparison, indexes.length)), { level, id }), series: [], comparisonSeries: [], breakdowns: [] }
  }
  const missing = (source: string) => ({ state: 'unavailable' as const, data: null, asOf: null, notes: [`${source} is not supplied in this fictional scenario.`] })
  return { context,
    business: mode === 'business-missing' ? missing('Acuity business') : { state: 'available', asOf, notes: ['Fictional native booking ledger. No connected studio evidence.'],
      data: buildBusinessReport(context, cohort(context.range), cohort(context.comparison)) },
    meta: mode === 'meta-missing' ? missing('Meta') : { state: 'partial', asOf,
      notes: ['Fictional native account totals are independently supplied; one lower-level AppointmentConfirmed field is unavailable.',
        ...(mode === 'settling' ? ['Explicit fictional observation clock 2026-08-22; selected outcomes are still settling.'] : [])], data: {
        metrics: buildMetaMetrics(context, nativeRow(selected(context.range, currentAccount, stable ? currentAccount : priorAccount), units(context.range, 10)),
          nativeRow(selected(context.comparison, currentAccount, stable ? currentAccount : priorAccount), units(context.comparison, 10)), { level: 'account', id: account.id }),
        entities: [...[0, 4, 8].map(index => entity('campaign', index, Array.from({ length: index === 8 ? 2 : 4 }, (_, offset) => index + offset))),
          ...Array.from({ length: 10 }, (_, index) => entity('adset', index)), ...Array.from({ length: 10 }, (_, index) => entity('ad', index))],
        series: [], comparisonSeries: [], breakdowns: [], observations: [], detailState: 'complete',
        attributionWindow: '7-day click / 1-day view', reportingTime: 'Impression date in America/New_York',
        sourceDescription: 'Fictional native Meta query rows. Account results are not inferred from incomplete entity outcomes.',
      } },
    website: missing('GA4 website'), measurement: missing('Booking association and tracking'),
  }
}
