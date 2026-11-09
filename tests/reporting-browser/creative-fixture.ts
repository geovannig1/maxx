import type { ReportEntity, ReportingData, ReportingContext } from '../../src/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '../../src/lib/reporting/meta-metrics'
import { describeCreativeIdentity } from '../../src/lib/reporting/creative-identity'
import { buildMetaSeries, buildMetaBreakdowns, previousContext, dayOffset } from '../../src/lib/reporting/meta-breakdowns'
import type { ReportCreativeAssignmentEvidence } from '../../src/lib/reporting/creative-assignment-contract'
import { reportingFixture } from '../../scripts/demo/sample/reports'

export type CreativeMediaMode = 'ok' | 'video-denied' | 'image-denied' | 'all-denied'
export function creativeMediaOrigin(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null
  } catch { return null }
}
export function creativeMediaMode(value: string | null | undefined): CreativeMediaMode {
  return value === 'video-denied' || value === 'image-denied' || value === 'all-denied' ? value : 'ok'
}

interface Sample {
  id: string; name: string; creativeId: string; spend: number; impressions: number; clicks: number
  outbound: number | null; landingPageViews: number | null; bookings: number | null; duration: 8 | 60 | null; starts: number
  watches: readonly [number, number, number, number]; history?: 'missing' | 'changed'
  messagingStarts?: number; messagingReplies?: number; firstReplies?: number; profileVisits?: number; profileFollows?: number; actionVideoViews?: number
}
export const CREATIVE_SAMPLES: readonly Sample[] = [
  { id: '301', name: 'Short studio tour', creativeId: '401', spend: 60, impressions: 10000, clicks: 50,
    outbound: 10, landingPageViews: 8, bookings: 0, duration: 8, starts: 5000, watches: [4000, 3500, 3000, 2500],
    messagingStarts: 3, messagingReplies: 2, firstReplies: 1, profileVisits: 12, profileFollows: 2, actionVideoViews: 300 },
  { id: '302', name: 'Short studio tour — retargeting', creativeId: '401', spend: 10, impressions: 1000, clicks: 40,
    outbound: 30, landingPageViews: 24, bookings: 1, duration: 8, starts: 500, watches: [300, 200, 100, 50] },
  { id: '303', name: 'Shared display name', creativeId: '402', spend: 25, impressions: 5000, clicks: 30,
    outbound: 15, landingPageViews: 12, bookings: 1, duration: 60, starts: 2000, watches: [500, 200, 100, 50] },
  { id: '304', name: 'Shared display name', creativeId: '403', spend: 15, impressions: 2000, clicks: 30,
    outbound: 20, landingPageViews: 15, bookings: 1, duration: null, starts: 0, watches: [0, 0, 0, 0] },
  { id: '305', name: 'History missing', creativeId: '404', spend: 5, impressions: 500, clicks: 10,
    outbound: 5, landingPageViews: null, bookings: 0, duration: 8, starts: 100, watches: [60, 40, 20, 10], history: 'missing' },
  { id: '306', name: 'Changed creative assignment', creativeId: '405', spend: 3, impressions: 300, clicks: 6,
    outbound: 3, landingPageViews: 2, bookings: 0, duration: 60, starts: 60, watches: [30, 20, 10, 2], history: 'changed' },
  { id: '307', name: 'Measured zero outcomes', creativeId: '406', spend: 2, impressions: 200, clicks: 0,
    outbound: 0, landingPageViews: 0, bookings: 0, duration: 8, starts: 0, watches: [0, 0, 0, 0] },
  { id: '308', name: 'Outcome field unavailable', creativeId: '407', spend: 0, impressions: 100, clicks: 0,
    outbound: null, landingPageViews: null, bookings: null, duration: null, starts: 0, watches: [0, 0, 0, 0] },
]

function nativeRow(sample: Sample, spendScale: number, prior = false): MetaRow {
  const count = (value: number) => prior ? Math.floor(value / 2) : value
  const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
  const video = (value: number) => [action('video_view', count(value))]
  const bookings = sample.bookings === null ? null : prior ? Number(sample.id === '301') : sample.bookings
  const exact = <K extends keyof Sample>(key: K) => sample[key] === undefined ? null : count(sample[key] as number)
  const optionalAction = (key: keyof Sample, actionType: string) => {
    const value = exact(key)
    return value === null ? [] : [action(actionType, value)]
  }
  return {
    spend: String(sample.spend * spendScale / (prior ? 2 : 1)), impressions: String(count(sample.impressions)),
    clicks: String(count(sample.clicks)), inline_link_clicks: String(count(sample.clicks)),
    ...(sample.profileVisits === undefined ? {} : { instagram_profile_visits: String(count(sample.profileVisits)) }),
    ...(sample.profileFollows === undefined ? {} : { instagram_profile_follow: String(count(sample.profileFollows)) }),
    ...(sample.outbound === null ? {} : { outbound_clicks: [action('outbound_click', count(sample.outbound))] }),
    actions: [...(sample.landingPageViews === null ? [] : [action('landing_page_view', count(sample.landingPageViews))]),
      action('post_engagement', count(sample.clicks * 3)),
      action('post_reaction', count(sample.clicks)), action('comment', count(sample.clicks > 0 ? 2 : 0)),
      action('post', count(sample.clicks > 0 ? 2 : 0)), action('onsite_conversion.post_save', count(sample.clicks > 0 ? 2 : 0)),
      ...optionalAction('messagingStarts', 'onsite_conversion.messaging_conversation_started_7d'),
      ...optionalAction('messagingReplies', 'onsite_conversion.messaging_conversation_replied_7d'),
      ...optionalAction('firstReplies', 'onsite_conversion.messaging_first_reply'),
      ...optionalAction('actionVideoViews', 'video_view'),
      ...(bookings === null ? [] : [action('purchase', bookings)])],
    ...(bookings === null ? {} : {
      action_values: [action('purchase', bookings * 100)],
      conversion_values: [action('offsite_conversion.fb_pixel_custom.AppointmentConfirmed', bookings * 100)],
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
        { value: String(bookings), attribution_windows: ['default'] },
        { value: String(bookings), attribution_windows: ['7d_click'] },
        { value: '0', attribution_windows: ['1d_view'] },
      ] }],
    }),
    ...(sample.duration === null ? {} : {
      video_play_actions: video(sample.starts), video_continuous_2_sec_watched_actions: video(sample.watches[0]),
      video_thruplay_watched_actions: video(sample.duration === 8 ? sample.watches[3] : sample.watches[0]),
      video_p25_watched_actions: video(sample.watches[0]), video_p50_watched_actions: video(sample.watches[1]),
      video_p75_watched_actions: video(sample.watches[2]), video_p100_watched_actions: video(sample.watches[3]),
      video_avg_time_watched_actions: [action('video_view', sample.duration === 8 ? 4 : 10)],
    }),
  }
}

function assignmentHistory(context: ReportingContext): ReportCreativeAssignmentEvidence {
  const before = new Date(Date.parse(`${context.comparison.from}T00:00:00Z`) - 86400000).toISOString()
  const after = new Date(Date.parse(`${context.range.to}T12:00:00Z`) + 86400000).toISOString()
  if (Date.parse(after) > Date.parse(context.asOf)) return { accountId: context.account.id, asOf: context.asOf,
    state: 'unavailable', observations: [], notes: ['Synthetic retained history does not bracket these dates.'] }
  return { accountId: context.account.id, asOf: context.asOf, state: 'available',
    notes: ['Fictional dated observations establish object assignment only, not historical media content.'],
    observations: CREATIVE_SAMPLES.flatMap((sample, index) => sample.history === 'missing' ? [] : [before, after].map((observedAt, side) => ({
      id: `00000000-0000-4000-8000-${String(index * 2 + side + 1).padStart(12, '0')}`,
      metaAdId: sample.id, metaCreativeId: sample.history === 'changed' && side === 0 ? '499' : sample.creativeId,
      observedAt, metaUpdatedTime: new Date(Date.parse(before) - 86400000 + (sample.history === 'changed' && side === 1 ? 3600000 : 0)).toISOString(),
    }))) }
}

function observedDetail(context: ReportingContext, scale: number) {
  const entity = { level: 'ad' as const, id: '301' }
  const daily = (prior: boolean) => {
    const range = prior ? context.comparison : context.range
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1
    const share = (total: number, index: number) => Math.floor(total / days) + Number(index < total % days)
    return Array.from({ length: days }, (_, index) => ({ ad_id: '301', date_start: dayOffset(range.from, index), date_stop: dayOffset(range.from, index),
      spend: String(share((prior ? 30 : 60) * scale, index)),
      outbound_clicks: [{ action_type: 'outbound_click', value: String(share(prior ? 5 : 10, index)) }],
      instagram_profile_visits: String(share(prior ? 6 : 12, index)),
      instagram_profile_follow: String(share(prior ? 1 : 2, index)),
      actions: [
        { action_type: 'landing_page_view', value: String(share(prior ? 4 : 8, index)) },
        { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(share(prior ? 1 : 3, index)) },
        { action_type: 'onsite_conversion.messaging_conversation_replied_7d', value: String(share(prior ? 1 : 2, index)) },
        { action_type: 'onsite_conversion.messaging_first_reply', value: String(share(prior ? 0 : 1, index)) },
        { action_type: 'video_view', value: String(share(prior ? 150 : 300, index)) },
      ],
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
        { value: String(prior && index === 0 ? 1 : 0), attribution_windows: ['default'] },
      ] }] }))
  }
  const placements = (prior: boolean) => [
    { ...CREATIVE_SAMPLES[0], spend: 40, impressions: 6000, clicks: 30, outbound: 6, landingPageViews: 6, messagingStarts: 2, messagingReplies: 2, firstReplies: 1, profileVisits: 8, profileFollows: 2, actionVideoViews: 200 },
    { ...CREATIVE_SAMPLES[0], id: 'placement-rest', spend: 20, impressions: 4000, clicks: 20, outbound: 4, landingPageViews: 2, messagingStarts: 1, messagingReplies: 0, firstReplies: 0, profileVisits: 4, profileFollows: 0, actionVideoViews: 100 },
  ].map((sample, index) => ({ ...nativeRow(sample, scale, prior), ad_id: '301',
    publisher_platform: 'instagram', platform_position: index ? 'reels' : 'feed' }))
  return { series: buildMetaSeries(context, daily(false), daily(true), entity),
    comparisonSeries: buildMetaSeries(previousContext(context), daily(true), null, entity),
    breakdowns: buildMetaBreakdowns(context, 'placement', placements(false), placements(true), entity) }
}

export function creativeReportingFixture(from = '2026-09-02', to = '2026-09-04', origin?: string | null, mode: CreativeMediaMode = 'ok', detailIds: readonly string[] = []): ReportingData {
  const base = reportingFixture(from, to, { id: '00000000-0000-4000-8000-000000000001', metaAccountId: 'act_123', name: 'Synthetic creative account' })
  const context = base.context, media = creativeMediaOrigin(origin), scale = from === '2026-09-02' ? 1 : 2
  const asset = (path: string, denied: boolean) => media ? `${media}/${denied ? 'denied/' : ''}${path}` : null
  const entities: ReportEntity[] = CREATIVE_SAMPLES.map(sample => ({ id: sample.id, level: 'ad', name: sample.name,
    campaignId: '101', campaignName: 'Synthetic studio campaign', adsetId: '201', adsetName: 'Synthetic studio audience',
    status: 'ACTIVE', configurationAsOf: context.asOf, audience: 'unknown', audienceLabel: 'Synthetic audience; classification unavailable',
    creative: { id: sample.creativeId, name: `Synthetic creative ${sample.creativeId}`, format: sample.duration === null ? 'image' : 'video',
      imageUrl: asset('original.png', mode === 'image-denied' || mode === 'all-denied'),
      thumbnailUrl: asset('thumbnail.png', mode === 'all-denied'),
      videoUrl: sample.duration === null ? null : asset(`original-${sample.duration}.mp4`, mode === 'video-denied' || mode === 'all-denied'),
      durationSeconds: sample.duration, body: 'Fictional original media and performance for local preview.', headline: 'Synthetic studio creative', destination: null,
      identity: describeCreativeIdentity(sample.duration === null ? { image_hash: `synthetic_image_${sample.creativeId}` }
        : { video_id: String(Number(sample.creativeId) + 100) }, context.asOf) },
    metrics: buildMetaMetrics(context, nativeRow(sample, scale), nativeRow(sample, scale, true), { level: 'ad', id: sample.id }),
    ...(sample.id === '301' && detailIds.includes(sample.id) ? observedDetail(context, scale) : { series: [], comparisonSeries: [], breakdowns: [] }),
  }))
  // Account observations include known actions; ad 305 LPV and ad 308 outcome coverage are unknown.
  // Omit nonadditive reach/frequency and unobserved daily/placement rows rather than inventing them.
  const totalRow = (prior: boolean): MetaRow => {
    const rows = CREATIVE_SAMPLES.map(sample => nativeRow(sample, scale, prior))
    const actionFields = ['actions', 'action_values', 'conversion_values', 'outbound_clicks']
    const actions = Object.fromEntries(actionFields.map(field => {
      const sums = new Map<string, number>()
      rows.forEach(row => (row[field] as Array<{ action_type: string; value: string }> | undefined)?.forEach(item =>
        sums.set(item.action_type, (sums.get(item.action_type) ?? 0) + Number(item.value))))
      return [field, Array.from(sums, ([action_type, value]) => ({ action_type, value: String(value) }))]
    }))
    const bookings = prior ? 1 : 3
    return { ...actions, ...Object.fromEntries(['spend', 'impressions', 'clicks', 'inline_link_clicks', 'instagram_profile_visits', 'instagram_profile_follow']
      .map(field => [field, String(rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0))])),
      results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
        { value: String(bookings), attribution_windows: ['default'] }, { value: String(bookings), attribution_windows: ['7d_click'] },
        { value: '0', attribution_windows: ['1d_view'] },
      ] }] }
  }
  const aggregate = (level: 'account' | 'campaign' | 'adset', id: string) => buildMetaMetrics(context, totalRow(false), totalRow(true), { level, id })
  const parents: ReportEntity[] = (['campaign', 'adset'] as const).map(level => ({ ...entities[0], level,
    id: level === 'campaign' ? '101' : '201', name: level === 'campaign' ? 'Synthetic studio campaign' : 'Synthetic studio audience',
    creative: null, series: [], comparisonSeries: [], breakdowns: [], metrics: aggregate(level, level === 'campaign' ? '101' : '201') }))
  return { ...base, meta: { state: 'partial', asOf: context.asOf,
    notes: ['Entirely fictional native-shaped evidence. Ad 305 has no observed landing-page-view field; ad 308 has no observed outcome field. Only selected ad 301 has synthetic daily and placement observations.'],
    data: { metrics: aggregate('account', context.account.id), entities: [...parents, ...entities], series: [], comparisonSeries: [],
      breakdowns: [], observations: [], detailState: 'complete', attributionWindow: '7-day click / 1-day view',
      reportingTime: 'Impression date in America/New_York', sourceDescription: 'Synthetic Meta native observations; not Example Studio results.',
      creativeAssignmentEvidence: assignmentHistory(context) } } }
}
