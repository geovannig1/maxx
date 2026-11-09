import { describe, it, expect } from 'vitest'
import { promptBusinessLine } from '@/config/prompt-business'
import { renderBrandFactsLine, renderPersonasLine, renderUnverifiedCaveat } from '@/lib/knowledge/brand-facts'
import { EXAMPLE_BUSINESS_PROFILE, type BusinessProfile } from '@/config/business-profile'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { buildCompetitorAdPrompt } from '@/lib/competitors/analyze-ad'

// brand-facts is the single source of the verified facts. Both prompts must interpolate from it so the
// facts can never drift between the MCP instructions, the competitor analyzer, and the brand doc.

// the example profile's own facts are neutral in prompts until a business configures its own, so the
// fact-carrying assertions run against a configured profile that states these facts.
const CONFIGURED: BusinessProfile = {
  ...EXAMPLE_BUSINESS_PROFILE,
  differentiators: ['daylight studio', '1,200 sq ft loft', 'seamless paper backdrops', 'freight elevator'],
  pricing: ['studio rental from $60/hr'],
  personas: ['product photographers', 'video crews'],
  requiresVerification: ['specific customer counts', '"same-day booking guaranteed"', '"largest studio in the city"'],
}

describe('brand-facts — single source of verified facts', () => {
  it('carries the canonical verified facts', () => {
    const line = renderBrandFactsLine(CONFIGURED)
    expect(line).toContain('1,200 sq ft')
    expect(line).toContain('seamless paper')
    expect(line).toContain('$60/hr')
    expect(line).toContain('freight elevator')
    expect(renderPersonasLine(CONFIGURED)).toContain('video crews')
  })

  it('keeps the requires-verification claims OUT of the verified line and IN the caveat', () => {
    const line = renderBrandFactsLine(CONFIGURED)
    const caveat = renderUnverifiedCaveat(CONFIGURED)
    // every requires-verification claim appears verbatim in the caveat...
    for (const unv of CONFIGURED.requiresVerification) expect(caveat).toContain(unv)
    // ...and NOT in the stated-as-fact line
    expect(line).not.toMatch(/same-day booking/)
    expect(line).not.toMatch(/largest studio/i)
    expect(caveat).toMatch(/REQUIRE VERIFICATION/i)
  })

  it('MAXX_INSTRUCTIONS interpolates the verified facts from brand-facts (no drift)', () => {
    expect(MAXX_INSTRUCTIONS).toContain(renderBrandFactsLine())
    expect(MAXX_INSTRUCTIONS).toMatch(/REQUIRE VERIFICATION/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/status, blockers, and lineage/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/future server-side CampaignPlan builder/i)
    expect(MAXX_INSTRUCTIONS).not.toMatch(/planning_context_input|campaign_plan_input_only/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/blocked.*static brand.*historical background/i)
  })

  it('the competitor analyzer system prompt interpolates the same verified facts', () => {
    const { system } = buildCompetitorAdPrompt({})
    expect(system).toContain(renderBrandFactsLine())
    expect(system).toContain(renderPersonasLine())
    // the business is named through promptBusinessLine (configured profile, neutral fallback).
    expect(system).toContain(promptBusinessLine())
  })

  it('the copy-generation prompt interpolates brand-facts and never asserts an unverified claim (cross-PR audit M2)', async () => {
    // COPY_SYSTEM_PROMPT hardcoded "makeup station" as a verified fact while brand-facts marks it
    // REQUIRES-VERIFICATION — and it runs on the live cron brief-generation path. Locked here.
    const { COPY_SYSTEM_PROMPT } = await import('@/lib/creative/copy-tone')
    expect(COPY_SYSTEM_PROMPT).toContain(renderBrandFactsLine())
    expect(COPY_SYSTEM_PROMPT).not.toMatch(/makeup station, /) // never listed among verified facts
    expect(COPY_SYSTEM_PROMPT).toMatch(/REQUIRE VERIFICATION/i)
  })

  it('every prompt/doctrine surface that lists verified differentiators pulls from brand-facts (no hardcoded makeup)', async () => {
    const fs = await import('fs')
    for (const f of ['src/lib/modes/launch-readiness.ts', 'src/lib/recommendations/manifest.ts', 'src/lib/creative/copy-tone.ts']) {
      const src = fs.readFileSync(f, 'utf8')
      // The word may appear in comments explaining the fix; it must not appear inside a verified-facts list literal.
      expect(src, f).not.toMatch(/(cyclorama|podcast)[^\n]*makeup/)
    }
  })
})
