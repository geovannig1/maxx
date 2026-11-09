import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accountMode: 'ok' as 'ok' | 'ambiguous' | 'unavailable',
  historyReadError: false,
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (column: string, value: unknown) => {
        state.filters.push({ table, column, value })
        return chain
      }
      chain.order = () => chain
      chain.limit = () => chain
      chain.then = (resolve: (value: unknown) => unknown) => {
        if (table === 'ad_accounts') {
          const value = state.accountMode === 'ok'
            ? { data: [{ id: 'account-1', account_id: 'act_100000000000021', account_name: 'Example Studio' }], error: null }
            : state.accountMode === 'ambiguous'
              ? { data: [
                  { id: 'account-1', account_id: 'act_100000000000021' },
                  { id: 'account-2', account_id: 'act_100000000000022' },
                ], error: null }
              : { data: null, error: { message: 'account read failed' } }
          return Promise.resolve(value).then(resolve)
        }
        if (state.historyReadError) {
          return Promise.resolve({ data: null, error: { message: 'history read failed' } }).then(resolve)
        }
        if (table === 'creative_briefs') {
          return Promise.resolve({
            data: [{
              id: 'brief-legacy-1',
              title: 'READY TO PRODUCE: warm audience booking ad',
              audience_type: 'warm',
              hook: 'Book now before the weekend fills',
              cta_text: 'BOOK_NOW',
              concept: 'Use this exact production recipe',
              status: 'approved',
              created_at: '2026-07-01T00:00:00Z',
            }],
            error: null,
          }).then(resolve)
        }
        if (table === 'tests') {
          return Promise.resolve({
            data: [{
              id: 'test-legacy-1',
              test_name: 'Scale warm booking campaign',
              hypothesis: 'Warm audiences will book',
              audience_type: 'warm',
              budget_daily: 90,
              kill_rule: 'Kill above $120 CPA',
              keep_rule: 'Keep below $75 CPA',
              scale_rule: 'Scale below $55 CPA',
              status: 'running',
              created_at: '2026-07-02T00:00:00Z',
            }],
            error: null,
          }).then(resolve)
        }
        throw new Error(`Unexpected table: ${table}`)
      }
      return chain
    },
  }),
}))

import { getCreativeBriefs, getTestingBacklog } from '@/mcp/tools/briefs'
import { TOOL_DEFINITIONS } from '@/mcp/tools/index'
import BriefsPage from '@/app/(dashboard)/briefs/page'
// The audit-only legacy-test surface became the Experiments DESTINATION on 2026-08-31
// (7-destination target IA). `/performance/tests` is now a redirect shim, so importing it here
// would assert nothing about the page this test is actually about.
import TestsPage from '@/app/(dashboard)/experiments/page'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// account boundary, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('legacy brief and test-plan MCP surfaces require a verified CampaignPlan', () => {
  beforeEach(() => {
    state.accountMode = 'ok'
    state.historyReadError = false
    state.filters = []
  })

  it('returns only account-scoped audit identifiers, never an actionable brief or test recipe', async () => {
    const [briefs, tests] = await Promise.all([
      getCreativeBriefs({ limit: 20 }),
      getTestingBacklog({ limit: 20 }),
    ])
    const copy = serialized({ briefs, tests })

    expect(briefs).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'healthy',
      actionable: false,
      briefs: [],
      historical_record_count: 1,
    })
    expect(tests).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'healthy',
      actionable: false,
      tests: [],
      historical_record_count: 1,
    })
    expect(copy).toContain('brief-legacy-1')
    expect(copy).toContain('test-legacy-1')
    expect(state.filters).toEqual(expect.arrayContaining([
      { table: 'creative_briefs', column: 'ad_account_id', value: 'account-1' },
      { table: 'tests', column: 'ad_account_id', value: 'account-1' },
    ]))
    expect(copy).not.toMatch(/warm audience|BOOK_NOW|Book now|production recipe|\$\s?\d|budget_daily|kill_rule|keep_rule|scale_rule/i)
  })

  it('fails closed on ambiguous account ownership and never queries cross-account artifacts as current', async () => {
    state.accountMode = 'ambiguous'

    const result = await getCreativeBriefs({ limit: 20 })

    expect(result).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'unavailable',
      actionable: false,
      error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      briefs: [],
      historical_records: [],
    })
  })

  it('fails closed when legacy history cannot be read instead of returning an empty/current-looking backlog', async () => {
    state.historyReadError = true

    const result = await getTestingBacklog({ limit: 20 })

    expect(result).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'unavailable',
      actionable: false,
      error_code: 'LEGACY_TEST_HISTORY_UNAVAILABLE',
      tests: [],
      historical_records: [],
    })
  })

  it('advertises both MCP tools as historical audit reads, not production/backlog recipes', () => {
    const briefs = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_creative_briefs')!
    const tests = TOOL_DEFINITIONS.find((tool) => tool.name === 'get_testing_backlog')!

    expect(briefs.description).toMatch(/CAMPAIGN_PLAN_REQUIRED/)
    expect(tests.description).toMatch(/CAMPAIGN_PLAN_REQUIRED/)
    expect(Object.keys(briefs.inputSchema.properties ?? {})).toEqual(['limit'])
    expect(Object.keys(tests.inputSchema.properties ?? {})).toEqual(['limit'])
    expect(`${briefs.description} ${tests.description}`).not.toMatch(/including.*CTA|includes.*budget|kill\/keep\/scale/i)
  })
})

describe('legacy brief and test-plan owner pages are audit-only', () => {
  beforeEach(() => {
    state.accountMode = 'ok'
    state.historyReadError = false
    state.filters = []
  })

  it('renders owner-facing audit-only status without hooks, audiences, CTAs, budgets, or decision rules', async () => {
    const [briefsPage, testsPage] = await Promise.all([BriefsPage(), TestsPage()])
    const html = renderToStaticMarkup(<>{briefsPage}{testsPage}</>)

    expect(html).toMatch(/Read-only legacy briefs|CAMPAIGN_PLAN_REQUIRED/)
    expect(html).toMatch(/legacy .*retained|audit/i)
    expect(html).not.toMatch(/warm audience|BOOK_NOW|Book now|production recipe|\$\s?\d|Kill if|ready to produce|what to try next/i)
  })

  it('renders account ambiguity as unavailable, never as an empty healthy backlog', async () => {
    state.accountMode = 'ambiguous'

    const html = renderToStaticMarkup(await BriefsPage())

    expect(html).toMatch(/Read-only legacy briefs/)
    expect(html).toMatch(/Governed blocked status/)
    expect(html).toMatch(/ACTIVE_ACCOUNT_AMBIGUOUS/)
    expect(html).toMatch(/unavailable/i)
    expect(html).not.toMatch(/No briefs yet|ready to produce/i)
  })
})
