import type { ReportingContext } from '@/lib/reporting/contracts'
import type { MetaRow } from '@/lib/reporting/meta-metrics'

/** Fictional account shapes for scaling checks: `campaigns` x `days` of campaign-day delivery, and with
 * `hierarchy` 3 ad sets x 3 ads per campaign plus their current configuration. Shared by the offline
 * benchmark (scripts/bench/reporting-packet.ts) and the operation-count guard. */
export interface MetaScaleShape { label: string; campaigns: number; days: number; hierarchy: boolean }

export const META_SCALE_ACCOUNT = '123'
const DAY_MS = 86_400_000
const day = (from: string, offset: number) => new Date(Date.parse(`${from}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10)

export function parseMetaScaleShape(label: string): MetaScaleShape {
  const match = /^(\d+)x(\d+)(h?)$/.exec(label)
  if (!match) throw new Error(`Invalid shape ${label}; expected e.g. 12x28 or 50x90h`)
  return { label, campaigns: Number(match[1]), days: Number(match[2]), hierarchy: match[3] === 'h' }
}

export function metaScaleContext(shape: MetaScaleShape): ReportingContext {
  const to = '2026-09-01'
  const from = day(to, -(shape.days - 1))
  return {
    account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: META_SCALE_ACCOUNT, name: 'Fictional benchmark account' },
    range: { from, to }, comparison: { from: day(from, -shape.days), to: day(from, -1) },
    timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
  }
}

const action = (action_type: string, value: number) => ({ action_type, value: String(value) })

function insight(ids: { campaign?: number; adset?: number; ad?: number }, start: string, stop: string, scale: number, count: number): MetaRow {
  return {
    date_start: start, date_stop: stop, account_id: META_SCALE_ACCOUNT,
    ...(ids.campaign ? { campaign_id: String(ids.campaign), campaign_name: `Campaign ${ids.campaign}` } : {}),
    ...(ids.adset ? { adset_id: String(ids.adset), adset_name: `Set ${ids.adset}` } : {}),
    ...(ids.ad ? { ad_id: String(ids.ad), ad_name: `Ad ${ids.ad}` } : {}),
    spend: String(100 * scale), impressions: String(1000 * scale), reach: String(800 * scale), frequency: '1.25',
    clicks: String(30 * scale), inline_link_clicks: String(12 * scale), outbound_clicks: [action('outbound_click', 20 * scale)],
    actions: [action('purchase', 3 * scale), action('post_engagement', 100 * scale), action('landing_page_view', 15 * scale)],
    action_values: [action('purchase', 300 * scale)],
    video_play_actions: [action('video_view', 100 * scale)], video_thruplay_watched_actions: [action('video_view', 60 * scale)],
    results: [{ indicator: 'AppointmentConfirmed', values: [
      { value: String(count), attribution_windows: ['default'] },
      { value: String(count), attribution_windows: ['7d_click'] },
      { value: '0', attribution_windows: ['1d_view'] },
    ] }],
    conversion_values: [action('AppointmentConfirmed', count * 100)],
  }
}

/** Campaign c owns ad sets c*10+1..3; ad set s owns ads s*10+1..3. */
function tree(shape: MetaScaleShape) {
  const campaigns = Array.from({ length: shape.campaigns }, (_, index) => 101 + index)
  const adsets = shape.hierarchy ? campaigns.flatMap(campaign => [1, 2, 3].map(index => ({ campaign, adset: campaign * 10 + index }))) : []
  const ads = adsets.flatMap(parent => [1, 2, 3].map(index => ({ ...parent, ad: parent.adset * 10 + index })))
  return { campaigns, adsets, ads }
}

function insights(shape: MetaScaleShape, params: Record<string, string>): MetaRow[] {
  if (params.breakdowns) return []
  const range = JSON.parse(params.time_range) as { since: string; until: string }
  const daily = Boolean(params.time_increment)
  const dates = daily ? Array.from({ length: shape.days }, (_, index) => day(range.since, index)) : [range.since]
  const stop = (date: string) => daily ? date : range.until
  const scale = daily ? 1 : shape.days
  const ids = tree(shape)
  const filter = params.filtering ? new Set((JSON.parse(params.filtering) as Array<{ value: string[] }>)[0].value) : null
  if (params.level === 'account') return dates.map(date => insight({}, date, stop(date), scale * shape.campaigns, 0))
  if (params.level === 'campaign') return dates.flatMap(date => ids.campaigns.filter(id => !filter || filter.has(String(id)))
    .map(campaign => insight({ campaign }, date, stop(date), scale, daily ? 1 : shape.days)))
  if (params.level === 'adset') return daily ? [] : ids.adsets.map(item => insight(item, range.since, range.until, scale, 0))
  if (params.level === 'ad') return daily ? [] : ids.ads.map(item => insight(item, range.since, range.until, scale, 0))
  return []
}

function configuration(shape: MetaScaleShape, edge: string): MetaRow[] {
  const ids = tree(shape)
  const base = { status: 'ACTIVE', effective_status: 'ACTIVE', updated_time: '2026-09-01T00:00:00+0000', account_id: `act_${META_SCALE_ACCOUNT}` }
  if (edge === 'campaigns') return ids.campaigns.map(id => ({ ...base, id: String(id), name: `Campaign ${id}`, objective: 'OUTCOME_SALES', daily_budget: '5000' }))
  if (edge === 'adsets') return ids.adsets.map(item => ({ ...base, id: String(item.adset), name: `Set ${item.adset}`,
    campaign_id: String(item.campaign), optimization_goal: 'OFFSITE_CONVERSIONS' }))
  if (edge === 'ads') return ids.ads.map(item => ({ ...base, id: String(item.ad), name: `Ad ${item.ad}`,
    campaign_id: String(item.campaign), adset_id: String(item.adset) }))
  return []
}

/** The Graph response body for one reporting GET (path without the version prefix). */
export function metaScaleResponse(shape: MetaScaleShape, path: string, params: Record<string, string>): { data?: MetaRow[] } & MetaRow {
  if (path === `/act_${META_SCALE_ACCOUNT}`) return { id: `act_${META_SCALE_ACCOUNT}`, currency: 'USD', timezone_name: 'America/New_York' }
  const edge = path.split('/')[2] ?? ''
  return { data: edge === 'insights' ? insights(shape, params) : configuration(shape, edge) }
}
