// Friendly labels + categories for raw Meta action_types (the `actions` / `action_values` /
// cost_per_action_type arrays on daily_insights). Meta returns 40+ cryptic action_type strings;
// this makes the conversion-event table readable without hiding anything.

export type ConversionCategory = 'conversion' | 'traffic' | 'video' | 'engagement' | 'messaging' | 'other'

export const CATEGORY_LABEL: Record<ConversionCategory, string> = {
  conversion: 'Conversions',
  traffic: 'Traffic',
  video: 'Video',
  engagement: 'Engagement',
  messaging: 'Messaging',
  other: 'Other',
}

const LABELS: Record<string, string> = {
  landing_page_view: 'Landing page views',
  omni_landing_page_view: 'Landing page views (omni)',
  link_click: 'Link clicks',
  video_view: 'Meta actions: video_view',
  post_engagement: 'Post engagement',
  page_engagement: 'Page engagement',
  post_reaction: 'Post reactions',
  post: 'Post shares',
  comment: 'Comments',
  lead: 'Leads',
  'offsite_conversion.fb_pixel_lead': 'Leads (pixel)',
  'offsite_conversion.fb_pixel_custom': 'Custom pixel conversions',
  'offsite_conversion.fb_pixel_initiate_checkout': 'Initiate checkout',
  'offsite_conversion.fb_pixel_purchase': 'Purchases (pixel)',
  'offsite_conversion.fb_pixel_complete_registration': 'Registrations',
  'onsite_conversion.messaging_conversation_started_7d': 'Messaging convos started',
  'onsite_conversion.messaging_first_reply': 'Messaging first replies',
  'onsite_conversion.total_messaging_connection': 'Messaging connections',
  'onsite_conversion.post_save': 'Post saves',
  click_to_call_native_call_placed: 'Calls placed',
  call_confirm_grouped: 'Calls confirmed',
}

export function conversionLabel(actionType: string): string {
  if (LABELS[actionType]) return LABELS[actionType]
  const stripped = actionType
    .replace(/^offsite_conversion\./, '')
    .replace(/^onsite_conversion\./, '')
    .replace(/^omni_/, '')
    .replace(/^fb_pixel_/, '')
  return stripped.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const ALERT_METRIC_LABELS: Record<string, string> = {
  cpa: 'CPA',
  cpc: 'CPC',
  cpl: 'CPL',
  cpm: 'CPM',
  ctr: 'CTR',
  roas: 'ROAS',
}

/** Alert rows mix delivery metric keys with Meta action types. Preserve standard metric acronyms,
 * then use the conversion-event labeler for action types and ordinary word-like keys. */
export function alertMetricLabel(metricName: string): string {
  return ALERT_METRIC_LABELS[metricName] ?? conversionLabel(metricName)
}

// Meta reports the SAME conversion under many alias action_types with an IDENTICAL count — Purchase as
// purchase / onsite_web_purchase / offsite_conversion.fb_pixel_purchase / offsite_purchase_add_20_s_calls
// (all 3), Initiate Checkout 5 ways, etc. Listing each alias as its own row inflated the events table and
// its "total conversions" count. canonicalConversion() collapses the known conversion FAMILIES to one key
// (callers take the MAX across aliases, never the sum); non-conversion events keep their own action_type.
const CONVERSION_FAMILIES: Array<{ key: string; label: string; test: RegExp }> = [
  { key: 'appointment_confirmed', label: 'AppointmentConfirmed', test: /appointment_?confirmed/ },
  { key: 'schedule', label: 'Schedule', test: /(^|[._])schedule($|[._])/ },
  { key: 'initiate_checkout', label: 'Initiate Checkout', test: /initiated?_?checkout/ },
  { key: 'purchase', label: 'Purchase', test: /purchase/ },
  { key: 'complete_registration', label: 'Registration', test: /complete_?registration|(^|[._])registration/ },
  { key: 'add_to_cart', label: 'Add to Cart', test: /add_?to_?cart/ },
  { key: 'lead', label: 'Lead', test: /(^|[._])lead(s)?($|[._])/ },
]

/** The generic aggregate that sums ALL custom pixel events — a real row, but NOT a specific conversion;
 *  labeled so it's never mistaken for AppointmentConfirmed. */
export const CUSTOM_AGGREGATE_KEY = '__custom_aggregate'

export function canonicalConversion(actionType: string): { key: string; label: string } | null {
  const t = actionType.toLowerCase()
  if (t === 'offsite_conversion.fb_pixel_custom') return { key: CUSTOM_AGGREGATE_KEY, label: 'All custom pixel events (aggregate)' }
  // NAMED custom conversions ('…fb_pixel_custom.EbookPurchase', '…custom.<id>') keep their OWN key —
  // family substring matching would collapse two DISTINCT custom conversions (EbookPurchase +
  // CoursePurchase → one 'purchase' row, MAX silently dropping one). The only named
  // custom event with a family is AppointmentConfirmed (this account's primary conversion).
  const customName = t.match(/(?:fb_pixel_custom|[._]custom)\.(.+)$/)?.[1]
  if (customName) {
    if (/appointment_?confirmed/.test(customName)) return { key: 'appointment_confirmed', label: 'AppointmentConfirmed' }
    return { key: `custom:${customName}`, label: actionType.split('.').pop() ?? actionType }
  }
  for (const f of CONVERSION_FAMILIES) if (f.test.test(t)) return { key: f.key, label: f.label }
  return null // not a known conversion family — keep its own action_type
}

export function conversionCategory(actionType: string): ConversionCategory {
  const t = actionType.toLowerCase()
  if (/(purchase|\blead\b|checkout|fb_pixel|appointment|registration|subscribe|call|add_to_cart|add_payment)/.test(t)) return 'conversion'
  if (t.includes('messag')) return 'messaging'
  if (t.includes('video')) return 'video'
  if (t.includes('landing_page') || t === 'link_click') return 'traffic'
  if (/(engagement|reaction|comment|\bpost\b|like|save|share|interaction)/.test(t)) return 'engagement'
  return 'other'
}
