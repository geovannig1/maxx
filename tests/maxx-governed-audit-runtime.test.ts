import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GOLDEN_QUESTIONS } from '@/lib/eval/golden-questions'
import { PRIMARY_TOOL_DEFINITIONS } from '@/mcp/tools/tool-definitions-primary'
import { SECONDARY_TOOL_DEFINITIONS } from '@/mcp/tools/tool-definitions-secondary'

const state = vi.hoisted(() => ({
  calls: [] as string[],
  args: {} as Record<string, Record<string, unknown>>,
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => ({ ok: true, account: { id: 'account-1' } })),
}))
vi.mock('@/mcp/tools/performance-cockpit', () => ({
  getPerformanceCockpit: vi.fn(async () => {
    state.calls.push('get_performance_cockpit')
    return { claims: [] }
  }),
}))
vi.mock('@/lib/diagnostics/launch-performance', () => ({
  diagnoseLaunchPerformance: vi.fn(async () => {
    state.calls.push('diagnose_ad_performance')
    return { conversions: { meta_modelled_bookings: 0 }, adsets_detail: [], audiences: [] }
  }),
}))
vi.mock('@/mcp/tools/reconciliation', () => ({
  getReconciliation: vi.fn(async (args: Record<string, unknown>) => {
    state.calls.push('get_reconciliation')
    state.args.get_reconciliation = args
    return { ga4_available: false }
  }),
}))
vi.mock('@/mcp/tools/economics', () => ({
  getEconomics: vi.fn(async (args: Record<string, unknown>) => {
    state.calls.push('get_economics')
    state.args.get_economics = args
    return {
      business: { confirmed_appointments: null, outcome_recorded_checkout_revenue: null },
      paid: { cpa: null, revenue_roas: null }, profit_view: { daily_budget_ceiling: 100 },
    }
  }),
}))
vi.mock('@/mcp/tools/operating-mode', () => ({
  getOperatingMode: vi.fn(async () => {
    state.calls.push('get_operating_mode')
    return { mode: { canRecommendBudgetScale: false, budgetVerdict: 'insufficient_evidence' } }
  }),
}))
vi.mock('@/mcp/tools/creative-insights', () => ({
  getCreativeInsights: vi.fn(async (args: Record<string, unknown>) => {
    state.calls.push('get_creative_insights')
    state.args.get_creative_insights = args
    return {
      period: { start: args.start_date, end: args.end_date },
      format_mix: { total_creatives: 2, shares: [{ format: 'video' }, { format: 'static' }] },
    }
  }),
}))
vi.mock('@/mcp/tools/creative-fatigue', () => ({
  getCreativeFatigue: vi.fn(async () => {
    state.calls.push('get_creative_performance')
    return { available: false }
  }),
}))
vi.mock('@/mcp/tools/expert-knowledge', () => ({
  getExpertKnowledge: vi.fn(async () => {
    state.calls.push('get_expert_knowledge')
    return { prescriptions: [] }
  }),
}))
vi.mock('@/mcp/tools/playbook', () => ({
  getPlaybookTool: vi.fn(() => {
    state.calls.push('get_playbook')
    return { action_guidance_status: 'withheld' }
  }),
}))
vi.mock('@/mcp/tools/decision-history', () => ({
  getDecisionHistory: vi.fn(async () => {
    state.calls.push('get_decision_history')
    return { recommendation_decisions: [] }
  }),
}))
vi.mock('@/lib/recommendations/store', () => ({
  readOpenRecommendations: vi.fn(async () => {
    state.calls.push('get_recommendations')
    return {
      health: 'healthy', recommendations: [], visibleCount: 0, quarantinedCount: 0, reasons: [],
    }
  }),
}))

import { gatherGovernedAuditEvidence } from '@/lib/maxx/governed-audit-runtime'

describe('internal governed-audit routing', () => {
  beforeEach(() => {
    state.calls = []
    state.args = {}
  })

  it.each(GOLDEN_QUESTIONS.map((question) => [question.id, question.fallback_prompt] as const))(
    '%s genuinely executes every required evidence lookup',
    async (id, question) => {
      const result = await gatherGovernedAuditEvidence({
        question,
        closedThrough: '2026-08-20',
      })
      const required = GOLDEN_QUESTIONS.find((item) => item.id === id)!.required_tools
      for (const tool of required) {
        expect(state.calls).toContain(tool)
        expect(result.consulted.map((lookup) => lookup.tool)).toContain(tool)
      }
    },
  )

  it('keeps reconciliation and economics on the same closed 30-day audit window', async () => {
    const ownerQuestion = GOLDEN_QUESTIONS.find((question) => question.id === 'q1-flagship-diagnosis')!
    await gatherGovernedAuditEvidence({
      question: ownerQuestion.fallback_prompt,
      closedThrough: '2026-08-25',
    })

    const expected = { start_date: '2026-07-27', end_date: '2026-08-25' }
    expect(state.args.get_reconciliation).toEqual(expected)
    expect(state.args.get_economics).toEqual(expected)
  })

  it('keeps creative evidence on the same closed 30-day audit window', async () => {
    const creativeQuestion = GOLDEN_QUESTIONS.find((question) => question.id === 'q3-creative-quality')!
    const result = await gatherGovernedAuditEvidence({
      question: creativeQuestion.fallback_prompt,
      closedThrough: '2026-08-25',
    })

    expect(state.args.get_creative_insights).toEqual({
      start_date: '2026-07-27',
      end_date: '2026-08-25',
    })
    expect(result.claims.find((claim) => claim.metricKey === 'meta.creative.format_mix')?.window)
      .toMatchObject({
        start: '2026-07-27',
        end: '2026-08-25',
        basis: 'closed_account_days',
      })
  })

  it.each(['get_reconciliation', 'get_economics', 'get_creative_insights'])(
    '%s exposes the governed explicit-window inputs to Maxx',
    (name) => {
      const definition = [...PRIMARY_TOOL_DEFINITIONS, ...SECONDARY_TOOL_DEFINITIONS]
        .find((tool) => tool.name === name)!
      expect(definition.inputSchema.properties).toHaveProperty('start_date')
      expect(definition.inputSchema.properties).toHaveProperty('end_date')
    },
  )
})
