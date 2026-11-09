import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  accountError: null as { message: string } | null,
  fromCalls: [] as string[],
  updates: [] as Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }>,
  upserts: [] as Array<{ table: string; row: Row }>,
  rpc: vi.fn(async () => ({ data: { id: 'change-b' }, error: null })),
  execute: vi.fn(async () => ({ status: 'EXECUTED_VERIFIED' })),
  recompute: vi.fn(async () => undefined),
}))

function filteredRows(table: string, filters: Array<[string, unknown]>, limit: number): Row[] {
  return (state.rows[table] ?? [])
    .filter((row) => filters.every(([column, value]) => row[column] === value))
    .slice(0, limit)
}

function query(table: string) {
  const filters: Array<[string, unknown]> = []
  let limit = Number.POSITIVE_INFINITY
  let operation: 'select' | 'update' | 'upsert' = 'select'
  let payload: Row = {}
  let recorded = false

  const result = () => {
    if (operation === 'update' && !recorded) {
      recorded = true
      state.updates.push({ table, patch: payload, filters: [...filters] })
    }
    if (operation === 'upsert' && !recorded) {
      recorded = true
      state.upserts.push({ table, row: payload })
    }
    return {
      data: filteredRows(table, filters, limit),
      error: table === 'ad_accounts' ? state.accountError : null,
    }
  }

  const builder = {
    select: () => builder,
    update: (patch: Row) => {
      operation = 'update'
      payload = patch
      return builder
    },
    upsert: (row: Row) => {
      operation = 'upsert'
      payload = row
      return builder
    },
    eq: (column: string, value: unknown) => {
      filters.push([column, value])
      return builder
    },
    in: (column: string, values: unknown[]) => {
      const rows = state.rows[table] ?? []
      const allowed = new Set(values)
      state.rows[table] = rows.filter((row) => allowed.has(row[column]))
      return builder
    },
    order: () => builder,
    limit: (value: number) => {
      limit = value
      return builder
    },
    maybeSingle: async () => {
      const response = result()
      return { data: response.data[0] ?? null, error: response.error }
    },
    single: async () => {
      const response = result()
      return response.error
        ? { data: null, error: response.error }
        : response.data.length === 0
        ? { data: null, error: { message: 'No rows' } }
        : { data: response.data[0], error: null }
    },
    then: (
      resolve: (value: ReturnType<typeof result>) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result()).then(resolve, reject),
  }
  return builder
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner-a', email: 'owner@example.com' } } }),
    },
  })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))
vi.mock('@/lib/auth/owner', () => ({ ownerGate: vi.fn(() => ({ allowed: true })) }))
vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.fromCalls.push(table)
      return query(table)
    },
    rpc: state.rpc,
  }),
}))
vi.mock('@/lib/writes/executor', () => ({
  executeApprovedChange: state.execute,
  httpStatusForExecuteResult: vi.fn(() => 200),
}))
vi.mock('@/lib/learning/patterns', () => ({ recomputeLearnedPatterns: state.recompute }))
vi.mock('@/lib/authority/action-decision-store', () => ({
  readActionDecisionsBySource: vi.fn(async () => new Map()),
}))

const ownerRequest = (url: string, body: Row) => new NextRequest(url, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const accountBoundCalls = [
  {
    name: 'changes list',
    call: async () => {
      const { GET } = await import('@/app/api/changes/route')
      return GET(new NextRequest('http://localhost/api/changes?status=pending'))
    },
  },
  {
    name: 'change approval',
    call: async () => {
      const { PATCH } = await import('@/app/api/changes/[id]/route')
      return PATCH(ownerRequest('http://localhost/api/changes/change-a', { action: 'approve' }), {
        params: Promise.resolve({ id: 'change-a' }),
      })
    },
  },
  {
    name: 'recommendation decision',
    call: async () => {
      const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
      return PATCH(ownerRequest('http://localhost/api/recommendations/recommendation-b/decision', {
        user_decision: 'rejected',
      }), { params: Promise.resolve({ id: 'recommendation-b' }) })
    },
  },
  {
    name: 'outcome review',
    call: async () => {
      const { PATCH } = await import('@/app/api/outcomes/[id]/review/route')
      return PATCH(ownerRequest('http://localhost/api/outcomes/outcome-b/review', {
        review_status: 'approved',
      }), { params: Promise.resolve({ id: 'outcome-b' }) })
    },
  },
  {
    name: 'signal review',
    call: async () => {
      const { PATCH } = await import('@/app/api/signals/[id]/review/route')
      return PATCH(ownerRequest('http://localhost/api/signals/insight-b/review', {
        review_status: 'approved',
      }), { params: Promise.resolve({ id: 'insight-b' }) })
    },
  },
  {
    name: 'alert resolution',
    call: async () => {
      const { PATCH } = await import('@/app/api/alerts/[id]/route')
      return PATCH(ownerRequest('http://localhost/api/alerts/alert-b', { resolved: true }), {
        params: Promise.resolve({ id: 'alert-b' }),
      })
    },
  },
]

describe('guessed IDs cannot cross the active account boundary', () => {
  beforeEach(() => {
    state.rows = {
      ad_accounts: [
        { id: 'account-a', account_id: 'act_100000000000001', account_name: 'Account A', is_active: true },
        { id: 'account-b', account_id: 'act_100000000000002', account_name: 'Account B', is_active: false },
      ],
      change_requests: [
        { id: 'change-a', ad_account_id: 'account-a', status: 'pending' },
        { id: 'change-b', ad_account_id: 'account-b', status: 'pending' },
      ],
      recommendations: [{
        id: 'recommendation-b', ad_account_id: 'account-b', target_entity_id: 'ad-b',
        recommendation_type: 'pause', learning_eligibility: true,
      }],
      recommendation_decisions: [{ id: 'decision-b' }],
      recommendation_outcomes: [{ id: 'outcome-b', ad_account_id: 'account-b', outcome: 'worked' }],
      expert_insights: [{ id: 'insight-b', ad_account_id: 'account-b' }],
      alerts: [{ id: 'alert-b', ad_account_id: 'account-b', is_resolved: false }],
    }
    state.updates = []
    state.upserts = []
    state.accountError = null
    state.fromCalls = []
    state.rpc.mockClear()
    state.execute.mockClear()
    state.recompute.mockClear()
  })

  it('lists only change requests owned by the one active account', async () => {
    const { GET } = await import('@/app/api/changes/route')
    const response = await GET(new NextRequest('http://localhost/api/changes?status=pending'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      change_requests: [expect.objectContaining({ id: 'change-a', ad_account_id: 'account-a' })],
    })
  })

  it('does not approve an account B change request through a guessed id', async () => {
    const { PATCH } = await import('@/app/api/changes/[id]/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/changes/change-b', { action: 'approve' }),
      { params: Promise.resolve({ id: 'change-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.rpc).not.toHaveBeenCalled()
  })

  it('does not execute an account B change request through a guessed id', async () => {
    const { PATCH } = await import('@/app/api/changes/[id]/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/changes/change-b', { action: 'execute' }),
      { params: Promise.resolve({ id: 'change-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.execute).not.toHaveBeenCalled()
  })

  it('does not record a decision against an account B recommendation', async () => {
    const { PATCH } = await import('@/app/api/recommendations/[id]/decision/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/recommendations/recommendation-b/decision', {
        user_decision: 'rejected',
      }),
      { params: Promise.resolve({ id: 'recommendation-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.upserts).toEqual([])
  })

  it('does not review an account B outcome or recompute its learned patterns', async () => {
    const { PATCH } = await import('@/app/api/outcomes/[id]/review/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/outcomes/outcome-b/review', { review_status: 'approved' }),
      { params: Promise.resolve({ id: 'outcome-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.updates).toEqual([])
    expect(state.recompute).not.toHaveBeenCalled()
  })

  it('does not review an account B expert insight', async () => {
    const { PATCH } = await import('@/app/api/signals/[id]/review/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/signals/insight-b/review', { review_status: 'approved' }),
      { params: Promise.resolve({ id: 'insight-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.updates).toEqual([])
  })

  it('does not resolve an account B alert', async () => {
    const { PATCH } = await import('@/app/api/alerts/[id]/route')
    const response = await PATCH(
      ownerRequest('http://localhost/api/alerts/alert-b', { resolved: true }),
      { params: Promise.resolve({ id: 'alert-b' }) },
    )

    expect(response.status).toBe(404)
    expect(state.updates).toEqual([])
  })

  it.each([
    {
      name: 'no active account',
      status: 404,
      code: 'ACTIVE_ACCOUNT_NOT_FOUND',
      configure: () => {
        state.rows.ad_accounts = []
      },
    },
    {
      name: 'multiple active accounts',
      status: 409,
      code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      configure: () => {
        state.rows.ad_accounts = [
          { id: 'account-a', account_id: 'act_100000000000001', account_name: 'Account A', is_active: true },
          { id: 'account-b', account_id: 'act_100000000000002', account_name: 'Account B', is_active: true },
        ]
      },
    },
    {
      name: 'account resolution failure',
      status: 503,
      code: 'ACTIVE_ACCOUNT_UNAVAILABLE',
      configure: () => {
        state.accountError = { message: 'database unavailable' }
      },
    },
  ])('all account-bound APIs fail closed for $name', async ({ status, code, configure }) => {
    configure()

    for (const route of accountBoundCalls) {
      state.fromCalls = []
      const response = await route.call()
      expect(response.status, route.name).toBe(status)
      expect(await response.json(), route.name).toMatchObject({ code })
      expect(state.fromCalls, route.name).toEqual(['ad_accounts'])
    }

    expect(state.rpc).not.toHaveBeenCalled()
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
    expect(state.upserts).toEqual([])
    expect(state.recompute).not.toHaveBeenCalled()
  })
})
