import type { MetricClaim } from '@/lib/cockpit/contracts'
import { outcomeWords } from '@/config/outcome-nouns'

const OW = outcomeWords()

export type MetaNativeDefinition = { key: string; label: string; unit: MetricClaim['unit']; field?: string; action?: string; event?: string; attributed?: boolean }
export type MetaRatioDefinition = readonly [key: string, label: string, numerator: string, denominator: string, scale: number, unit: MetricClaim['unit']]

export const META_NATIVE_METRIC_DEFINITIONS: readonly MetaNativeDefinition[] = [
  { key: 'spend', label: 'Spend', unit: 'money', field: 'spend' },
  { key: 'bookings', label: `Reported ${OW.many}`, unit: 'count', event: 'AppointmentConfirmed' },
  { key: 'appointment_value', label: `Reported ${OW.one} value`, unit: 'money', event: 'AppointmentConfirmed' },
  { key: 'purchase_count', label: 'Reported purchases', unit: 'count', event: 'Purchase' },
  { key: 'purchase_value', label: 'Reported purchase value', unit: 'money', event: 'Purchase' },
  { key: 'impressions', label: 'Impressions', unit: 'count', field: 'impressions' },
  { key: 'reach', label: 'Reach', unit: 'count', field: 'reach' },
  { key: 'frequency', label: 'Frequency', unit: 'ratio', field: 'frequency' },
  { key: 'clicks', label: 'All clicks', unit: 'count', field: 'clicks' },
  { key: 'link_clicks', label: 'Link clicks', unit: 'count', field: 'inline_link_clicks' },
  { key: 'outbound_clicks', label: 'Outbound clicks', unit: 'count', field: 'outbound_clicks', action: 'outbound_click' },
  { key: 'landing_page_views', label: 'Landing-page views', unit: 'count', field: 'actions', action: 'landing_page_view' },
  { key: 'messaging_conversations_started', label: 'Messaging conversations started', unit: 'count', field: 'actions', action: 'onsite_conversion.messaging_conversation_started_7d' },
  { key: 'messaging_conversations_replied', label: 'Messaging conversations replied', unit: 'count', field: 'actions', action: 'onsite_conversion.messaging_conversation_replied_7d' },
  { key: 'messaging_first_replies', label: 'Messaging first replies', unit: 'count', field: 'actions', action: 'onsite_conversion.messaging_first_reply' },
  { key: 'instagram_profile_visits', label: 'Instagram profile visits', unit: 'count', field: 'instagram_profile_visits', attributed: true },
  { key: 'instagram_profile_follows', label: 'Instagram profile follows', unit: 'count', field: 'instagram_profile_follow', attributed: true },
  { key: 'action_video_views', label: 'Meta actions: video_view', unit: 'count', field: 'actions', action: 'video_view' },
  { key: 'video_plays', label: 'Video starts', unit: 'count', field: 'video_play_actions', action: 'video_view' },
  { key: 'video_2s', label: 'Continuous 2-second views', unit: 'count', field: 'video_continuous_2_sec_watched_actions', action: 'video_view' },
  { key: 'thruplays', label: 'ThruPlays', unit: 'count', field: 'video_thruplay_watched_actions', action: 'video_view' },
  ...(['25', '50', '75', '100'] as const).map(percent => ({ key: `watch_p${percent}`, label: `${percent}% video watches`, unit: 'count' as const, field: `video_p${percent}_watched_actions`, action: 'video_view' })),
  { key: 'average_watch_seconds', label: 'Average watch time', unit: 'seconds', field: 'video_avg_time_watched_actions', action: 'video_view' },
  { key: 'engagements', label: 'Post engagements', unit: 'count', field: 'actions', action: 'post_engagement' },
  { key: 'reactions', label: 'Post reactions', unit: 'count', field: 'actions', action: 'post_reaction' },
  { key: 'comments', label: 'Comments', unit: 'count', field: 'actions', action: 'comment' },
  { key: 'shares', label: 'Post shares', unit: 'count', field: 'actions', action: 'post' },
  { key: 'saves', label: 'Post saves', unit: 'count', field: 'actions', action: 'onsite_conversion.post_save' },
  { key: 'bookings_click', label: `Click-attributed ${OW.many}`, unit: 'count', event: 'AppointmentConfirmed' },
  { key: 'bookings_view', label: `View-attributed ${OW.many}`, unit: 'count', event: 'AppointmentConfirmed' },
]

export const META_RATIO_METRIC_DEFINITIONS: readonly MetaRatioDefinition[] = [
  ['cost_per_booking', `Cost per reported ${OW.one}`, 'spend', 'bookings', 1, 'money'],
  ['appointment_roas', 'AppointmentConfirmed ROAS', 'appointment_value', 'spend', 1, 'ratio'],
  ['purchase_roas', 'Purchase ROAS', 'purchase_value', 'spend', 1, 'ratio'],
  ['cost_per_purchase', 'Cost per reported Purchase', 'spend', 'purchase_count', 1, 'money'],
  ['cpm', 'CPM', 'spend', 'impressions', 1000, 'money'],
  ['ctr', 'All-click CTR', 'clicks', 'impressions', 100, 'percent'],
  ['cpc', 'All-click CPC', 'spend', 'clicks', 1, 'money'],
  ['link_ctr', 'Link CTR', 'link_clicks', 'impressions', 100, 'percent'],
  ['link_cpc', 'Link CPC', 'spend', 'link_clicks', 1, 'money'],
  ['outbound_ctr', 'Outbound CTR', 'outbound_clicks', 'impressions', 100, 'percent'],
  ['outbound_cpc', 'Outbound CPC', 'spend', 'outbound_clicks', 1, 'money'],
  ['cost_per_lpv', 'Cost per landing-page view', 'spend', 'landing_page_views', 1, 'money'],
  ['cost_per_messaging_conversation_started', 'Cost per messaging conversation started', 'spend', 'messaging_conversations_started', 1, 'money'],
  ['cost_per_instagram_profile_visit', 'Cost per Instagram profile visit', 'spend', 'instagram_profile_visits', 1, 'money'],
  ['cost_per_instagram_profile_follow', 'Cost per Instagram profile follow', 'spend', 'instagram_profile_follows', 1, 'money'],
  ['cost_per_action_video_view', 'Cost per Meta actions: video_view', 'spend', 'action_video_views', 1, 'money'],
  ['cost_per_2s_view', 'Cost per continuous 2-second view', 'spend', 'video_2s', 1, 'money'],
  ['cost_per_thruplay', 'Cost per ThruPlay', 'spend', 'thruplays', 1, 'money'],
  ['cost_per_engagement', 'Cost per post engagement', 'spend', 'engagements', 1, 'money'],
  ['cost_per_share', 'Cost per share', 'spend', 'shares', 1, 'money'],
  ['engagement_rate', 'Engagements per impression', 'engagements', 'impressions', 100, 'percent'],
  ['share_rate', 'Shares per impression', 'shares', 'impressions', 100, 'percent'],
  ...(['25', '50', '75', '100'] as const).map(percent => [`retention_p${percent}`, `${percent}% retention`, `watch_p${percent}`, 'video_plays', 100, 'percent'] as [string, string, string, string, number, MetricClaim['unit']]),
]

export function metaNativeMetricDescription(definition: MetaNativeDefinition): string {
  return definition.key === 'reach' || definition.key === 'frequency'
    ? 'Native Meta aggregate for this exact window and population; never summed across rows.'
    : definition.attributed
      ? `Meta ${definition.field}; omitted fields remain unavailable. Exact deduplication rules are not inferred.`
    : `Meta ${definition.event ?? definition.action ?? definition.field}; ${definition.event ? 'event-specific, aliases are not added; ' : ''}omitted fields remain unavailable.`
}
