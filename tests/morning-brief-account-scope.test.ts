import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  activeResolution: { ok: true, account: { id: 'account-a', accountName: 'Studio A' } } as
    | { ok: true; account: { id: string; accountName: string | null } }
    | { ok: false; reason: 'not_found' | 'ambiguous' | 'unavailable' },
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  errors: {} as Record<string, { message: string } | null>,
  calls: [] as Array<{ table: string; method: string; column?: string; value?: unknown }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' } } }) },
  })),
}))

vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: vi.fn(async () => state.activeResolution),
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      let rows = [...(state.rows[table] ?? [])]
      let limit: number | null = null
      let countRequested = false
      let head = false
      const response = () => {
        const selected = limit === null ? rows : rows.slice(0, limit)
        return {
          data: head ? null : selected,
          error: state.errors[table] ?? null,
          count: countRequested ? selected.length : null,
        }
      }
      const builder = {
        select: (_columns?: string, options?: { count?: string; head?: boolean }) => {
          countRequested = options?.count === 'exact'
          head = options?.head === true
          return builder
        },
        eq: (column: string, value: unknown) => {
          state.calls.push({ table, method: 'eq', column, value })
          if (column !== 'report_date') rows = rows.filter((row) => row[column] === value)
          return builder
        },
        in: (column: string, values: unknown[]) => {
          state.calls.push({ table, method: 'in', column, value: values })
          rows = rows.filter((row) => values.includes(row[column]))
          return builder
        },
        gte: (column: string, value: unknown) => {
          state.calls.push({ table, method: 'gte', column, value })
          rows = rows.filter((row) => typeof row[column] === 'string' && String(row[column]) >= String(value))
          return builder
        },
        order: () => builder,
        limit: (value: number) => {
          limit = value
          return builder
        },
        maybeSingle: async () => {
          const result = response()
          return { data: Array.isArray(result.data) ? (result.data[0] ?? null) : null, error: result.error }
        },
        then: (
          resolve: (value: ReturnType<typeof response>) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(response()).then(resolve, reject),
      }
      return builder
    },
  }),
}))

describe('morning brief account scope', () => {
  beforeEach(() => {
    // the owner gate fails closed without OWNER_EMAIL, in development too.
    vi.stubEnv('OWNER_EMAIL', 'owner@example.com')
    state.activeResolution = { ok: true, account: { id: 'account-a', accountName: 'Studio A' } }
    state.errors = {}
    state.calls = []
    state.rows = {
      daily_reports: [
        { ad_account_id: 'account-b', report_date: 'ignored', total_spend: 999, total_bookings: 99 },
        { ad_account_id: 'account-a', report_date: 'ignored', total_spend: 72, total_bookings: 2 },
      ],
      flags: [
        { ad_account_id: 'account-b', is_active: true, flag_type: 'loser', adset_id: 'adset-b', meta_adset_id: 'meta-b' },
        { ad_account_id: 'account-a', is_active: true, flag_type: 'watchlist', adset_id: 'adset-a', meta_adset_id: 'meta-a' },
      ],
      adsets: [
        { id: 'adset-b', ad_account_id: 'account-b', adset_name: 'Other Account Ad Set' },
        { id: 'adset-a', ad_account_id: 'account-a', adset_name: 'Studio A Ad Set' },
      ],
      audit_tasks: [
        { ad_account_id: 'account-b', status: 'open', priority: 'urgent', recommendation: 'Increase the other account budget' },
        { ad_account_id: 'account-a', status: 'open', priority: 'urgent', recommendation: 'Review this account evidence' },
      ],
      competitor_sources: [
        { id: 'source-b', ad_account_id: 'account-b' },
        { id: 'source-a', ad_account_id: 'account-a' },
      ],
      competitor_ads: [
        { competitor_id: 'source-b', page_name: 'Other Competitor', created_at: '2999-01-01T00:00:00.000Z' },
        { competitor_id: 'source-a', page_name: 'Studio A Competitor', created_at: '2999-01-01T00:00:00.000Z' },
      ],
      expert_insights: [
        { ad_account_id: 'account-b', applies_to_account: true, review_status: 'approved', title: 'Other trend', why_it_applies: 'Other account', expert_sources: { name: 'Other source' } },
        { ad_account_id: 'account-a', applies_to_account: true, review_status: 'approved', title: 'Studio trend', why_it_applies: 'Observed studio context', expert_sources: { name: 'Studio source' } },
      ],
      campaigns: [
        { ad_account_id: 'account-b', status: 'PAUSED' },
        { ad_account_id: 'account-a', status: 'ACTIVE' },
      ],
    }
  })

  it('excludes another account from every owner-facing brief section', async () => {
    const { GET } = await import('@/app/api/morning-brief/route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      account: { id: 'account-a' },
      meta_delivery: { spend: 72, modelled_results: 2, action_authority: 'diagnostic_only' },
      top_observation: { entity_name: 'Studio A Ad Set', action_authority: 'diagnostic_only' },
      new_competitor_ads: 1,
      competitor_alert: 'Studio A Competitor published 1 new ad',
      trend_signal: { title: 'Studio trend', source: 'Studio source', action_authority: 'diagnostic_only' },
      campaigns_status: 'active',
    })
    expect(JSON.stringify(body)).not.toContain('account-b')
    expect(JSON.stringify(body)).not.toContain('Other Account')

    for (const table of ['daily_reports', 'flags', 'adsets', 'audit_tasks', 'competitor_sources', 'expert_insights', 'campaigns']) {
      expect(state.calls).toContainEqual({ table, method: 'eq', column: 'ad_account_id', value: 'account-a' })
    }
    expect(state.calls).toContainEqual({ table: 'competitor_ads', method: 'in', column: 'competitor_id', value: ['source-a'] })
  })

  it('fails distinctly when active-account ownership is ambiguous', async () => {
    state.activeResolution = { ok: false, reason: 'ambiguous' }
    const { GET } = await import('@/app/api/morning-brief/route')
    const response = await GET()

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ACTIVE_ACCOUNT_AMBIGUOUS' })
    expect(state.calls).toEqual([])
  })

  it('scopes the alternate ad entity-name lookup to the active account', async () => {
    state.rows.flags = [
      { ad_account_id: 'account-a', is_active: true, flag_type: 'creative_refresh', ad_id: 'ad-a', meta_ad_id: 'meta-ad-a' },
    ]
    state.rows.ads = [
      { id: 'ad-a', ad_account_id: 'account-b', ad_name: 'Wrong account ad' },
      { id: 'ad-a', ad_account_id: 'account-a', ad_name: 'Studio A ad' },
    ]
    const { GET } = await import('@/app/api/morning-brief/route')
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.top_observation.entity_name).toBe('Studio A ad')
    expect(state.calls).toContainEqual({ table: 'ads', method: 'eq', column: 'ad_account_id', value: 'account-a' })
  })

  it('reports a scoped read failure as unavailable instead of a healthy empty brief', async () => {
    state.errors.daily_reports = { message: 'database unavailable' }
    const { GET } = await import('@/app/api/morning-brief/route')
    const response = await GET()

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'MORNING_BRIEF_READ_FAILED', section: 'daily_reports' })
  })
})
