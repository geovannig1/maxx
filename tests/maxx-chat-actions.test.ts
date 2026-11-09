import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ADR-062 §5: Ask Maxx runs three owner actions as SINK tools that end the turn with a card: copy
// variants (scored, blocked ones withheld), a campaign plan DRAFT, and a PENDING change proposal from a
// governed decision. The chat never approves or applies anything; write tools stay refused; numbers
// in prose still come only from governed claims (action text is server-composed and number-free).

const state = vi.hoisted(() => ({
  responses: [] as unknown[],
  requests: [] as Array<{ tools?: Array<{ name: string }>; system?: string }>,
  generateCopy: vi.fn(),
  draft: vi.fn(),
  propose: vi.fn(),
  review: vi.fn(),
  executePlan: vi.fn(),
  decisions: [] as unknown[],
}))

vi.mock('@/lib/ai', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ai/errors')>('@/lib/ai/errors')),
  aiStatus: () => ({ state: 'on', provider: 'anthropic', family: 'anthropic', model: 'm' }),
  parseJsonAnswer: (t: string) => JSON.parse(t),
  completeTurn: vi.fn(async (request: { tools?: Array<{ name: string }>; system?: string }) => {
    state.requests.push(request)
    return state.responses.shift()
  }),
}))
vi.mock('@/mcp/instructions', () => ({ MAXX_CHAT_SYSTEM: 'BASE MAXX PROMPT' }))
vi.mock('@/mcp/tools/index', () => ({
  READ_ONLY_TOOL_DEFINITIONS: [{ name: 'get_account_summary', description: 'Read.', inputSchema: { type: 'object', properties: {} } }],
  WRITE_TOOLS: new Set(['adjust_budget', 'pause_ad']),
  executeTool: vi.fn(async () => ({ available: true })),
}))
vi.mock('@/lib/maxx/governed-audit-runtime', () => ({
  gatherGovernedAuditEvidence: vi.fn(async () => ({ consulted: [], claims: [], requiredClaimIds: [], persistedFinalActionDecisions: state.decisions })),
}))
vi.mock('@/lib/maxx/chat-turn-context', async () => ({
  ...(await vi.importActual<typeof import('@/lib/maxx/chat-turn-context')>('@/lib/maxx/chat-turn-context')),
  warehouseClosedThrough: async () => '2026-11-07',
}))
vi.mock('@/lib/creative/copy-generator', () => ({ generateCopy: state.generateCopy }))
vi.mock('@/lib/campaigns/plan-repository', () => ({ draftCampaignPlan: state.draft }))
vi.mock('@/lib/writes/owner-changes', () => ({ proposeChangeFromDecision: state.propose }))
vi.mock('@/lib/writes/change-review', () => ({ reviewChangeRequest: state.review }))
vi.mock('@/lib/campaigns/plan-executor', () => ({ executeCampaignPlanChange: state.executePlan }))

process.env.MAXX_CHAT_ENABLED = 'true'
const { runMaxxChat } = await import('@/lib/maxx/chat')

const OWNER = 'owner-user-id'
const DECISION = '00000000-0000-4000-8000-00000000de01'
const toolTurn = (name: string, input: Record<string, unknown>, extra: Array<{ name: string; input: Record<string, unknown> }> = []) => ({
  stop: 'tool_use', text: '', toolCalls: [{ id: 'c1', name, input }, ...extra.map((e, i) => ({ id: `c${i + 2}`, ...e }))],
  assistant: { role: 'assistant', text: '', toolCalls: [] }, provider: 'anthropic', family: 'anthropic', model: 'm', usage: { inputTokens: 1, outputTokens: 1 },
})
const ask = (q: string, options?: { ownerUserId?: string }) => runMaxxChat([{ role: 'user', content: q }], options)
const variant = (angle: string, text: string, status: 'ready' | 'review' | 'blocked') => ({
  hook: text, primary_text: text, headline: 'Studio by the hour', description: '', cta: 'BOOK_NOW', angle, rationale: '', status,
  score: { score: status === 'blocked' ? 40 : 90, publishable: status !== 'blocked', findings: [] },
})

beforeEach(() => {
  state.responses = []
  state.requests = []
  state.decisions = []
  for (const fn of [state.generateCopy, state.draft, state.propose, state.review, state.executePlan]) fn.mockReset()
})

describe('Ask Maxx actions (ADR-062)', () => {
  it('offers the action tools only to the signed-in owner, and never an approve or apply tool', async () => {
    state.responses = [toolTurn('write_copy_variants', { product: 'Studio rental', goal: 'bookings', count: 2 })]
    state.generateCopy.mockResolvedValue({ status: 'ok', variants: [], rejected: [], grounding: {}, model: {} })
    await ask('write hooks', { ownerUserId: OWNER })
    const names = state.requests[0].tools?.map((t) => t.name) ?? []
    expect(names).toEqual(expect.arrayContaining(['write_copy_variants', 'draft_campaign_plan', 'propose_decision_change']))
    expect(names.some((n) => /approve|apply|execute|activate/.test(n))).toBe(false)
    state.responses = [{ stop: 'end_turn', text: 'prose', toolCalls: [], assistant: { role: 'assistant', text: 'prose', toolCalls: [] } }, { stop: 'end_turn', text: '{}', toolCalls: [], assistant: { role: 'assistant', text: '{}', toolCalls: [] } }]
    await ask('hello')
    expect(state.requests.at(-1)?.tools?.map((t) => t.name)).not.toContain('write_copy_variants')
  })

  it('returns scored copy variants as a card and withholds any the scorer blocks', async () => {
    state.responses = [toolTurn('write_copy_variants', { product: 'Studio rental', goal: 'bookings', audience_temperature: 'cold', count: 3 })]
    state.generateCopy.mockResolvedValue({
      status: 'ok', rejected: [], grounding: {}, model: {},
      variants: [variant('offer', 'Book a bright studio by the hour.', 'ready'), variant('ugc', 'The best studio in the world, guaranteed.', 'blocked')],
    })
    const result = await ask('write 5 hooks for our summer sale', { ownerUserId: OWNER })
    expect(state.generateCopy).toHaveBeenCalledWith(expect.objectContaining({ product: 'Studio rental', goal: 'bookings', variants: 3, audience: { temperature: 'cold', description: '' } }))
    expect(result.cards).toEqual([expect.objectContaining({ kind: 'copy', withheld: 1, variants: [expect.objectContaining({ primary_text: 'Book a bright studio by the hour.', status: 'ready' })] })])
    expect(JSON.stringify(result.cards)).not.toContain('guaranteed')
    // The lead is server-composed and number-free; the standard governed disclosure follows it.
    expect(result.text.split('\n\n')[0]).toMatch(/^Here are copy variants/)
    expect(result.text.split('\n\n')[0]).not.toMatch(/\d/)
    expect(result.availability).toBe('available')
  })

  it('drafts a plan from the owner\'s words, links it for review, and asks instead of guessing a missing budget', async () => {
    state.responses = [toolTurn('draft_campaign_plan', { goal: 'sales', product: 'Studio rental', daily_budget: 40, countries: ['us'], start_date: '2026-11-12', status: 'ACTIVE' })]
    state.draft.mockResolvedValue({ http: 201, body: { plan_id: 'p1', version_id: 'v1', ok: true, source: 'template', summary: { name: 'Studio', objective: 'OUTCOME_SALES', daily_budget: '$40.00', ad_sets: 1, ads: 3, new_creatives: 3 }, validation: [], readiness: [{ id: 'budget', label: 'Budget sanity', status: 'ok', detail: 'x' }], notes: [] } })
    const result = await ask('draft a prospecting campaign for studio rental with $40/day in the US', { ownerUserId: OWNER })
    expect(state.draft).toHaveBeenCalledWith(expect.objectContaining({ goal: 'sales', daily_budget: 40, countries: ['US'], start_date: '2026-11-12' }), { ownerUserId: OWNER })
    expect(JSON.stringify(state.draft.mock.calls[0][0])).not.toContain('ACTIVE')
    expect(result.cards?.[0]).toMatchObject({ kind: 'plan', href: '/campaigns/plans/p1', daily_budget: '$40.00', blockers: 0 })
    state.responses = [toolTurn('draft_campaign_plan', { goal: 'sales', product: 'Studio rental', countries: ['US'] })]
    const missing = await ask('draft a campaign', { ownerUserId: OWNER })
    expect(state.draft).toHaveBeenCalledTimes(1)
    expect(missing.cards?.[0]).toMatchObject({ kind: 'refusal', code: 'NEEDS_DAILY_BUDGET' })
  })

  it('proposes a PENDING change only from a governed decision, without an override, and never approves it', async () => {
    state.decisions = [{ id: DECISION, persisted: true, final: true, record_type: 'action_decisions', policy_version: 5, action_kind: 'budget_scale', authority_tier: 'owner_review', approval_state: 'not_requested', lineage: { source_kind: 'recommendation', source_id: 'r1' } }]
    state.responses = [toolTurn('propose_decision_change', { action_decision_id: DECISION, new_daily_budget: 45, confirm_override: true })]
    state.propose.mockResolvedValue({ status: 'PENDING_APPROVAL', http: 201, change_request_id: 'cr1', preview: 'Raise ad set "Warm" daily budget.', risk_level: 'high', message: 'Change proposed.' })
    const result = await ask('propose the budget change you recommended', { ownerUserId: OWNER })
    expect(state.propose).toHaveBeenCalledWith(DECISION, OWNER, { actor: 'owner (Ask Maxx)', params: { new_daily_budget: 45 } })
    expect(result.cards?.[0]).toMatchObject({ kind: 'approval', change_request_id: 'cr1', href: '/changes', status: 'PENDING_APPROVAL' })
    expect(state.review).not.toHaveBeenCalled()
    expect(state.executePlan).not.toHaveBeenCalled()

    state.responses = [toolTurn('propose_decision_change', { action_decision_id: '00000000-0000-4000-8000-0000000bad01', new_daily_budget: 45 })]
    const forged = await ask('propose it', { ownerUserId: OWNER })
    expect(state.propose).toHaveBeenCalledTimes(1)
    expect(forged.cards?.[0]).toMatchObject({ kind: 'refusal', code: 'DECISION_NOT_SHOWN' })
  })

  it('refuses a write tool and two actions in one turn', async () => {
    state.responses = [toolTurn('adjust_budget', { adset_id: '1', new_daily_budget: 99 })]
    const write = await ask('raise the budget now', { ownerUserId: OWNER })
    expect(write.availability).toBe('unavailable')
    expect(write.text).toMatch(/write-capable tool was refused/i)
    state.responses = [toolTurn('write_copy_variants', { product: 'Studio', goal: 'bookings' }, [{ name: 'draft_campaign_plan', input: { goal: 'sales' } }])]
    const both = await ask('do everything', { ownerUserId: OWNER })
    expect(both.cards?.[0]).toMatchObject({ kind: 'refusal', code: 'ONE_ACTION_PER_TURN' })
    expect(state.generateCopy).not.toHaveBeenCalled()
    expect(state.draft).not.toHaveBeenCalled()
  })

  it('no chat module can reach the approval or execution path', () => {
    for (const file of ['src/lib/maxx/chat.ts', 'src/lib/maxx/chat-actions.ts', 'src/app/api/maxx/chat/route.ts']) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/change-review|plan-executor|writes\/executor|demo-executor|reviewChangeRequest|executeApprovedChange|executeCampaignPlanChange|submitPlanForApproval/)
    }
  })
})
