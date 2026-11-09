import { describe, it, expect } from 'vitest'
import { assembleExpertKnowledge } from '@/mcp/tools/expert-knowledge'
import { renderStoredRecommendation } from '@/mcp/tools/open-recommendations'
import type { StoredRecommendation } from '@/lib/recommendations/store'
import { buildUserMessage, SYSTEM_PROMPT, type ReportInputData } from '@/lib/report/prompt-builder'
import { MAXX_INSTRUCTIONS } from '@/mcp/instructions'
import { TOOL_DEFINITIONS, READ_ONLY_TOOL_DEFINITIONS } from '@/mcp/tools/index'

// the agent/report can SEE existing knowledge.

const insight = (over: Partial<{ id: string; claim: string; source: string; confidence: string | null; applicable_area: string | null }> = {}) => ({
  id: 'i1',
  claim: 'Consolidate ad sets to concentrate signal',
  source: 'Meta Blueprint',
  confidence: 'high' as string | null,
  applicable_area: null as string | null,
  ...over,
})

describe('assembleExpertKnowledge (pure)', () => {
  it('area filter keeps area-agnostic (null) insights plus the matching area', () => {
    const out = assembleExpertKnowledge({
      corpus: [],
      insights: [
        insight({ id: 'a', applicable_area: null }),
        insight({ id: 'b', applicable_area: 'creative' }),
        insight({ id: 'c', applicable_area: 'budget' }),
      ],
      area: 'budget',
      limit: 10,
    })
    expect(out.approved_insights.map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('topic filter matches claim text case-insensitively', () => {
    const out = assembleExpertKnowledge({
      corpus: [],
      insights: [insight({ id: 'a', claim: 'CBO starves cold prospecting' }), insight({ id: 'b', claim: 'Reels hooks' })],
      topic: 'cbo',
      limit: 10,
    })
    expect(out.approved_insights.map((i) => i.id)).toEqual(['a'])
  })

  it('includes hook patterns only for creative asks — and every pattern carries a named source', () => {
    const creative = assembleExpertKnowledge({ corpus: [], insights: [], area: 'creative', limit: 10 })
    expect(creative.hook_patterns.length).toBeGreaterThan(0)
    for (const h of creative.hook_patterns) expect(h.source.length).toBeGreaterThan(3)

    const budget = assembleExpertKnowledge({ corpus: [], insights: [], area: 'budget', limit: 10 })
    expect(budget.hook_patterns).toHaveLength(0)

    const hookTopic = assembleExpertKnowledge({ corpus: [], insights: [], topic: 'hook ideas', limit: 10 })
    expect(hookTopic.hook_patterns.length).toBeGreaterThan(0)
  })

  it('respects limit per shelf', () => {
    const out = assembleExpertKnowledge({
      corpus: [],
      insights: Array.from({ length: 9 }, (_, i) => insight({ id: `i${i}` })),
      limit: 3,
    })
    expect(out.approved_insights).toHaveLength(3)
  })
})

describe('renderStoredRecommendation (pure)', () => {
  const stored: StoredRecommendation = {
    id: 'r1',
    recommendation_type: 'hold',
    target_entity_type: 'adset',
    target_entity_id: '100000000000000010',
    target_entity_name: 'Cold Broad | Advantage+ | $40 (7-day)',
    observed_fact: '4 days delivering, 0 bookings on $104 spend',
    reason_for_action: 'Learning window still open; 7d-click attribution not matured.',
    action_decision: null,
    action_authority_tier: 'diagnostic_only',
    action_authority_legacy: true,
    action_authority_prose_warning: false,
    date_range_start: '2026-07-06',
    date_range_end: '2026-07-09',
    data_sources: ['daily_insights'],
    evidence_summary: 'CTR 3.2%, CPC $0.73 — delivery healthy',
    what_could_make_this_wrong: ['Attribution window may still convert clicks.'],
    confidence_label: 'medium',
    confidence_score: 0.55,
    risk_level: 'low',
    gate_decision: 'hold',
    approval_required: true,
    action_allowed_now: false,
    low_data_warning: 'Only 4 days of delivery.',
    estimate_warning: null,
    attribution_warning: null,
    recommended_next_check_date: '2026-07-13',
    target_metric: 'cpa',
    target_status: 'needs_data',
    target_confidence: 'low',
    target_language: 'Not enough data to judge Cost / Booking.',
    attribution_confidence: null,
    external_knowledge_used: null,
    prior_learning_used: null,
    expected_upside: null,
    possible_downside: null,
    minimum_data_needed: null,
    learning_eligibility: false,
    metric_claim_ids: [],
    status: 'open',
    generated_at: '2026-07-10T01:00:00Z',
  }

  it('renders the load-bearing fields (round-trip of what the owner sees)', () => {
    const s = renderStoredRecommendation(stored)
    expect(s).toContain('[HOLD] Cold Broad | Advantage+ | $40 (7-day)')
    expect(s).toContain('Observed: 4 days delivering')
    expect(s).toContain('(2026-07-06…2026-07-09)')
    expect(s).toContain('Gate: hold')
    expect(s).toContain('⚠ LOW DATA')
    expect(s).toContain('Approval required: YES')
    expect(s).toContain('Re-check on: 2026-07-13')
  })
})

describe('report prompt blocks (holes 3 + 12)', () => {
  const base: ReportInputData = {
    date: '2026-07-10',
    accountName: 'Example Studio',
    currency: 'USD',
    accountInsights: { spend: 72, leads: 0, bookings: 0, impressions: 2000, reach: 1500, clicks: 60, ctr: 3, cpm: 20, cpl: null, cpb: null, appointmentValue: null, roas: null },
    prevDayInsights: null,
    prev7dayInsights: null,
    topCampaigns: [],
    alerts: [],
    ga4: null,
  }

  it('renders the expert-knowledge and open-recommendations blocks when provided', () => {
    const msg = buildUserMessage({ ...base, expertKnowledge: '- Consolidate signal [source: Meta Blueprint]', openRecommendations: '[HOLD] Cold Prospecting' })
    expect(msg).toContain('APPROVED EXPERT KNOWLEDGE')
    expect(msg).toContain('NEVER a fact source')
    expect(msg).toContain('OPEN STRUCTURED RECOMMENDATIONS')
    expect(msg).toContain("don't duplicate")
  })

  it('omits both blocks when absent (no empty headers)', () => {
    const msg = buildUserMessage(base)
    expect(msg).not.toContain('APPROVED EXPERT KNOWLEDGE')
    expect(msg).not.toContain('OPEN STRUCTURED RECOMMENDATIONS')
  })
})

describe('provenance + wiring invariants', () => {
  it('the 5×-CPA figure is labeled an industry heuristic (never Meta) everywhere it is prose', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/INDUSTRY HEURISTIC/i)
    expect(SYSTEM_PROMPT).toMatch(/industry heuristic/i)
    // The Meta-published figure stays asserted as Meta's:
    expect(MAXX_INSTRUCTIONS).toMatch(/~50 optimization events per ad set per 7 days.*Meta-published/i)
  })

  it('instructions mandate the two new tools', () => {
    expect(MAXX_INSTRUCTIONS).toContain('get_expert_knowledge')
    expect(MAXX_INSTRUCTIONS).toContain('get_recommendations')
  })

  it('makes Maxx accountable for the setup it designs and forbids configuration-only success claims', () => {
    expect(MAXX_INSTRUCTIONS).toMatch(/SETUP ACCOUNTABILITY/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/Maxx owns.*audience architecture.*creative strategy.*destination/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/failed or unknown audience/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/video-only/i)
    expect(MAXX_INSTRUCTIONS).toMatch(/cannot be called.*good/i)
  })

  it('both tools are registered and read-only (inherited by chat)', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    expect(names).toContain('get_expert_knowledge')
    expect(names).toContain('get_recommendations')
    const roNames = READ_ONLY_TOOL_DEFINITIONS.map((t) => t.name)
    expect(roNames).toContain('get_expert_knowledge')
    expect(roNames).toContain('get_recommendations')
  })
})
