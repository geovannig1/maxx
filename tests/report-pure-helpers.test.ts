import { describe, it, expect } from 'vitest'
import { flagTargetId } from '@/lib/recommendations/generate'
import { composeOpenRecommendations, EMPTY_SNAPSHOT_NOTICE } from '@/lib/report/generator'
import { buildUserMessage, type ReportInputData } from '@/lib/report/prompt-builder'
import { lineageNotice, staleLineageBanner, NO_SNAPSHOT_NOTICE } from '@/lib/flags/generations'

// Pure report/recommendation helpers.
// flagTargetId: the flag's REQUIRED target resolved strictly by entity_level - a deleted AD keeps its
// parent adset/campaign ids, so the old coalesce silently retargeted the parent instead of surfacing the
// orphan. composeOpenRecommendations: a legitimately EMPTY generation still carries its stale/unknown
// lineage caveat in the deterministic report input.

describe('flagTargetId - level-required target, never the parent', () => {
  it('a deleted AD (null ad_id, parents intact) resolves NULL - the exact survivor the guard must catch', () => {
    expect(flagTargetId({ entity_level: 'ad', ad_id: null, adset_id: 'as-1', campaign_id: 'c-1' })).toBeNull()
  })
  it('a deleted ADSET (null adset_id, campaign intact) resolves NULL', () => {
    expect(flagTargetId({ entity_level: 'adset', ad_id: null, adset_id: null, campaign_id: 'c-1' })).toBeNull()
  })
  it('healthy rows resolve their own level id', () => {
    expect(flagTargetId({ entity_level: 'ad', ad_id: 'a-1', adset_id: 'as-1', campaign_id: 'c-1' })).toBe('a-1')
    expect(flagTargetId({ entity_level: 'adset', ad_id: null, adset_id: 'as-1', campaign_id: 'c-1' })).toBe('as-1')
    expect(flagTargetId({ entity_level: 'campaign', ad_id: null, adset_id: null, campaign_id: 'c-1' })).toBe('c-1')
  })
})

describe('composeOpenRecommendations - a pinned generation is NEVER an absent section', () => {
  const stale = lineageNotice({ state: 'last_known_complete', committedAt: '2026-07-18T00:00:00Z', parentFlagGeneration: 'F1' })
  const unknown = lineageNotice({ state: 'unknown', committedAt: null, parentFlagGeneration: null })

  it('EMPTY + current lineage -> the deterministic zero-count statement (a complete zero-result evaluation)', () => {
    expect(composeOpenRecommendations(null, [])).toBe(EMPTY_SNAPSHOT_NOTICE)
  })
  it('EMPTY + stale lineage -> the caveat AND the zero-count statement', () => {
    const out = composeOpenRecommendations(stale, [])
    expect(out).toContain(`_${staleLineageBanner('2026-07-18T00:00:00Z')}_`)
    expect(out).toContain(EMPTY_SNAPSHOT_NOTICE)
  })
  it('EMPTY + unknown lineage -> the unverified caveat AND the zero-count statement', () => {
    const out = composeOpenRecommendations(unknown, [])
    expect(out).toMatch(/could not be verified/i)
    expect(out).toContain(EMPTY_SNAPSHOT_NOTICE)
  })
  it('non-empty generation joins the caveat above the rendered recommendations (no zero-count line)', () => {
    const out = composeOpenRecommendations(stale, ['REC A', 'REC B'])
    expect(out).toMatch(/^_Last-known-complete/)
    expect(out).toContain('REC A\n\nREC B')
    expect(out).not.toContain(EMPTY_SNAPSHOT_NOTICE)
  })
  it('the three absence-flavors stay distinguishable (zero-count vs no-snapshot are different copy)', () => {
    expect(EMPTY_SNAPSHOT_NOTICE).not.toBe(NO_SNAPSHOT_NOTICE)
  })
})

describe('prompt output level: the structured-recommendations section reaches the LLM', () => {
  const zero = { spend: 0, leads: 0, bookings: 0, impressions: 0, reach: 0, clicks: 0, ctr: null, cpm: null, cpl: null, cpb: null, appointmentValue: null, roas: null }
  const input = (openRecommendations: string | null): ReportInputData => ({
    date: '2026-07-18', accountName: 'T', currency: 'USD', accountInsights: zero,
    prevDayInsights: null, prev7dayInsights: null, topCampaigns: [], alerts: [],
    learnings: null, decisionMemory: null, expertKnowledge: null, openRecommendations,
  })

  it('a current EMPTY generation puts the zero-count statement in the FINAL user message', () => {
    const msg = buildUserMessage(input(composeOpenRecommendations(null, [])))
    expect(msg).toContain('OPEN STRUCTURED RECOMMENDATIONS')
    expect(msg).toContain(EMPTY_SNAPSHOT_NOTICE)
  })
  it('only a truly ABSENT pin (null) omits the section — the ambiguity the fix removes', () => {
    const msg = buildUserMessage(input(null))
    expect(msg).not.toContain('OPEN STRUCTURED RECOMMENDATIONS')
  })
})
