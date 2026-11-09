import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Regression: get_learnings.recent_outcomes was ungated — it returned every scored recommendation_outcome
// regardless of human-review status or account, and included estimate-only (GA4 attribution < 50%)
// lessons. That disagreed with patterns.ts (approved-only, account-scoped, estimate-only excluded). The
// MCP tool must now use the SAME gate so the two can never diverge.

type Call = [string, ...unknown[]]

function makeDb(results: Record<string, { data: unknown; error?: unknown }>) {
  const calls: Call[] = []
  let table = ''
  const builder: Record<string, unknown> = {
    from(t: string) { table = t; calls.push(['from', t]); return builder },
    select(c: string) { calls.push(['select', table, c]); return builder },
    eq(col: string, v: unknown) { calls.push(['eq', table, col, v]); return builder },
    not(col: string, op: string, v: unknown) { calls.push(['not', table, col, op, v]); return builder },
    in(col: string, v: unknown) { calls.push(['in', table, col, v]); return builder },
    order() { return builder },
    limit() { return builder },
    maybeSingle() { return Promise.resolve(results[table] ?? { data: null }) },
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(results[table] ?? { data: null, error: null }).then(resolve, reject)
    },
  }
  return { client: builder, calls }
}

async function loadGetLearnings(results: Record<string, { data: unknown; error?: unknown }>) {
  const { client, calls } = makeDb(results)
  vi.doMock('@/lib/supabase/admin', () => ({ getAdminClient: () => client }))
  const mod = await import('@/mcp/tools/learnings')
  return { getLearnings: mod.getLearnings, calls }
}

describe('getLearnings — recent_outcomes trust gate', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/supabase/admin') })

  it('scopes to the active account and filters to review_status=approved', async () => {
    const { getLearnings, calls } = await loadGetLearnings({
      learned_patterns: { data: [], error: null },
      ad_accounts: { data: [{ id: 'acct-1', account_id: 'act_100000000000011', account_name: null }] },
      recommendation_outcomes: { data: [] },
    })
    await getLearnings({})
    expect(calls).toContainEqual(['eq', 'recommendation_outcomes', 'ad_account_id', 'acct-1'])
    expect(calls).toContainEqual(['eq', 'recommendation_outcomes', 'review_status', 'approved'])
    expect(calls.some((call) => call[0] === 'from' && call[1] === 'learned_patterns')).toBe(false)
  })

  it('excludes estimate-only lessons and caps at 25', async () => {
    const rows = [
      { flag_type: 'winner', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: 'causal contribution', review_status: 'approved' },
      { flag_type: 'loser', metric_name: 'causal_incremental_contribution', outcome: 'failed', outcome_note: 'decisive (estimate-only: incomplete)', review_status: 'approved' },
      { flag_type: 'winner', metric_name: 'cpa', outcome: 'worked', outcome_note: 'legacy CPA', review_status: 'approved' },
      ...Array.from({ length: 30 }, (_, i) => ({ flag_type: 'scale_candidate', metric_name: 'causal_incremental_contribution', outcome: 'worked', outcome_note: `ok ${i}`, review_status: 'approved' })),
    ]
    const { getLearnings } = await loadGetLearnings({
      learned_patterns: { data: [], error: null },
      ad_accounts: { data: [{ id: 'acct-1', account_id: 'act_100000000000011', account_name: null }] },
      recommendation_outcomes: { data: rows },
    })
    const res = (await getLearnings({})) as { recent_outcomes: Array<{ outcome_note: string }> }
    expect(res.recent_outcomes.length).toBe(25)
    expect(res.recent_outcomes.some((r) => r.outcome_note.includes('estimate-only'))).toBe(false)
  })

  it('returns empty recent_outcomes when there is no active account', async () => {
    const { getLearnings } = await loadGetLearnings({
      learned_patterns: { data: [], error: null },
      ad_accounts: { data: null },
      recommendation_outcomes: { data: [{ flag_type: 'winner', outcome: 'worked', outcome_note: 'x', review_status: 'approved' }] },
    })
    const res = (await getLearnings({})) as { recent_outcomes: unknown[] }
    expect(res.recent_outcomes).toEqual([])
  })

  it('withholds all learned decision context when active-account ownership is ambiguous', async () => {
    const { getLearnings } = await loadGetLearnings({
      learned_patterns: {
        data: [{ dimension: 'audience', segment: 'mixed-account-pattern' }],
        error: null,
      },
      ad_accounts: {
        data: [
          { id: 'acct-1', account_id: 'act_100000000000011', account_name: null },
          { id: 'acct-2', account_id: 'act_100000000000012', account_name: null },
        ],
      },
      recommendation_outcomes: { data: [] },
    })

    const res = (await getLearnings({})) as {
      error_code?: string
      patterns: unknown[]
      recent_outcomes: unknown[]
    }
    expect(res).toMatchObject({
      error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      patterns: [],
      recent_outcomes: [],
    })
  })
})
