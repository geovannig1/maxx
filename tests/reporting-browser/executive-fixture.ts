import { buildMetaMetrics, type MetaRow } from '../../src/lib/reporting/meta-metrics'
import type { ReportEntity, ReportingData } from '../../src/lib/reporting/contracts'
import { reportingFixture } from '../../scripts/demo/sample/reports'

// Fictional account: the seventh row must remain discoverable, and an unknown result is not zero.
const inputs = [
  [900, 4, 1000], [500, 3, 900], [300, 1, 250], [200, 2, 400], [100, 1, 300],
  [80, 1, 200], [60, 0, 0], [40, 2, 1000], [0, 0, 0], [20, null, null],
] as const
function row(spend: number, bookings: number | null, value: number | null, units = 1): MetaRow {
  const reach = units === 10 ? 7000 : units === 4 ? 2900 : units === 2 ? 1500 : 800
  return { spend: String(spend), impressions: String(1000 * units), reach: String(reach), frequency: String(1000 * units / reach), clicks: String(30 * units), inline_link_clicks: String(25 * units),
    outbound_clicks: [{ action_type: 'outbound_click', value: String(20 * units) }],
    actions: [{ action_type: 'purchase', value: String(units) }, { action_type: 'landing_page_view', value: String(15 * units) }],
    action_values: [{ action_type: 'purchase', value: String(100 * units) }],
    ...(bookings === null ? {} : { results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed',
      values: [{ value: String(bookings), attribution_windows: ['default'] }, { value: String(bookings), attribution_windows: ['7d_click'] }, { value: '0', attribution_windows: ['1d_view'] }] }] }),
    ...(value === null ? {} : { conversion_values: [{ action_type: 'offsite_conversion.fb_pixel_custom.AppointmentConfirmed', value: String(value) }] }),
  }
}

export function executiveFixture(from = '2026-09-02', to = '2026-09-04', includeOpportunity = false): ReportingData {
  const base = reportingFixture(from, to)
  const factor = from === '2026-09-02' ? 1 : 2
  const template = base.meta.data!.entities.find(entity => entity.level === 'adset')!
  const campaignNames = ['Studio rentals', 'Professional productions', 'Returning clients']
  const campaignIndex = (index: number) => index < 4 ? 0 : index < 8 ? 1 : 2
  const entity = (level: ReportEntity['level'], id: string, name: string, index: number, input: readonly [number, number | null, number | null]): ReportEntity => ({
    ...template, level, id, name, campaignId: `campaign-${campaignIndex(index) + 1}`, campaignName: campaignNames[campaignIndex(index)],
    adsetId: level === 'campaign' ? null : `set-${index + 1}`, adsetName: level === 'ad' ? `Audience ${index + 1}` : null,
    status: index === 6 ? 'PAUSED' : 'ACTIVE',
    metrics: buildMetaMetrics(base.context, row(input[0] * factor, input[1], input[2], level === 'campaign' ? index < 8 ? 4 : 2 : 1), row(input[0] / 2 + (includeOpportunity && (level === 'campaign' ? index === 4 : index === 7) ? 60 : 0), input[1], input[2], level === 'campaign' ? index < 8 ? 4 : 2 : 1), { level, id }),
  })
  const sets = inputs.map((input, index) => entity('adset', `set-${index + 1}`, index === 6 ? 'Lower-spend exception' : index === 9 ? 'Unmeasured bookings' : includeOpportunity && index === 7 ? 'Improving lower-spend result' : `Audience ${index + 1}`, index, input))
  const ads = inputs.map((input, index) => entity('ad', `ad-${index + 1}`, `Creative ${index + 1}`, index, input))
  const campaigns = campaignNames.map((name, index) => {
    const values = inputs.filter((_, item) => campaignIndex(item) === index)
    return entity('campaign', `campaign-${index + 1}`, name, [0, 4, 8][index], [values.reduce((sum, input) => sum + input[0], 0), index === 2 ? null : values.reduce((sum, input) => sum + (input[1] ?? 0), 0), index === 2 ? null : values.reduce((sum, input) => sum + (input[2] ?? 0), 0)])
  })
  // Native-shaped account totals are supplied independently. Reach/frequency are never summed.
  return { ...base, meta: { ...base.meta, state: 'partial', notes: ['Fictional account. AppointmentConfirmed is unavailable for Unmeasured bookings.'], data: {
    ...base.meta.data!, metrics: buildMetaMetrics(base.context, row(2200 * factor, null, null, 10), row(includeOpportunity ? 1160 : 1100, null, null, 10), { level: 'account', id: base.context.account.id }),
    entities: [...campaigns, ...sets, ...ads], sourceDescription: 'Fictional executive coverage scenario; not connected account results.',
  } } }
}
