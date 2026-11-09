import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiEnv } from './helpers/ai-stub'

/**
 * "How are the ads doing right now?" was withheld as action-shaped language. The question routes to the
 * `general` audit focus, whose required packet includes `maxx.audit.decision.scale_authority`; its
 * server-authored value opened with "Scale" right after the rendered " — " separator, which the
 * action-language guard reads as an imperative at a clause start. This drives the REAL pipeline: the real
 * governed-audit gather and build, renderer, governance and action-language guard. Only the account
 * readers and the model (at the SDK) are stubbed, and the model makes a realistic selection.
 */
const state = vi.hoisted(() => ({
  create: vi.fn(),
  mode: { canRecommendBudgetScale: false, budgetVerdict: 'insufficient_evidence' } as Record<string, unknown>,
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: state.create }
    beta = { messages: { create: state.create } }
  },
}))
vi.mock('@/mcp/instructions', () => ({ MAXX_CHAT_SYSTEM: 'BASE MAXX PROMPT' }))
vi.mock('@/mcp/tools/index', () => ({ READ_ONLY_TOOL_DEFINITIONS: [], WRITE_TOOLS: new Set(), executeTool: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => {
  const read = async () => ({ data: [{ date_start: '2026-08-20' }], error: null })
  const chain = { order: () => ({ limit: read }), lte: () => ({ order: () => ({ limit: read }) }) }
  return { getAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ eq: () => chain }) }) }) }) }
})
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1' } }),
}))
vi.mock('@/mcp/tools/performance-cockpit', () => ({ getPerformanceCockpit: async () => ({ claims: [spendClaim()] }) }))
vi.mock('@/mcp/tools/reconciliation', () => ({ getReconciliation: async () => ({ ga4_available: false }) }))
vi.mock('@/mcp/tools/economics', () => ({
  getEconomics: async () => ({ business: {}, paid: { cpa: null, revenue_roas: null }, profit_view: { daily_budget_ceiling: 100 } }),
}))
vi.mock('@/mcp/tools/operating-mode', () => ({ getOperatingMode: async () => ({ mode: state.mode }) }))
vi.mock('@/lib/recommendations/store', () => ({
  readOpenRecommendations: async () => ({ health: 'healthy', recommendations: [], visibleCount: 0, quarantinedCount: 0, reasons: [] }),
}))

import { createMetricClaim } from '@/lib/cockpit/contracts'
import { runMaxxChat } from '@/lib/maxx/chat'
import { governMaxxAnswer } from '@/lib/maxx/chat-governance'
import { gatherGovernedAuditEvidence } from '@/lib/maxx/governed-audit-runtime'

const QUESTION = 'How are the ads doing right now?'
const WITHHELD = 'withheld the generated answer because it contained action-shaped language'

function spendClaim() {
  return createMetricClaim({
    claimId: 'cockpit.meta.spend:account-1:2026-07-22:2026-08-20', metricKey: 'meta.spend', label: 'Meta spend', value: 1812.92,
    unit: 'money', formula: null, definitionVersion: 1,
    source: { system: 'meta', role: 'delivery_truth', head: 'meta-head', evidencePlane: 'meta_delivery' },
    entity: { level: 'account', id: 'account-1' }, attributionScope: 'none',
    window: { start: '2026-07-22', end: '2026-08-20', basis: 'closed_account_days', timezone: 'America/New_York' },
    comparison: { method: 'none', window: null }, asOf: '2026-08-21T12:00:00.000Z',
    availability: { state: 'available', blockerCodes: [] },
    coverage: { state: 'complete', numerator: 30, denominator: 30 },
    maturity: { state: 'settled', matureThrough: '2026-08-20' },
    freshness: { state: 'fresh', observedAt: '2026-08-21T12:00:00.000Z', maxAgeHours: 24 },
    setupFingerprint: null, authority: { state: 'context', policyVersion: 'meta-spend-v1' },
    measurementKind: 'measured', inputClaimIds: [],
  })
}

/** The model's selection for the question: spend, the scaling status and the recommendation feed. */
async function modelSelects() {
  const packet = await gatherGovernedAuditEvidence({ question: QUESTION, closedThrough: '2026-08-20' })
  const id = (key: string) => packet.claims.find((claim) => claim.metricKey === key)!.claimId
  const scale = id('decision.scale_authority')
  expect(packet.requiredClaimIds).toContain(scale)
  state.create.mockResolvedValueOnce({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'brief-1', name: 'submit_answer_brief', input: {
      summary: 'governed_claims',
      observations: [{ claim_ids: [id('meta.spend')] }, { claim_ids: [scale, id('decision.current_recommendations')] }],
      action_decision_ids: [], unavailable_claim_ids: [], next_check: null,
    } }],
  })
}

describe('a basic performance question through the governed chat pipeline', () => {
  beforeEach(() => {
    vi.stubEnv('MAXX_CHAT_ENABLED', 'true')
    useAiEnv({ ANTHROPIC_API_KEY: 'test-key' })
    state.create.mockReset()
    state.mode = { canRecommendBudgetScale: false, budgetVerdict: 'insufficient_evidence' }
  })
  afterEach(() => vi.unstubAllEnvs())

  // Every verdict the claim can render (governed-audit.ts), plus an unknown one, with and without scale.
  const VERDICTS = ['scale_candidate', 'healthy_signal_review', 'loss_signal_review', 'conflicting_signals_review',
    'hold_watch', 'insufficient_evidence', 'not_a_verdict']
  it.each(VERDICTS.flatMap((budgetVerdict) => [true, false].map((canRecommendBudgetScale) =>
    [`${budgetVerdict}, scale ${canRecommendBudgetScale ? 'allowed' : 'not allowed'}`, { canRecommendBudgetScale, budgetVerdict }] as const)),
  )('answers, citing the scaling status, for %s', async (_label, mode) => {
    state.mode = mode
    await modelSelects()
    const answer = await runMaxxChat([{ role: 'user', content: QUESTION }])
    expect(answer.text).not.toContain(WITHHELD)
    expect(answer.text).toContain('Governed scaling status')
    expect(answer.text).toContain('Meta spend')
  })
})

describe('the action-language guard still withholds genuine instructions', () => {
  const EVIDENCE = [{
    tool: 'get_performance_cockpit', sources: ['Meta' as const], dateWindow: '2026-07-22 to 2026-08-20', scope: 'account',
    observedAt: '2026-08-21T12:00:00.000Z', freshness: 'fresh', availability: 'returned' as const, caveat: 'none',
  }]

  it.each([
    '- **Governed scaling status — Scale this ad set up by 20% today**',
    'Spend came to $1,812.92. Scale the budget to $80 a day.',
    'Meta spend is steady — increase budget on the warm ad set.',
    'Spend is steady; pause the cold ad set.',
    'Switch the optimization event to Purchase.',
  ])('withholds %j', (text) => {
    expect(governMaxxAnswer(text, EVIDENCE, 'server_composed')).toContain(WITHHELD)
  })
})
