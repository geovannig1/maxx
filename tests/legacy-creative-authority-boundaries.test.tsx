import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accountMode: 'ok' as 'ok' | 'ambiguous' | 'unavailable',
  readErrorTable: null as string | null,
  adminCalls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner', email: 'owner@example.com' } } }) },
  })),
}))

vi.mock('@/lib/auth/owner', () => ({ ownerGate: vi.fn(() => ({ allowed: true, reason: 'ok' })) }))

vi.mock('@/lib/supabase/admin', () => ({
  getAdminClient: () => ({
    from: (table: string) => {
      state.adminCalls.push({ table, method: 'from', args: [] })
      const chain: Record<string, unknown> = {}
      chain.select = (...args: unknown[]) => {
        state.adminCalls.push({ table, method: 'select', args })
        return chain
      }
      chain.eq = (...args: unknown[]) => {
        state.adminCalls.push({ table, method: 'eq', args })
        return chain
      }
      chain.order = (...args: unknown[]) => {
        state.adminCalls.push({ table, method: 'order', args })
        return chain
      }
      chain.limit = (...args: unknown[]) => {
        state.adminCalls.push({ table, method: 'limit', args })
        return chain
      }
      for (const method of ['insert', 'upsert', 'update', 'delete']) {
        chain[method] = (...args: unknown[]) => {
          state.adminCalls.push({ table, method, args })
          return chain
        }
      }
      chain.then = (resolve: (value: unknown) => unknown) => {
        if (table === 'ad_accounts') {
          const value = state.accountMode === 'ok'
            ? { data: [{ id: 'account-1', account_id: 'act_100000000000031', account_name: 'Example Studio' }], error: null }
            : state.accountMode === 'ambiguous'
              ? { data: [
                  { id: 'account-1', account_id: 'act_100000000000031' },
                  { id: 'account-2', account_id: 'act_100000000000032' },
                ], error: null }
              : { data: null, error: { message: 'account read failed' } }
          return Promise.resolve(value).then(resolve)
        }
        if (state.readErrorTable === table) {
          return Promise.resolve({ data: null, error: { message: 'legacy history read failed' } }).then(resolve)
        }
        if (table === 'creative_briefs') {
          return Promise.resolve({
            data: [{
              id: 'brief-legacy-1',
              title: 'READY TO PRODUCE',
              hook: 'Book now',
              cta_text: 'BOOK_NOW',
              concept: 'Unsafe recipe',
              created_at: '2026-07-01T00:00:00Z',
            }],
            error: null,
          }).then(resolve)
        }
        if (table === 'pending_approvals') {
          return Promise.resolve({
            data: [{
              id: 'approval-legacy-1',
              trigger_summary: 'Launch at $90/day',
              trigger_data: { instruction: 'Scale now' },
              brief_ids: ['brief-legacy-1'],
              test_draft_id: 'test-legacy-1',
              created_at: '2026-07-02T00:00:00Z',
            }],
            error: null,
          }).then(resolve)
        }
        if (table === 'tests') {
          return Promise.resolve({
            data: [{
              id: 'test-legacy-1',
              budget_daily: 90,
              kill_rule: 'Kill above $120 CPA',
              scale_rule: 'Scale below $55 CPA',
              created_at: '2026-07-03T00:00:00Z',
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

import {
  DELETE as deleteBrief,
  GET as getBriefHistory,
  PATCH as patchBrief,
  POST as createBrief,
  PUT as replaceBrief,
} from '@/app/api/creative_briefs/route'
import { GET as getApprovalHistory } from '@/app/api/approvals/route'
import ApprovalsPage from '@/app/(dashboard)/approvals/page'
import { ApprovalsQueue } from '@/components/approvals/ApprovalsQueue'
import { runTestMonitor } from '@/lib/tests/monitor'

// Pages now call requireOwner() themselves (src/lib/auth/page-owner.ts); this test measures the
// account boundary, not auth, so the owner check is satisfied up front.
vi.mock('@/lib/auth/page-owner', () => ({ requireOwner: async () => ({ email: 'owner@example.test' }) }))
function serialized(value: unknown): string {
  return JSON.stringify(value)
}

describe('legacy creative/test APIs are audit-only', () => {
  beforeEach(() => {
    state.accountMode = 'ok'
    state.readErrorTable = null
    state.adminCalls = []
  })

  it('returns only account-scoped brief audit identifiers and withholds the stored recipe', async () => {
    const response = await getBriefHistory()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'healthy',
      actionable: false,
      briefs: [],
      historical_record_count: 1,
      historical_records: [{ id: 'brief-legacy-1', recorded_at: '2026-07-01T00:00:00Z' }],
    })
    expect(state.adminCalls).toContainEqual({
      table: 'creative_briefs', method: 'eq', args: ['ad_account_id', 'account-1'],
    })
    expect(state.adminCalls.find((call) => call.table === 'creative_briefs' && call.method === 'select')?.args[0]).toBe('id, created_at')
    expect(serialized(body)).not.toMatch(/READY TO PRODUCE|Book now|BOOK_NOW|Unsafe recipe/i)
  })

  it('returns only account-scoped approval audit identifiers without expanding briefs or tests', async () => {
    const response = await getApprovalHistory()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'healthy',
      actionable: false,
      approvals: [],
      historical_record_count: 1,
      historical_records: [{ id: 'approval-legacy-1', recorded_at: '2026-07-02T00:00:00Z' }],
    })
    expect(state.adminCalls).toContainEqual({
      table: 'pending_approvals', method: 'eq', args: ['ad_account_id', 'account-1'],
    })
    expect(state.adminCalls.some((call) => call.table === 'creative_briefs' || call.table === 'tests')).toBe(false)
    expect(serialized(body)).not.toMatch(/Launch at|Scale now|brief_ids|test_draft_id|\$\s?\d/i)
  })

  it.each([
    ['brief history', getBriefHistory, 'creative_briefs'],
    ['approval history', getApprovalHistory, 'pending_approvals'],
  ] as const)('fails closed when %s cannot be read', async (_name, read, table) => {
    state.readErrorTable = table

    const response = await read()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'unavailable',
      actionable: false,
      historical_records: [],
    })
  })

  it('fails closed before reading legacy rows when active account ownership is ambiguous', async () => {
    state.accountMode = 'ambiguous'

    const response = await getApprovalHistory()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      read_health: 'unavailable',
      error_code: 'ACTIVE_ACCOUNT_AMBIGUOUS',
      approvals: [],
    })
    expect(state.adminCalls.some((call) => call.table === 'pending_approvals')).toBe(false)
  })

  it.each([
    ['POST', createBrief],
    ['PUT', replaceBrief],
    ['PATCH', patchBrief],
    ['DELETE', deleteBrief],
  ] as const)('blocks authenticated creative-brief %s before any database mutation', async (_method, mutate) => {
    const response = await mutate()

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'USE_CAMPAIGN_PLANS',
      blocker_codes: ['campaign_plan_not_implemented'],
    })
    expect(state.adminCalls).toEqual([])
  })

  it('has no legacy approval mutation route and no caller of one (ADR-059: owner changes live on /api/changes)', () => {
    expect(fs.existsSync('src/app/api/approvals/[id]/route.ts')).toBe(false)
    // Control: the read-only history route still exists.
    expect(fs.existsSync('src/app/api/approvals/route.ts')).toBe(true)
    const callers = ['src/components/approvals/ApprovalsQueue.tsx', 'src/components/layout/Sidebar.tsx', 'src/app/(dashboard)/approvals/page.tsx']
      .map((file) => fs.readFileSync(file, 'utf8'))
    for (const source of callers) expect(source).not.toMatch(/\/api\/approvals\/\$\{|\/api\/approvals\/[A-Za-z0-9-]/)
  })
})

describe('legacy owner surfaces and cron monitor are inert', () => {
  beforeEach(() => {
    state.adminCalls = []
  })

  it('renders only CampaignPlan-required audit state and has no approval mutation control', async () => {
    const html = renderToStaticMarkup(<><ApprovalsQueue />{await ApprovalsPage()}</>)
    const componentSource = fs.readFileSync('src/components/approvals/ApprovalsQueue.tsx', 'utf8')
    const pageSource = fs.readFileSync('src/app/(dashboard)/approvals/page.tsx', 'utf8')

    expect(html).toMatch(/CAMPAIGN_PLAN_REQUIRED/)
    expect(html).not.toMatch(/>Approve<|ready to launch|manual launch|\$\s?\d/i)
    expect(componentSource).not.toMatch(/method:\s*['"]PATCH|budget_daily|hypothesis|kill_rule|scale_rule|test_ready_to_launch/i)
    expect(`${componentSource}\n${pageSource}`).not.toMatch(/awaiting your go-ahead|Launch the approved|ready to launch/i)
  })

  it('keeps the daily-sync compatibility entry point explicit and incapable of touching legacy rows', async () => {
    const result = await runTestMonitor('account-1', '2026-07-30')
    const monitorSource = fs.readFileSync('src/lib/tests/monitor.ts', 'utf8')
    const cronSource = fs.readFileSync('src/app/api/cron/daily-sync/route.ts', 'utf8')

    expect(result).toEqual({
      status: 'CAMPAIGN_PLAN_REQUIRED',
      inert: true,
      processed: 0,
      killed: 0,
      completed: 0,
      blocker_codes: ['campaign_plan_not_implemented', 'experiment_registry_not_implemented'],
      note: expect.stringMatching(/historical rows remain untouched/i),
    })
    expect(state.adminCalls).toEqual([])
    expect(monitorSource).not.toMatch(/\.from\(|\.update\(|\.insert\(|parseRule|recommended_actions|calculateBayesianSignificance/)
    expect(cronSource).toMatch(/const result = await runTestMonitor\(adAccountDbId, today\)[\s\S]*steps\.test_monitor = result/)
  })
})
