import fs from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ACTION_DECISION_POLICY_FLOOR } from '@/lib/authority/legacy-cutover'
import * as diagnosticSurface from '@/lib/authority/diagnostic-surface'

const state = vi.hoisted(() => ({
  fromCalls: [] as string[],
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  writes: [] as Array<{ table: string; method: string }>,
  accounts: [{
    id: 'account-1', account_id: 'act_100000000000081', account_name: 'Example Studio', is_active: true,
  }] as Array<Record<string, unknown>>,
}))

function makeDb() {
  return {
    from: (table: string) => {
      state.fromCalls.push(table)
      let rows: Array<Record<string, unknown>> = table === 'ad_accounts'
        ? [...state.accounts]
        : table === 'alerts'
          ? [
              { id: 'alert-own', ad_account_id: 'account-1', alert_type: 'delivery', title: 'Own alert', message: 'Observed.', severity: 'info' },
              { id: 'alert-other', ad_account_id: 'account-2', alert_type: 'delivery', title: 'Other alert', message: 'Observed.', severity: 'info' },
            ]
          : table === 'audit_tasks'
            ? [
                {
                  id: 'task-legacy', ad_account_id: 'account-1', title: 'Pause ad now',
                  description: 'Spend is being wasted.', recommendation: 'Cut the budget by 50%.',
                  priority: 'urgent', status: 'open', created_at: '2026-07-01T00:00:00Z', action_decision: null,
                },
                {
                  id: 'task-current', ad_account_id: 'account-1', title: 'Review governed decision',
                  description: 'Governed task.', recommendation: 'Stored task copy.', priority: 'high', status: 'open',
                  created_at: '2026-07-02T00:00:00Z',
                  action_decision: {
                    authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
                    authority_reason: 'Current policy.', owner_copy: 'FOR OWNER REVIEW: inspect the governed proposal.',
                  },
                },
                {
                  id: 'task-other', ad_account_id: 'account-2', title: 'Other account task',
                  description: 'Other.', recommendation: 'Other.', priority: 'urgent', status: 'open',
                  created_at: '2026-07-03T00:00:00Z',
                  action_decision: {
                    authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
                    authority_reason: 'Other.', owner_copy: 'Other account proposal.',
                  },
                },
              ]
            : []
      let rowLimit = Number.POSITIVE_INFINITY
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = (column: string, value: unknown) => {
        state.filters.push({ table, column, value })
        rows = rows.filter((row) => row[column] === value)
        return chain
      }
      chain.in = (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]))
        return chain
      }
      chain.order = () => chain
      chain.limit = (value: number) => {
        rowLimit = value
        return chain
      }
      for (const method of ['insert', 'update', 'upsert', 'delete']) {
        chain[method] = () => {
          state.writes.push({ table, method })
          return chain
        }
      }
      const response = () => ({ data: rows.slice(0, rowLimit), error: null, count: rows.length })
      chain.then = (resolve: (value: ReturnType<typeof response>) => unknown) => Promise.resolve(response()).then(resolve)
      chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
      chain.single = async () => ({ data: rows[0] ?? null, error: null })
      return chain
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }) },
  })),
}))
vi.mock('@/lib/auth/require-owner', () => ({ ownerOnly: vi.fn(() => null) }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => makeDb() }))
vi.mock('@/mcp/lib/supabase', () => ({ getSupabaseClient: () => makeDb() }))

import { GET as getTasks, POST as createTasks } from '@/app/api/tasks/route'
import { PATCH as updateTask } from '@/app/api/tasks/[id]/route'
import { getAlerts, getAuditTasks } from '@/mcp/tools/alerts-tasks'

describe('task authority quarantine', () => {
  beforeEach(() => {
    state.fromCalls = []
    state.filters = []
    state.writes = []
    state.accounts = [{
      id: 'account-1', account_id: 'act_100000000000081', account_name: 'Example Studio', is_active: true,
    }]
  })

  it('blocks arbitrary task publication with a stable 409 before account or database access', async () => {
    const response = await createTasks(new NextRequest('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: [{ title: 'Pause now', recommendation: 'Cut budget 50%' }] }),
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      status: 'ACTION_DECISION_REQUIRED',
      code: 'ACTION_DECISION_REQUIRED',
      blocker_codes: ['current_action_decision_required', 'governed_task_publication_not_implemented'],
    })
    expect(state.fromCalls).toEqual([])
    expect(state.writes).toEqual([])
  })

  it('returns current-policy tasks as actionable data and legacy rows as identifier-only history', async () => {
    const response = await getTasks(new NextRequest('http://localhost/api/tasks?status=open'))
    const body = await response.json()
    const serialized = JSON.stringify(body)

    expect(response.status).toBe(200)
    expect(body.data).toEqual([expect.objectContaining({
      id: 'task-current', action_authority_tier: 'owner_review', action_authority_legacy: false,
    })])
    expect(body.historical_records).toEqual([
      { id: 'task-legacy', recorded_at: '2026-07-01T00:00:00Z' },
    ])
    expect(body.total).toBe(1)
    expect(state.filters).toContainEqual({ table: 'audit_tasks', column: 'ad_account_id', value: 'account-1' })
    expect(serialized).not.toMatch(/Pause ad now|Spend is being wasted|Cut the budget|Other account/i)
  })

  it('projects away raw legacy prose and filters stale/diagnostic decisions structurally', () => {
    const projectCurrentActionableTasks = (
      diagnosticSurface as typeof diagnosticSurface & {
        projectCurrentActionableTasks: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
      }
    ).projectCurrentActionableTasks
    const legacy = diagnosticSurface.projectTaskSurface({
      id: 'legacy', title: 'Pause ad', description: 'Waste.', recommendation: 'Scale the winner.',
    })
    const current = {
      id: 'current', title: 'Governed', recommendation: 'Stored.',
      action_decision: {
        authority_tier: 'owner_review', policy_version: ACTION_DECISION_POLICY_FLOOR,
        owner_copy: 'FOR OWNER REVIEW: inspect.',
      },
    }

    expect(legacy).toMatchObject({ action_authority_tier: 'diagnostic_only', action_authority_legacy: true })
    expect(legacy).not.toHaveProperty('legacy_raw_for_audit')
    expect(JSON.stringify(legacy)).not.toMatch(/Pause ad|Waste|Scale the winner/i)
    expect(projectCurrentActionableTasks([legacy, current]).map((row) => row.id)).toEqual(['current'])
  })

  it('requires an explicit acknowledgement note before closing a legacy diagnostic task', async () => {
    const response = await updateTask(new NextRequest('http://localhost/api/tasks/task-legacy', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }), { params: Promise.resolve({ id: 'task-legacy' }) })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'DIAGNOSTIC_DISPOSITION_NOTE_REQUIRED' })
    expect(state.writes).toEqual([])
  })

  it('account-scopes MCP alert/task reads and returns only current task actions', async () => {
    const [alerts, tasks] = await Promise.all([
      getAlerts({ limit: 20 }),
      getAuditTasks({ status: 'open', limit: 20 }),
    ])

    expect(alerts).toMatchObject({ read_health: 'healthy', total: 1 })
    expect(tasks).toMatchObject({ read_health: 'healthy', total: 1, historical_record_count: 1 })
    expect(JSON.stringify({ alerts, tasks })).not.toMatch(/alert-other|Pause ad now|Cut the budget|Other account/i)
    expect(state.filters).toEqual(expect.arrayContaining([
      { table: 'alerts', column: 'ad_account_id', value: 'account-1' },
      { table: 'audit_tasks', column: 'ad_account_id', value: 'account-1' },
    ]))
  })

  it('fails MCP alert/task reads closed when active-account ownership is ambiguous', async () => {
    state.accounts = [
      { id: 'account-1', account_id: 'act_100000000000081', account_name: 'Example Studio', is_active: true },
      { id: 'account-2', account_id: 'act_100000000000082', account_name: 'Other', is_active: true },
    ]

    await expect(getAlerts({ limit: 20 })).rejects.toThrow('ACTIVE_ACCOUNT_AMBIGUOUS')
    await expect(getAuditTasks({ limit: 20 })).rejects.toThrow('ACTIVE_ACCOUNT_AMBIGUOUS')
    expect(state.fromCalls).not.toContain('alerts')
    expect(state.fromCalls).not.toContain('audit_tasks')
  })

  it('removes the two arbitrary create-task controls instead of leaving buttons that always fail', () => {
    const actionPlan = fs.readFileSync('src/components/recommendations/ActionPlan.tsx', 'utf8')
    const diagnostics = fs.readFileSync('src/app/(dashboard)/diagnostics/page.tsx', 'utf8')

    expect(`${actionPlan}\n${diagnostics}`).not.toMatch(/fetch\(['"]\/api\/tasks['"][\s\S]{0,100}?method:\s*['"]POST/)
    expect(`${actionPlan}\n${diagnostics}`).not.toMatch(/Add all to tasks|Add findings to tasks/)
  })

  it('keeps current diagnostic report generation from creating recommendation tasks', () => {
    const generator = fs.readFileSync('src/lib/report/generator.ts', 'utf8')
    const revalidation = fs.readFileSync('src/lib/report/task-revalidation.ts', 'utf8')

    expect(generator).not.toMatch(/governedRecommendationTasks\(governedRecommendations\)/)
    expect(generator).not.toMatch(/from\('audit_tasks'\)\.insert/)
    expect(revalidation).toMatch(/const tasks = projectCurrentActionableTasks/)
    expect(revalidation).toMatch(/\.update\([\s\S]{0,500}?\.eq\('ad_account_id', adAccountDbId\)/)
  })

  it('scopes Maxx context to one active account and never renders a read failure as healthy-empty', () => {
    const maxx = fs.readFileSync('src/app/(dashboard)/maxx/page.tsx', 'utf8')

    expect(maxx).toMatch(/resolveOnlyActiveAccount\(db\)/)
    for (const table of ['flags', 'audit_tasks', 'daily_reports']) {
      expect(maxx).toMatch(new RegExp(`from\\('${table}'\\)[\\s\\S]{0,450}?eq\\('ad_account_id', accountId\\)`))
    }
    expect(maxx).toMatch(/projectCurrentActionableTasks/)
    expect(maxx).toMatch(/ActiveAccountUnavailableNotice/)
    expect(maxx).toMatch(/not treating this as an empty account/)
  })
})
