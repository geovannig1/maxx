// Fictional Meta delivery for `npm run demo`: three campaigns, five ad sets and eight ads for a made-up
// photo studio ("Example Studio"; ids are digit strings shaped like Meta's, as the schema requires), with one native-shaped insights row per ad per day. Every number is
// generated from the ad's profile and the day's distance from the demo's anchor day, so the same range
// always shows the same figures, campaign, ad set and account totals are exact sums of their ads, and
// the account's daily rows add up to its period totals. Nothing here describes a real account.

export interface DemoAd {
  id: string; name: string; adsetId: string; format: 'image' | 'video'; status: 'ACTIVE' | 'PAUSED'
  /** Average daily spend, CPM, link CTR, landing views per link click, bookings per landing view. */
  spend: number; cpm: number; ctr: number; lpvRate: number; bookingRate: number
  headline: string; body: string; durationSeconds: number | null
}
export interface DemoAdset { id: string; name: string; campaignId: string; audience: 'cold' | 'warm'; audienceLabel: string }
export interface DemoCampaign { id: string; name: string }

export const DEMO_CAMPAIGNS: readonly DemoCampaign[] = [
  { id: '120000000000000101', name: 'Studio rentals · Prospecting' },
  { id: '120000000000000102', name: 'Studio rentals · Retargeting' },
  { id: '120000000000000103', name: 'Product shoot packages' },
]
export const DEMO_ADSETS: readonly DemoAdset[] = [
  { id: '120000000000000201', name: 'Local creators 25-44', campaignId: '120000000000000101', audience: 'cold', audienceLabel: 'Cold · interests' },
  { id: '120000000000000202', name: 'Broad · Advantage+ audience', campaignId: '120000000000000101', audience: 'cold', audienceLabel: 'Cold · broad targeting' },
  { id: '120000000000000203', name: 'Website visitors · 30 days', campaignId: '120000000000000102', audience: 'warm', audienceLabel: 'Warm · website visitors' },
  { id: '120000000000000204', name: 'Instagram engagers · 60 days', campaignId: '120000000000000102', audience: 'warm', audienceLabel: 'Warm · engagers' },
  { id: '120000000000000205', name: 'Small brands · interests', campaignId: '120000000000000103', audience: 'cold', audienceLabel: 'Cold · interests' },
]
export const DEMO_ADS: readonly DemoAd[] = [
  { id: '120000000000000301', name: 'Daylight cyc walkthrough', adsetId: '120000000000000201', format: 'video', status: 'ACTIVE', spend: 13, cpm: 8.5, ctr: .011, lpvRate: .82, bookingRate: .007,
    headline: 'A bright cyc wall, by the hour', body: 'Natural light, a 20 ft cyc wall and props included. Book a two-hour slot.', durationSeconds: 18 },
  { id: '120000000000000302', name: 'Before and after portrait', adsetId: '120000000000000201', format: 'image', status: 'ACTIVE', spend: 8.5, cpm: 7.9, ctr: .009, lpvRate: .78, bookingRate: .005,
    headline: 'Your portraits, our light', body: 'Same model, same camera, our studio light. See the difference.', durationSeconds: null },
  { id: '120000000000000303', name: 'Golden hour set', adsetId: '120000000000000202', format: 'image', status: 'ACTIVE', spend: 11, cpm: 6.8, ctr: .008, lpvRate: .75, bookingRate: .0045,
    headline: 'Golden hour, any hour', body: 'A warm-light set that never loses the sun. Half-day and full-day rates.', durationSeconds: null },
  { id: '120000000000000304', name: 'Reel: 15-second studio tour', adsetId: '120000000000000202', format: 'video', status: 'ACTIVE', spend: 10, cpm: 6.2, ctr: .01, lpvRate: .8, bookingRate: .006,
    headline: 'Take the 15-second tour', body: 'Five sets, one studio. Walk through before you book.', durationSeconds: 15 },
  { id: '120000000000000305', name: 'Book this week', adsetId: '120000000000000203', format: 'image', status: 'ACTIVE', spend: 7, cpm: 14.5, ctr: .019, lpvRate: .86, bookingRate: .018,
    headline: 'Open slots this week', body: 'You looked at the studio. Weekday mornings are still free.', durationSeconds: null },
  { id: '120000000000000306', name: 'Client testimonial', adsetId: '120000000000000204', format: 'video', status: 'ACTIVE', spend: 5.5, cpm: 12.8, ctr: .015, lpvRate: .83, bookingRate: .012,
    headline: 'Why creators come back', body: 'A food photographer on why she books the same set every month.', durationSeconds: 24 },
  { id: '120000000000000307', name: 'Flat-lay product kit', adsetId: '120000000000000205', format: 'image', status: 'ACTIVE', spend: 8.5, cpm: 9.4, ctr: .009, lpvRate: .77, bookingRate: .005,
    headline: 'Product photos, done in a day', body: 'Bring the products; the table, light and backdrops are ready.', durationSeconds: null },
  { id: '120000000000000308', name: 'Packages from $395', adsetId: '120000000000000205', format: 'image', status: 'PAUSED', spend: 5.5, cpm: 9.9, ctr: .006, lpvRate: .7, bookingRate: .0025,
    headline: 'Packages from $395', body: 'Studio time plus an assistant. Paused after a weak first two weeks.', durationSeconds: null },
]

export const ADDITIVE = ['spend', 'impressions', 'clicks', 'link_clicks', 'outbound_clicks', 'landing_page_views', 'engagements',
  'reactions', 'comments', 'shares', 'saves', 'bookings_click', 'bookings_view', 'appointment_value',
  'video_plays', 'video_2s', 'video_thruplay', 'video_p25', 'video_p50', 'video_p75', 'video_p100', 'video_seconds'] as const
export type DayTotals = Record<(typeof ADDITIVE)[number], number>

const DAY_MS = 86_400_000
export const dayOffset = (date: string, anchor: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / DAY_MS)
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
export function datesOf(range: { from: string; to: string }): string[] {
  return Array.from({ length: dayOffset(range.to, range.from) + 1 }, (_, i) => addDays(range.from, i))
}

/** A repeatable value in [0, 1) for a seed: the same ad and day always draw the same number. */
export function draw(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

/** One ad on one day. `offset` is the day's distance from the anchor (yesterday is -1). */
export function adDay(ad: DemoAd, index: number, offset: number): DayTotals {
  const seed = (index + 1) * 10_007 + offset * 131
  // Paused ads stopped delivering two weeks before the anchor; weekends run a little hotter.
  if (ad.status === 'PAUSED' && offset > -15) return Object.fromEntries(ADDITIVE.map((k) => [k, 0])) as DayTotals
  const weekday = ((offset % 7) + 7) % 7
  const trend = 1 + Math.max(-28, offset) * -0.004
  const spend = Math.round(ad.spend * (0.75 + draw(seed) * 0.5) * (weekday >= 5 ? 1.12 : 1) / trend * 100) / 100
  const impressions = Math.round(spend / ad.cpm * 1000)
  const linkClicks = Math.round(impressions * ad.ctr * (0.85 + draw(seed + 1) * 0.3))
  const lpv = Math.round(linkClicks * ad.lpvRate)
  const bookingsClick = Math.floor(lpv * ad.bookingRate + draw(seed + 2))
  const bookingsView = draw(seed + 3) < 0.015 ? 1 : 0
  const video = ad.format === 'video'
  const plays = video ? Math.round(impressions * 0.42) : 0
  return {
    spend, impressions, clicks: Math.round(linkClicks * 1.6), link_clicks: linkClicks, outbound_clicks: Math.round(linkClicks * 0.93),
    landing_page_views: lpv, engagements: Math.round(impressions * 0.011) + linkClicks, reactions: Math.round(impressions * 0.004),
    comments: draw(seed + 4) < 0.3 ? 1 : 0, shares: draw(seed + 5) < 0.2 ? 1 : 0, saves: draw(seed + 6) < 0.25 ? 1 : 0,
    bookings_click: bookingsClick, bookings_view: bookingsView, appointment_value: (bookingsClick + bookingsView) * (index % 2 ? 200 : 250),
    video_plays: plays, video_2s: Math.round(plays * 0.58), video_thruplay: Math.round(plays * 0.17), video_p25: Math.round(plays * 0.36),
    video_p50: Math.round(plays * 0.22), video_p75: Math.round(plays * 0.13), video_p100: Math.round(plays * 0.07), video_seconds: plays * 5,
  }
}

export function sumTotals(rows: readonly DayTotals[]): DayTotals {
  const out = Object.fromEntries(ADDITIVE.map((k) => [k, 0])) as DayTotals
  for (const row of rows) for (const k of ADDITIVE) out[k] += row[k]
  out.spend = Math.round(out.spend * 100) / 100
  return out
}

/** Native Graph insights shape (strings and action lists), as the Meta reader receives it. */
export function graphRow(t: DayTotals, days: number, date?: string): Record<string, unknown> {
  const frequency = Math.min(3.4, 1.08 + days * 0.045)
  const reach = Math.max(t.impressions > 0 ? 1 : 0, Math.round(t.impressions / frequency))
  const action = (type: string, value: number) => ({ action_type: type, value: String(value) })
  const bookings = t.bookings_click + t.bookings_view
  return {
    ...(date ? { date_start: date, date_stop: date } : {}),
    spend: t.spend.toFixed(2), impressions: String(t.impressions), reach: String(reach),
    frequency: reach > 0 ? (t.impressions / reach).toFixed(2) : '0', clicks: String(t.clicks), inline_link_clicks: String(t.link_clicks),
    outbound_clicks: [action('outbound_click', t.outbound_clicks)],
    ...(t.video_plays > 0 ? {
      video_play_actions: [action('video_view', t.video_plays)], video_continuous_2_sec_watched_actions: [action('video_view', t.video_2s)],
      video_thruplay_watched_actions: [action('video_view', t.video_thruplay)], video_p25_watched_actions: [action('video_view', t.video_p25)],
      video_p50_watched_actions: [action('video_view', t.video_p50)], video_p75_watched_actions: [action('video_view', t.video_p75)],
      video_p100_watched_actions: [action('video_view', t.video_p100)],
      video_avg_time_watched_actions: [action('video_view', Math.round(t.video_seconds / t.video_plays))],
    } : {}),
    actions: [action('landing_page_view', t.landing_page_views), action('post_engagement', t.engagements), action('post_reaction', t.reactions),
      action('comment', t.comments), action('post', t.shares), action('onsite_conversion.post_save', t.saves)],
    conversion_values: [action('offsite_conversion.fb_pixel_custom.AppointmentConfirmed', t.appointment_value)],
    results: [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [
      { value: String(bookings), attribution_windows: ['default'] },
      { value: String(t.bookings_click), attribution_windows: ['7d_click'] },
      { value: String(t.bookings_view), attribution_windows: ['1d_view'] },
    ] }],
  }
}

/** Every ad's totals for each date of a range, keyed by ad id then date. */
export function deliveryFor(range: { from: string; to: string }, anchor: string): Map<string, Map<string, DayTotals>> {
  const dates = datesOf(range)
  return new Map(DEMO_ADS.map((ad, index) => [ad.id, new Map(dates.map((date) => [date, adDay(ad, index, dayOffset(date, anchor))]))]))
}
