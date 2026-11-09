// GA4 event-name rules and the defaults the app counts. No server-only import: the environment
// schema (setup, doctor) and the website report builder both validate with this one rule.

/** GA4's event-name rule: a letter first, then letters, digits and underscores; at most 40 characters. */
export const GA4_EVENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** The outcome event counted when GA4_BOOKING_EVENT is unset. */
export const DEFAULT_GA4_BOOKING_EVENT = 'appointment_confirmed'

/** Intent events when GA4_INTENT_EVENTS is unset: GA4's recommended event for a visitor starting a
 *  checkout or booking flow. A site that tracks intent another way names its own events. */
export const DEFAULT_GA4_INTENT_EVENTS = 'begin_checkout'

/** Lead events when GA4_LEAD_EVENTS is unset: GA4's recommended lead-generation event. */
export const DEFAULT_GA4_LEAD_EVENTS = 'generate_lead'

/** PURE. A comma-separated list of GA4 event names, trimmed and de-duplicated in order; null when the
 *  list is empty or any name breaks the GA4 rule (a partly valid list is not silently narrowed). */
export function parseGa4EventNames(raw: string): string[] | null {
  const names = raw.split(',').map((name) => name.trim()).filter(Boolean)
  if (names.length === 0 || names.some((name) => !GA4_EVENT_NAME.test(name))) return null
  return [...new Set(names)]
}
