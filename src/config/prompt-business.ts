import { BUSINESS_PROFILE, EXAMPLE_BUSINESS_PROFILE, type BusinessProfile } from './business-profile'
import { DEFAULT_BUSINESS_NAME } from './business-display'

// How AI prompts name the business. Prompts read the configured business profile
// (BUSINESS_PROFILE_JSON, NEXT_PUBLIC_BUSINESS_NAME); a field still carrying the fictional example profile's
// value counts as not configured and becomes neutral wording, so no prompt assumes a business, a trade or a
// city the owner never stated. Server-only (the profile reads and validates the environment).

export interface PromptBusiness {
  /** "Northwind Bikes", or "the business". */
  name: string
  /** One-line description, or a neutral one. */
  description: string
  /** City the business serves, or '' when not stated. */
  place: string
  /** Service area in plain words, or '' when not stated. */
  serviceArea: string
}

const NEUTRAL_NAME = 'the business'
const NEUTRAL_DESCRIPTION = 'a business advertising on Meta'

const stated = (value: string, example: string): string => (value === example ? '' : value)

/** PURE over its input. The business as prompts should name it. */
export function promptBusiness(profile: BusinessProfile = BUSINESS_PROFILE): PromptBusiness {
  return {
    name: stated(profile.name, DEFAULT_BUSINESS_NAME) || NEUTRAL_NAME,
    description: stated(profile.description, EXAMPLE_BUSINESS_PROFILE.description) || NEUTRAL_DESCRIPTION,
    place: stated(profile.city, EXAMPLE_BUSINESS_PROFILE.city),
    serviceArea: stated(profile.serviceArea, EXAMPLE_BUSINESS_PROFILE.serviceArea),
  }
}

/** "Northwind Bikes, bicycle repair shop in Lyon" / "the business, a business advertising on Meta". */
export function promptBusinessLine(business: PromptBusiness = promptBusiness()): string {
  return `${business.name}, ${business.description}${business.place ? ` in ${business.place}` : ''}`
}
