import { describe, expect, it } from 'vitest'
import { EXAMPLE_BUSINESS_PROFILE, type BusinessProfile } from '@/config/business-profile'
import { BRAND_FACTS, promptBrandFacts, renderBrandFactsLine, renderPersonasLine, renderUnverifiedCaveat } from '@/lib/knowledge/brand-facts'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { buildCompetitorAdPrompt } from '@/lib/competitors/analyze-ad'
import { COPY_SYSTEM_PROMPT } from '@/lib/creative/copy-tone'

// prompts must not inject the fictional example profile's differentiators, prices, personas or
// unverified-claim list when the business has not configured its own (BUSINESS_PROFILE_JSON unset, or a
// field left at the example's value). A configured field is used as stated; an unconfigured one becomes
// neutral wording that asserts nothing. Same rule as promptBusiness (src/config/prompt-business.ts).

const EXAMPLE_WORDS = /north-facing|1,200 sq ft loft|seamless paper|\$60\/hr|half-day blocks|product photographers|e-commerce sellers|1,000 happy clients|same-day booking|largest studio/i

const configured: BusinessProfile = {
  ...EXAMPLE_BUSINESS_PROFILE,
  differentiators: ['same-day repairs', 'free pickup within 5 km'],
  pricing: ['tune-up from 49 EUR'],
  personas: ['commuters', 'racers'],
  requiresVerification: ['"lifetime warranty"'],
}

describe('brand facts in prompts are neutral when the business is unconfigured', () => {
  it('renders no example fact for the unconfigured (example) profile', () => {
    for (const text of [renderBrandFactsLine(EXAMPLE_BUSINESS_PROFILE), renderPersonasLine(EXAMPLE_BUSINESS_PROFILE), renderUnverifiedCaveat(EXAMPLE_BUSINESS_PROFILE)]) {
      expect(text).not.toMatch(EXAMPLE_WORDS)
      expect(text.length).toBeGreaterThan(0)
    }
    expect(renderBrandFactsLine(EXAMPLE_BUSINESS_PROFILE)).toMatch(/no verified differentiators or prices are configured/i)
    expect(renderUnverifiedCaveat(EXAMPLE_BUSINESS_PROFILE)).toMatch(/REQUIRE VERIFICATION/)
    expect(promptBrandFacts(EXAMPLE_BUSINESS_PROFILE)).toMatchObject({ differentiators: [], pricing: [], personas: [], requires_verification: [] })
  })

  it('renders a configured profile as stated (control)', () => {
    expect(renderBrandFactsLine(configured)).toBe('same-day repairs, free pickup within 5 km; tune-up from 49 EUR')
    expect(renderPersonasLine(configured)).toBe('commuters, racers')
    expect(renderUnverifiedCaveat(configured)).toContain('"lifetime warranty" REQUIRE VERIFICATION')
  })

  it('treats each field on its own: configured differentiators with example pricing show only the differentiators', () => {
    const partial = { ...EXAMPLE_BUSINESS_PROFILE, differentiators: ['same-day repairs'] }
    expect(renderBrandFactsLine(partial)).toBe('same-day repairs')
  })

  it('the exported BRAND_FACTS follow the same rule: no example fact when unconfigured', () => {
    expect(JSON.stringify(BRAND_FACTS)).not.toMatch(EXAMPLE_WORDS)
    expect(JSON.stringify(BRAND_FACTS)).not.toMatch(/Springfield|daylight photo studio/)
    expect(BRAND_FACTS).toEqual(promptBrandFacts())
  })

  it('the default (unconfigured) prompts carry no example fact', () => {
    const { system } = buildCompetitorAdPrompt({})
    for (const prompt of [MAXX_INSTRUCTIONS, system, COPY_SYSTEM_PROMPT]) expect(prompt).not.toMatch(EXAMPLE_WORDS)
  })
})
