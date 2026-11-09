import { BusinessLocaleError } from './business-config'

// What this business calls its outcomes on screen. A studio says
// "booking/bookings", a shop "order/orders", a B2B team "lead/leads". Every screen reads the name through
// `outcomeNoun`, so no component hard-codes one business's vocabulary.
//
// The default is "outcome/outcomes": it is the domain word used by the data model, the docs and the
// "Outcome sources" screen, and, unlike "result", it cannot be confused with Meta's own "Results" column
// (the count of the campaign's optimisation event, which Maxx shows as a Meta-reported figure).
//
// Client-safe and dependency-free apart from the shared error type: the literal
// `process.env.NEXT_PUBLIC_OUTCOME_NOUN` read must stay literal so Next.js inlines it into the browser.

export const OUTCOME_NOUN_ENV = 'NEXT_PUBLIC_OUTCOME_NOUN'

export interface OutcomeNoun {
  singular: string
  plural: string
}

export const DEFAULT_OUTCOME_NOUN: OutcomeNoun = { singular: 'outcome', plural: 'outcomes' }

const MAX_WORD_LENGTH = 40
// Letters (any script), digits, spaces, hyphens and apostrophes: enough for "sign-up", "qualified lead",
// "réservation"; nothing that could be markup.
const WORD = /^[\p{L}\p{N}][\p{L}\p{N} '’-]*$/u

/** PURE. `singular/plural` (surrounding spaces ignored), or null when malformed. */
export function parseOutcomeNoun(value: unknown): OutcomeNoun | null {
  if (typeof value !== 'string') return null
  const parts = value.split('/').map((part) => part.trim())
  if (parts.length !== 2) return null
  const [singular, plural] = parts
  const valid = (word: string) => word.length > 0 && word.length <= MAX_WORD_LENGTH && WORD.test(word)
  return valid(singular) && valid(plural) ? { singular, plural } : null
}

/** The configured noun. An invalid value fails loudly (the startup check names the variable). */
export function configuredOutcomeNoun(): OutcomeNoun {
  const value = process.env.NEXT_PUBLIC_OUTCOME_NOUN?.trim()
  if (!value) return DEFAULT_OUTCOME_NOUN
  const parsed = parseOutcomeNoun(value)
  if (!parsed) {
    throw new BusinessLocaleError('outcome_noun_invalid', `${OUTCOME_NOUN_ENV} must be singular/plural, such as booking/bookings.`)
  }
  return parsed
}

export interface OutcomeNounOptions {
  /** Plural unless false. Ignored when `count` is given. */
  plural?: boolean
  /** Singular when exactly 1, plural otherwise (English-style agreement, matching the UI copy). */
  count?: number
  /** Upper-case the first letter, for headings and labels. */
  capitalize?: boolean
}

/** The business's word for its outcomes, e.g. `outcomeNoun()` → "bookings", `{ count: 1 }` → "booking". */
export function outcomeNoun(options: OutcomeNounOptions = {}): string {
  const noun = configuredOutcomeNoun()
  const plural = options.count !== undefined ? options.count !== 1 : options.plural !== false
  const word = plural ? noun.plural : noun.singular
  return options.capitalize ? word.charAt(0).toLocaleUpperCase() + word.slice(1) : word
}

export interface OutcomeWords {
  /** "booking" */ one: string
  /** "bookings" */ many: string
  /** "Booking" */ One: string
  /** "Bookings" */ Many: string
}

/** The four forms at once, for screens with many labels: `const W = outcomeWords()` then `${W.many}`. */
export function outcomeWords(): OutcomeWords {
  return {
    one: outcomeNoun({ plural: false }),
    many: outcomeNoun(),
    One: outcomeNoun({ plural: false, capitalize: true }),
    Many: outcomeNoun({ capitalize: true }),
  }
}

/** "a booking", "an outcome": the English indefinite article before a configured noun (by its first letter). */
export function withIndefiniteArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

// Nouns for a scheduled, time-bound service: the outcome has a start, a duration and a booked slot.
// Matched against the LAST word of either form, so "studio booking" and "photo sessions" count.
const BOOKING_LIKE_WORDS = new Set([
  'booking', 'bookings', 'appointment', 'appointments', 'reservation', 'reservations',
  'session', 'sessions', 'lesson', 'lessons', 'class', 'classes', 'consultation', 'consultations',
  'rental', 'rentals', 'visit', 'visits', 'treatment', 'treatments', 'stay', 'stays', 'shoot', 'shoots',
])

/**
 * PURE. True when the configured outcome is a scheduled booking (booking, appointment, reservation,
 * session …). Screens use it to show booking-only measures — recorded hours, durations — only to a
 * business whose outcomes have them; an order, a lead or the default "outcome" does not.
 */
export function isBookingLikeOutcome(noun: OutcomeNoun = configuredOutcomeNoun()): boolean {
  const last = (word: string) => word.trim().toLowerCase().split(/\s+/).pop() ?? ''
  return BOOKING_LIKE_WORDS.has(last(noun.singular)) || BOOKING_LIKE_WORDS.has(last(noun.plural))
}
