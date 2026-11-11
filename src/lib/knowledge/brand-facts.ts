// MACHINE-READABLE VERIFIED BRAND FACTS — derived from the business profile (src/config/business-profile.ts,
// overridable with BUSINESS_PROFILE_JSON). Both prompts (MCP instructions and the competitor analyzer)
// interpolate from here, so a fact is verified in ONE place.
//
// DISCIPLINE: `verified` items may be stated as fact; `requires_verification` items must NEVER be asserted.
// This module is FACTS only — it is not economics targets (those live in target-ranges / economics) and
// never overrides account data.

import { BUSINESS_PROFILE, EXAMPLE_BUSINESS_PROFILE, type BusinessProfile } from '@/config/business-profile'

export interface BrandFacts {
  /** One-line business description. */
  business_line: string
  /** Verified differentiators — safe to state as fact. */
  differentiators: readonly string[]
  /** Verified pricing entry points. */
  pricing: readonly string[]
  /** Audience personas the studio serves. */
  personas: readonly string[]
  /** Service-area constraint. */
  geo: string
  /** Claims that REQUIRE VERIFICATION — never assert these as fact. */
  requires_verification: readonly string[]
}

// a list still equal to the fictional example profile's counts as not configured, so prompts never
// state the example studio's differentiators, prices, personas or unverified claims as this business's.
// Same rule as promptBusiness (src/config/prompt-business.ts) for the name and description.
const stated = (value: readonly string[], example: readonly string[]): readonly string[] =>
  value.length === example.length && value.every((item, i) => item === example[i]) ? [] : value

/** PURE over its input. The brand facts prompts may use: unconfigured lists are empty. */
export function promptBrandFacts(profile: BusinessProfile = BUSINESS_PROFILE): BrandFacts {
  return {
    business_line: profile.description === EXAMPLE_BUSINESS_PROFILE.description ? '' : profile.description,
    differentiators: stated(profile.differentiators, EXAMPLE_BUSINESS_PROFILE.differentiators),
    pricing: stated(profile.pricing, EXAMPLE_BUSINESS_PROFILE.pricing),
    personas: stated(profile.personas, EXAMPLE_BUSINESS_PROFILE.personas),
    geo: profile.serviceArea === EXAMPLE_BUSINESS_PROFILE.serviceArea ? '' : profile.serviceArea,
    requires_verification: stated(profile.requiresVerification, EXAMPLE_BUSINESS_PROFILE.requiresVerification),
  }
}

/** The configured business's brand facts, as prompts may state them: an unconfigured (example) field is
 *  empty, never the example's value. */
export const BRAND_FACTS: BrandFacts = promptBrandFacts()

/** Compact verified-facts line for prompt injection (differentiators + pricing), e.g. to ground creative.
 *  Neutral when the business has configured neither. */
export function renderBrandFactsLine(profile: BusinessProfile = BUSINESS_PROFILE): string {
  const facts = promptBrandFacts(profile)
  const parts = [facts.differentiators.join(', '), facts.pricing.join(', ')].filter(Boolean)
  return parts.length > 0 ? parts.join('; ') : 'no verified differentiators or prices are configured for this business, so state none as fact'
}

/** Personas one-liner, or a neutral line when none are configured. */
export function renderPersonasLine(profile: BusinessProfile = BUSINESS_PROFILE): string {
  const personas = promptBrandFacts(profile).personas
  return personas.length > 0 ? personas.join(', ') : 'no audience personas are configured; infer the audience only from account data'
}

/** The "never assert these" caveat, referencing the brand source of truth. No em dashes: this string is
 *  interpolated into COPY_SYSTEM_PROMPT, whose tone rules ban them (tests/copy-tone.test.ts). */
export function renderUnverifiedCaveat(profile: BusinessProfile = BUSINESS_PROFILE): string {
  const claims = promptBrandFacts(profile).requires_verification
  const subject = claims.length > 0 ? claims.join(', ') : 'Claims the owner has not verified (review counts, amenities, opening hours, prices)'
  return `${subject} REQUIRE VERIFICATION; never state them as fact (see docs/configuration.md, business profile).`
}
