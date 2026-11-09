import { z } from 'zod'
import { businessDisplayName } from './business-display'
import { accountCurrency, accountTimezone } from './business-config'

// The business profile is the ONLY place business-specific facts live. Prompts, brand facts, the
// booking page URL and the CAPI event source URL all read from here. Override it with the
// BUSINESS_PROFILE_JSON environment variable (a JSON object with any subset of these fields); the
// example profile below is a fictional studio used by the test suite and the demo.
//
// Server-only: this module reads process.env at import time and validates with zod. Client
// components must use `src/config/business-display.ts` instead.

const businessProfileSchema = z.object({
  /** Short business name used in prompts and reports. */
  name: z.string().trim().min(1).max(80),
  /** One-line description of what the business sells, in plain words. */
  description: z.string().trim().min(1).max(300),
  /** Public website. */
  websiteUrl: z.url(),
  /** Page where a booking starts; used as the CAPI event_source_url. */
  bookingPageUrl: z.url(),
  /** The reference scheduling adapter's public scheduler URL (for example https://<your-subdomain>.as.me/). */
  schedulerUrl: z.url(),
  /** Instagram handle without the @. */
  instagramHandle: z.string().regex(/^[A-Za-z0-9._]{1,30}$/),
  /** City the business serves. */
  city: z.string().trim().min(1).max(80),
  /** Plain-words service area used in prompts (e.g. "15-mile radius around Springfield"). */
  serviceArea: z.string().trim().min(1).max(120),
  /** IANA timezone of the ad account and the business. */
  timezone: z.string().trim().min(1).max(64),
  /** ISO 4217 currency code of the ad account. */
  currency: z.string().trim().length(3),
  /** Differentiators that may be stated as fact in generated copy. */
  differentiators: z.array(z.string().trim().min(1)).min(1),
  /** Pricing entry points that may be stated as fact in generated copy. */
  pricing: z.array(z.string().trim().min(1)),
  /** Audience personas the business serves. */
  personas: z.array(z.string().trim().min(1)).min(1),
  /** Claims that must never be asserted as fact until the owner verifies them. */
  requiresVerification: z.array(z.string().trim().min(1)),
})

export type BusinessProfile = z.infer<typeof businessProfileSchema>

/** Fictional example business. Used when BUSINESS_PROFILE_JSON is unset and by the test suite. */
export const EXAMPLE_BUSINESS_PROFILE: BusinessProfile = {
  name: businessDisplayName(),
  description:
    'daylight photo studio rental in Springfield (product shoots, portraits, small video productions)',
  websiteUrl: 'https://example-studio.test',
  bookingPageUrl: 'https://example-studio.test/book/',
  schedulerUrl: 'https://example-studio.as.me/',
  instagramHandle: 'examplestudio',
  city: 'Springfield',
  serviceArea: '15-mile Springfield radius',
  timezone: accountTimezone(),
  currency: accountCurrency(),
  differentiators: [
    'north-facing daylight windows',
    '1,200 sq ft loft',
    'seamless paper backdrops in twelve colours',
    'tethered capture station',
    'blackout curtains for controlled lighting',
    'freight elevator for gear',
    'changing room',
  ],
  pricing: ['studio rental from $60/hr', 'half-day blocks from $200'],
  personas: ['product photographers', 'portrait photographers', 'small brands', 'video crews', 'students', 'e-commerce sellers'],
  requiresVerification: ['specific customer counts (e.g. "1,000 happy clients")', '"same-day booking guaranteed"', '"largest studio in the city"'],
}

export class BusinessProfileError extends Error {}

/** Parse BUSINESS_PROFILE_JSON (a partial override) on top of the example profile. Fails loudly. */
export function loadBusinessProfile(env: Record<string, string | undefined> = process.env): BusinessProfile {
  const raw = env.BUSINESS_PROFILE_JSON?.trim()
  if (!raw) return EXAMPLE_BUSINESS_PROFILE
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BusinessProfileError('BUSINESS_PROFILE_JSON is not valid JSON.')
  }
  const override = businessProfileSchema.partial().strict().safeParse(parsed)
  if (!override.success) {
    const issues = override.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new BusinessProfileError(`BUSINESS_PROFILE_JSON failed validation: ${issues.join('; ')}`)
  }
  // Timezone and currency have one configuration source (business-config.ts); the profile mirrors it
  // and may not quietly disagree with it.
  if (override.data.timezone !== undefined && override.data.timezone !== accountTimezone()) {
    throw new BusinessProfileError('BUSINESS_PROFILE_JSON timezone must match NEXT_PUBLIC_ACCOUNT_TIMEZONE; set the timezone there.')
  }
  if (override.data.currency !== undefined && override.data.currency !== accountCurrency()) {
    throw new BusinessProfileError('BUSINESS_PROFILE_JSON currency must match NEXT_PUBLIC_ACCOUNT_CURRENCY; set the currency there.')
  }
  return businessProfileSchema.parse({ ...EXAMPLE_BUSINESS_PROFILE, ...override.data })
}

export const BUSINESS_PROFILE: BusinessProfile = loadBusinessProfile()
