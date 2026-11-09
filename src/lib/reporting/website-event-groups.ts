import {
  DEFAULT_GA4_BOOKING_EVENT, DEFAULT_GA4_INTENT_EVENTS, DEFAULT_GA4_LEAD_EVENTS, parseGa4EventNames,
} from '@/lib/ga4/event-names'

// The website report's three event cards, each counting the GA4 events this install names for it.
// Confirmations reuse GA4_BOOKING_EVENT, the outcome event the rest of the GA4 telemetry counts, so
// one event name means one thing everywhere.

export type WebsiteEventGroupKey = 'intent_events' | 'lead_events' | 'confirmation_events'

export interface WebsiteEventGroup {
  key: WebsiteEventGroupKey
  label: string
  /** The environment variable that names this group's events. */
  variable: 'GA4_INTENT_EVENTS' | 'GA4_LEAD_EVENTS' | 'GA4_BOOKING_EVENT'
  /** Valid configured names; empty when the configuration is invalid. */
  names: readonly string[]
  /** The configured value breaks the GA4 event-name rule: the card is unavailable, never guessed. */
  invalid: boolean
}

const GROUPS = [
  { key: 'intent_events', label: 'Intent events', variable: 'GA4_INTENT_EVENTS', fallback: DEFAULT_GA4_INTENT_EVENTS },
  { key: 'lead_events', label: 'Lead events', variable: 'GA4_LEAD_EVENTS', fallback: DEFAULT_GA4_LEAD_EVENTS },
  { key: 'confirmation_events', label: 'Confirmation events', variable: 'GA4_BOOKING_EVENT', fallback: DEFAULT_GA4_BOOKING_EVENT },
] as const

/** PURE over its input. The three groups from an environment record; unset or blank uses the default. */
export function websiteEventGroups(env: Record<string, string | undefined>): readonly WebsiteEventGroup[] {
  return GROUPS.map(({ fallback, ...group }) => {
    const raw = env[group.variable]?.trim() || fallback
    // GA4_BOOKING_EVENT is a single name, so a comma in it is invalid rather than a list.
    const names = group.variable === 'GA4_BOOKING_EVENT' && raw.includes(',') ? null : parseGa4EventNames(raw)
    return { ...group, names: names ?? [], invalid: names === null }
  })
}

/** The union of every valid configured name, in group order, without duplicates. */
export function websiteEventQueryNames(groups: readonly WebsiteEventGroup[]): string[] {
  return [...new Set(groups.flatMap((group) => group.names))]
}
