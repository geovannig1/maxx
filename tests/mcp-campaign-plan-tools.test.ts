import { beforeEach, describe, expect, it, vi } from 'vitest'

// ADR-062: the MCP server stays read-only. The campaign and ad-set creation stubs are replaced by two
// READ tools: get_campaign_plans (what the owner drafted, its status) and preview_campaign_plan (a
// template draft, validated, NEVER stored, no model call). Creating, submitting and approving stay in
// the owner console.

const state = vi.hoisted(() => ({ writes: [] as string[], context: null as unknown, list: null as unknown }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: () => { const q: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = () => q; q.insert = () => { state.writes.push('insert'); return q }; q.update = () => { state.writes.push('update'); return q }; return q },
    rpc: (name: string) => { state.writes.push(`rpc:${name}`); return Promise.resolve({ data: null, error: null }) },
  }),
}))
vi.mock('@/lib/accounts/active-account', async () => ({
  ...(await vi.importActual<typeof import('@/lib/accounts/active-account')>('@/lib/accounts/active-account')),
  resolveOnlyActiveAccount: async () => ({ ok: true, account: { id: 'account-1', accountId: 'act_1', accountName: null } }),
}))
vi.mock('@/lib/campaigns/plan-context', () => ({ loadPlanContext: vi.fn(async () => state.context) }))
vi.mock('@/lib/campaigns/plan-repository', async () => ({
  ...(await vi.importActual<typeof import('@/lib/campaigns/plan-repository')>('@/lib/campaigns/plan-repository')),
  listPlans: vi.fn(async () => state.list),
}))
vi.mock('@/lib/ai', async () => ({
  ...(await vi.importActual<typeof import('@/lib/ai/errors')>('@/lib/ai/errors')),
  aiStatus: () => ({ state: 'on', provider: 'anthropic', family: 'anthropic', model: 'm' }),
  generateStructured: vi.fn(() => { throw new Error('the MCP preview never calls a model') }),
}))

const { TOOL_DEFINITIONS, WRITE_TOOLS, isMcpExposedTool, executeTool } = await import('@/mcp/tools')
const { context: validationContext } = await import('./_support/campaign-plan-fixtures')
const { getAdPlatform } = await import('@/lib/platforms/registry')

beforeEach(async () => {
  state.writes = []
  state.list = { ok: true, rows: [{ id: 'p1', title: 'Spring', status: 'pending_approval', version_id: 'v1', total_daily_budget: '$30.00' }] }
  state.context = {
    ok: true,
    context: {
      account: { id: 'account-1', platform: getAdPlatform('meta'), metaAccountId: 'act_1', currency: 'USD', timezone: 'America/New_York', pixelId: '111', pageId: '555' },
      draft: {
        currency: 'USD', today: '2026-11-08', pixelId: '111', pageId: '555', outcomeEvent: 'Purchase', landingHosts: ['studio.example'],
        defaultDestination: 'https://studio.example/book', audiences: [], copyBank: [],
        assets: [{ ref: 'A1', creativeId: '777', name: 'Existing', imageHash: null, videoId: null, thumbnailUrl: null, linkUrl: 'https://studio.example/', urlTags: null }],
        toMinor: (n: number) => Math.round(n * 100), minDailyMinor: () => 100,
      },
      validation: validationContext(),
      readiness: { landingHosts: ['studio.example'], creativeLinks: new Map(), audienceSizes: new Map(), outcomeEvent: 'Purchase' },
    },
  }
})

describe('MCP campaign plan tools (ADR-062)', () => {
  it('replaces the campaign and ad-set creation stubs with read tools the server exposes', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name)
    expect(names).not.toContain('create_paused_campaign_draft')
    expect(names).not.toContain('create_paused_adset_draft')
    for (const name of ['get_campaign_plans', 'preview_campaign_plan']) {
      expect(names).toContain(name)
      expect(WRITE_TOOLS.has(name)).toBe(false)
      expect(isMcpExposedTool(name)).toBe(true)
    }
    expect(isMcpExposedTool('create_paused_test_draft')).toBe(false)
  })

  it('lists plans with their status', async () => {
    expect(await executeTool('get_campaign_plans', {})).toMatchObject({ read_health: 'healthy', plans: [{ id: 'p1', status: 'pending_approval' }] })
  })

  it('previews a validated template draft, stores nothing and calls no model', async () => {
    const result = await executeTool('preview_campaign_plan', { goal: 'traffic', product: 'Studio rental', daily_budget: 20, countries: ['US'], start_date: '2026-11-10', use_ai: true }) as Record<string, unknown>
    expect(result).toMatchObject({ persisted: false, source: 'template', spec: { campaign: { objective: 'OUTCOME_TRAFFIC' } } })
    expect(Array.isArray(result.validation)).toBe(true)
    expect(Array.isArray(result.readiness)).toBe(true)
    expect(state.writes).toEqual([])
  })

  it('refuses an invalid brief without reading anything', async () => {
    expect(await executeTool('preview_campaign_plan', { goal: 'world_domination' })).toMatchObject({ error_code: 'INVALID_BRIEF' })
  })
})
