import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { handlePostgrest } from '../../scripts/lib/postgrest-pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { approvedPlan, emptyMeta, planSpec, seedPlanAccount, type FakeMeta } from './campaign-plan-harness'

// Security review L1 (ADR-062): two Apply clicks on one plan. The second reads the request while the
// first is still running, then reaches its execution claim only after the first finished. It must not
// create anything again, and must never flip the executed request to failed.

const ACCOUNT = '00000000-0000-4000-8000-000000000661'
const OWNER = '00000000-0000-4000-8000-0000000000aa'

const meta = vi.hoisted(() => ({ current: null as unknown as FakeMeta }))
const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))

vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))
vi.mock('@/config/demo', () => ({ isDemoMode: () => false }))
vi.mock('@/lib/writes/write-state-backend', async () => {
  const actual = await vi.importActual<typeof import('@/lib/writes/write-state-backend')>('@/lib/writes/write-state-backend')
  return { ...actual, writeStateBackend: () => ({ kind: 'meta', readSnapshot: async () => null, accountDailyBudgetTotal: async () => 10 }) }
})
vi.mock('@/lib/platforms/registry', async () => {
  const { fakeRegistry } = await import('./campaign-plan-harness')
  const proxy = new Proxy({} as FakeMeta, { get: (_t, key) => (meta.current as unknown as Record<PropertyKey, unknown>)[key], set: (_t, key, value) => { (meta.current as unknown as Record<PropertyKey, unknown>)[key] = value; return true } })
  return fakeRegistry(proxy)
})

const { submitPlanForApproval } = await import('@/lib/campaigns/plan-submission')
const { executeCampaignPlanChange } = await import('@/lib/campaigns/plan-executor')
const { hashSpec } = await import('@/lib/campaigns/plan-repository')
const { businessDateOf } = await import('@/config/business-config')

let db: PGlite
const tomorrow = () => businessDateOf(new Date(Date.now() + 86_400_000), 'America/New_York')

/** Holds the next read of one table until released: the deterministic interleaving of two clicks. */
const hold = { table: null as string | null, reached: () => {}, release: () => {}, gate: Promise.resolve() }
function arm(table: string): Promise<void> {
  hold.table = table
  hold.gate = new Promise((resolve) => { hold.release = resolve })
  return new Promise((resolve) => { hold.reached = resolve })
}

function holdingClient(): SupabaseClient {
  return createClient('http://postgrest-fixture.invalid', 'fixture-anon-placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const table = new URL(request.url).pathname.replace(/^\/rest\/v1\//, '')
        if (hold.table === table && request.method === 'GET') {
          hold.table = null
          hold.reached()
          await hold.gate
        }
        return handlePostgrest(db, request, 'strict')
      },
    },
  })
}

beforeEach(async () => {
  meta.current = emptyMeta()
  process.env.WRITE_MODE_ENABLED = 'true'
  process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS = 'studio.example'
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_661')
  await seedPlanAccount(db, ACCOUNT)
  state.client = holdingClient()
})
afterEach(() => { delete process.env.WRITE_MODE_ENABLED; delete process.env.PAID_TOUCH_ALLOWED_LANDING_HOSTS })

describe('a second Apply cannot clobber a finished creation (security review L1)', () => {
  it('re-reads the request after taking the lock: no second creation, the request stays executed', async () => {
    const { changeRequestId, versionId } = await approvedPlan(db, { submit: submitPlanForApproval, hashSpec, spec: planSpec(tomorrow()), account: ACCOUNT, owner: OWNER })
    // Click 2 reads the approved request, then stops just before its claim reads the action log.
    const reached = arm('action_log')
    const second = executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Promise<Record<string, unknown>>
    await reached
    // Click 1 runs to completion meanwhile.
    expect((await executeCampaignPlanChange(changeRequestId, 'owner@example.test', ACCOUNT) as Record<string, unknown>).status).toBe('CREATED_PAUSED')
    const created = meta.current.creates.length
    hold.release()

    expect((await second).status).toBe('ALREADY_EXECUTED')
    expect(meta.current.creates.length).toBe(created)
    const cr = await db.query<{ status: string }>('SELECT status FROM public.change_requests WHERE id = $1', [changeRequestId])
    expect(cr.rows[0].status).toBe('executed')
    const version = await db.query<{ status: string }>('SELECT status FROM public.campaign_plan_versions WHERE id = $1', [versionId])
    expect(version.rows[0].status).toBe('created_paused')
    const executing = await db.query('SELECT 1 FROM public.action_log WHERE ad_account_id = $1 AND status = $2', [ACCOUNT, 'executing'])
    expect(executing.rows).toHaveLength(0)
  })
})
