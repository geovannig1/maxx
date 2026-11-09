import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'

const state = vi.hoisted(() => ({
  accounts: [] as Array<{ id: string; is_active: boolean }>,
  accountError: null as { message: string } | null,
  adminFromCalls: [] as string[],
  accountQueryCalls: [] as Array<[string, unknown]>,
  tasks: [] as Array<Record<string, unknown>>,
  ledgerRow: null as Record<string, unknown> | null,
  ledgerUpdateCalls: [] as Array<Record<string, unknown>>,
  insert: vi.fn(async () => 'decision-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }),
    },
  })),
}))

vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.adminFromCalls.push(table)
      if (table === 'audit_tasks') {
        let rows = [...state.tasks]
        const builder = {
          select: () => builder,
          order: () => builder,
          eq: (column: string, value: unknown) => {
            rows = rows.filter((row) => row[column] === value)
            return builder
          },
          in: (column: string, values: unknown[]) => {
            rows = rows.filter((row) => values.includes(row[column]))
            return builder
          },
          then: (
            resolve: (value: { data: Array<Record<string, unknown>>; error: null; count: number }) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject),
        }
        return builder
      }

      if (table === 'ad_setup_decisions') {
        const builder = {
          select: () => builder,
          eq: () => builder,
          update: (patch: Record<string, unknown>) => {
            state.ledgerUpdateCalls.push(patch)
            return builder
          },
          maybeSingle: async () => ({ data: state.ledgerRow, error: null }),
          single: async () => ({ data: state.ledgerRow, error: null }),
        }
        return builder
      }

      if (table !== 'ad_accounts') throw new Error(`Unexpected table: ${table}`)

      let rows = [...state.accounts]
      let limit = rows.length
      const response = () => ({
        data: rows.slice(0, limit).map(({ id }) => ({ id, account_id: `act_${id}`, account_name: null })),
        error: state.accountError,
      })
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          state.accountQueryCalls.push([column, value])
          if (column === 'is_active') rows = rows.filter((row) => row.is_active === value)
          return builder
        },
        limit: (value: number) => {
          limit = value
          return builder
        },
        maybeSingle: async () => {
          const result = response()
          return {
            data: result.data[0] ?? null,
            error: result.error,
          }
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

vi.mock('@/lib/recommendations/setup-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recommendations/setup-ledger')>()
  return {
    ...actual,
    insertSetupDecision: state.insert,
    latestDecisionForSetting: vi.fn(async () => null),
  }
})

function manualDecisionRequest(): NextRequest {
  return new NextRequest('http://localhost/api/setup-decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      entity_type: 'campaign',
      entity_id: 'campaign-1',
      setting_category: 'budget',
      setting_name: 'Daily budget',
      final_value: '35',
      origin: 'manual_action',
      user_decision: 'accepted',
    }),
  })
}

describe('active account resolution', () => {
  beforeEach(() => {
    state.accounts = []
    state.accountError = null
    state.adminFromCalls = []
    state.accountQueryCalls = []
    state.tasks = []
    state.ledgerRow = null
    state.ledgerUpdateCalls = []
    state.insert.mockClear()
  })

  it('filters before selecting, so an inactive first row cannot own a manual decision', async () => {
    state.accounts = [
      { id: 'inactive-first', is_active: false },
      { id: 'active-second', is_active: true },
    ]

    const { POST } = await import('@/app/api/setup-decisions/route')
    const response = await POST(manualDecisionRequest())

    expect(response.status).toBe(200)
    expect(state.accountQueryCalls).toContainEqual(['is_active', true])
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({
      ad_account_id: 'active-second',
    }))
  })

  it('resolves the only active row even when an inactive row is returned first without a filter', async () => {
    state.accounts = [
      { id: 'inactive-first', is_active: false },
      { id: 'active-second', is_active: true },
    ]

    await expect(resolveOnlyActiveAccount()).resolves.toEqual({
      ok: true,
      account: { id: 'active-second', accountId: 'act_active-second', accountName: null },
    })
  })

  it.each([
    {
      name: 'no active rows',
      accounts: [] as Array<{ id: string; is_active: boolean }>,
      error: null,
      reason: 'not_found',
    },
    {
      name: 'duplicate active rows',
      accounts: [
        { id: 'active-1', is_active: true },
        { id: 'active-2', is_active: true },
      ],
      error: null,
      reason: 'ambiguous',
    },
    {
      name: 'database failure',
      accounts: [{ id: 'active-1', is_active: true }],
      error: { message: 'database unavailable' },
      reason: 'unavailable',
    },
  ])('shared resolver fails closed for $name', async ({ accounts, error, reason }) => {
    state.accounts = accounts
    state.accountError = error

    await expect(resolveOnlyActiveAccount()).resolves.toEqual({ ok: false, reason })
  })

  it.each([
    {
      name: 'zero active accounts',
      accounts: [] as Array<{ id: string; is_active: boolean }>,
      error: null,
      status: 404,
      code: 'ACTIVE_ACCOUNT_NOT_FOUND',
    },
    {
      name: 'multiple active accounts',
      accounts: [
        { id: 'active-1', is_active: true },
        { id: 'active-2', is_active: true },
      ],
      error: null,
      status: 409,
      code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
    },
    {
      name: 'account read failure',
      accounts: [{ id: 'active-1', is_active: true }],
      error: { message: 'database unavailable' },
      status: 503,
      code: 'ACTIVE_ACCOUNT_UNAVAILABLE',
    },
  ])('fails closed for $name', async ({ accounts, error, status, code }) => {
    state.accounts = accounts
    state.accountError = error

    const { POST } = await import('@/app/api/setup-decisions/route')
    const response = await POST(manualDecisionRequest())

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ code })
    expect(state.insert).not.toHaveBeenCalled()
  })

  it('rejects launch setup before resolving an account or reaching a write path', async () => {
    state.accounts = [
      { id: 'inactive-first', is_active: false },
      { id: 'active-second', is_active: true },
    ]

    const { POST } = await import('@/app/api/setup-decisions/route')
    const response = await POST(new NextRequest('http://localhost/api/setup-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'campaign',
        planned_name: 'Unbound launch',
        setting_category: 'objective',
        setting_name: 'Campaign objective',
        final_value: 'OUTCOME_LEADS',
        origin: 'launch_setup',
      }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'USE_CAMPAIGN_PLANS' })
    expect(state.adminFromCalls).toEqual([])
    expect(state.accountQueryCalls).toEqual([])
    expect(state.insert).not.toHaveBeenCalled()
  })

  it('blocks arbitrary task writes before account resolution', async () => {
    state.accounts = [
      { id: 'active-1', is_active: true },
      { id: 'active-2', is_active: true },
    ]

    const { POST } = await import('@/app/api/tasks/route')
    const response = await POST(new NextRequest('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ title: 'Review the account' }] }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'ACTION_DECISION_REQUIRED' })
    expect(state.adminFromCalls).toEqual([])
  })

  it('excludes another account\'s tasks from the owner task feed', async () => {
    state.accounts = [{ id: 'active-account', is_active: true }]
    state.tasks = [
      {
        id: 'active-task', ad_account_id: 'active-account', title: 'Active task', status: 'open',
        action_decision: {
          authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
          owner_copy: 'FOR OWNER REVIEW: inspect the governed task.',
        },
      },
      {
        id: 'other-task', ad_account_id: 'other-account', title: 'Other task', status: 'open',
        action_decision: {
          authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
          owner_copy: 'FOR OWNER REVIEW: inspect the other task.',
        },
      },
    ]

    const { GET } = await import('@/app/api/tasks/route')
    const response = await GET(new NextRequest('http://localhost/api/tasks?status=open'))
    const body = await response.json() as { data: Array<{ id: string }>; total: number }

    expect(response.status).toBe(200)
    expect(body.data.map((row) => row.id)).toEqual(['active-task'])
    expect(body.total).toBe(1)
  })

  it('blocks PATCH by id when the ledger row belongs to another account', async () => {
    state.accounts = [{ id: 'active-account', is_active: true }]
    state.ledgerRow = {
      id: 'other-row',
      ad_account_id: 'other-account',
      origin: 'manual_action',
    }

    const { PATCH } = await import('@/app/api/setup-decisions/[id]/route')
    const response = await PATCH(new NextRequest('http://localhost/api/setup-decisions/other-row', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision_note: 'Attempted cross-account mutation' }),
    }), { params: Promise.resolve({ id: 'other-row' }) })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: 'LEDGER_ROW_OUTSIDE_ACTIVE_ACCOUNT' })
    expect(state.ledgerUpdateCalls).toEqual([])
  })

  it('keeps legacy launch rows read-only before account resolution, even across accounts', async () => {
    state.accounts = [{ id: 'active-account', is_active: true }]
    state.ledgerRow = {
      id: 'legacy-launch',
      ad_account_id: 'other-account',
      origin: 'launch_setup',
    }

    const { PATCH } = await import('@/app/api/setup-decisions/[id]/route')
    const response = await PATCH(new NextRequest('http://localhost/api/setup-decisions/legacy-launch', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actual_launched_value: 'OUTCOME_LEADS' }),
    }), { params: Promise.resolve({ id: 'legacy-launch' }) })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'USE_CAMPAIGN_PLANS' })
    expect(state.adminFromCalls).not.toContain('ad_accounts')
    expect(state.ledgerUpdateCalls).toEqual([])
  })

  it('makes high-authority MCP reads unavailable when active-account ownership is ambiguous', async () => {
    state.accounts = [
      { id: 'active-1', is_active: true },
      { id: 'active-2', is_active: true },
    ]

    const { getDecisionHistory } = await import('@/mcp/tools/decision-history')
    const history = await getDecisionHistory({}) as { error_code?: string; recommendation_decisions: unknown[] }
    expect(history.error_code).toBe('ACTIVE_ACCOUNT_AMBIGUOUS')
    expect(history.recommendation_decisions).toEqual([])

    const { getOpenRecommendationsTool } = await import('@/mcp/tools/open-recommendations')
    const recommendations = await getOpenRecommendationsTool({}) as { read_health: string; count: number }
    expect(recommendations).toMatchObject({ read_health: 'unavailable', count: 0 })

    const { getLaunchReadiness } = await import('@/mcp/tools/launch-readiness')
    const launch = await getLaunchReadiness({}) as { error_code?: string; ready?: boolean | null }
    expect(launch).toMatchObject({ error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS', ready: null })
  })

  it('pins every owner-facing account resolver to one explicitly active row', () => {
    const files = [
      'src/components/dashboard/dashboard-data.ts',
      'src/lib/decisions/read-model.ts',
      'src/app/api/setup-decisions/route.ts',
      'src/app/api/setup-decisions/[id]/route.ts',
      'src/app/report/client/page.tsx',
      'src/components/dashboard/CampaignRoasPanel.tsx',
      'src/app/(dashboard)/activity/change-log/page.tsx',
      'src/app/api/tasks/route.ts',
      'src/app/(dashboard)/launch/page.tsx',
      'src/mcp/tools/decision-history.ts',
      'src/mcp/tools/open-recommendations.ts',
      'src/mcp/tools/learnings.ts',
      'src/mcp/tools/operating-mode.ts',
      'src/mcp/tools/launch-readiness.ts',
      'src/app/api/adsets/route.ts',
      'src/app/api/campaigns/route.ts',
      'src/app/api/flags/route.ts',
      'src/app/api/alerts/route.ts',
      'src/app/api/planning-context/route.ts',
    ]

    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/from\('ad_accounts'\)/)
      expect(source, file).toMatch(/resolveOnlyActiveAccount\(/)
    }

    const resolver = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/accounts/active-account.ts'),
      'utf8',
    )
    expect(resolver).toMatch(
      /from\('ad_accounts'\)\.select\('id, account_id, account_name'\)\.eq\('is_active', true\)\.limit\(2\)/,
    )
    expect(resolver).toMatch(/data\.length !== 1/)
  })
})
