import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PGlite } from '@electric-sql/pglite'
import { createSampleDb, DEMO_ACCOUNT_ID } from '../scripts/demo/sample-db'
import { startBackend } from '../scripts/demo/backend'
import { DEMO_DECISION_IDS } from '../scripts/demo/sample/demo-seed'

// ADR-059 §8 end to end on the demo: the SHIPPED schema with the sample seed, the demo's PostgREST
// subset and the app's real Supabase client. The owner proposes from a seeded owner-review decision,
// approves, and the simulated executor records the audit and updates the sample rows; nothing reaches
// Meta (fetch is replaced and must only see the loopback backend).

let db: PGlite
let backend: Server
const OWNER = '00000000-0000-4000-8000-00000000d0e0'

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}

beforeAll(async () => {
  db = await createSampleDb()
  backend = await startBackend(db, 0)
  const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', base)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'demo-service-key-not-a-credential')
  vi.stubEnv('MAXX_DEMO', '1')
  vi.stubEnv('WRITE_MODE_ENABLED', 'false')
  vi.stubEnv('OWNER_USER_ID', '')
  vi.stubEnv('META_ACCESS_TOKEN', '')
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(base)) throw new Error(`demo test contacted ${url}`)
    return realFetch(input, init)
  })
}, 120_000)
afterAll(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
  await new Promise<void>((done) => backend.close(() => done()))
  await db.close()
})

describe('demo: propose, approve and apply an owner change', () => {
  it('raises the retargeting ad set budget through the whole loop, then rolls it back', async () => {
    const { proposeOwnerChange, proposeRollback } = await import('@/lib/writes/owner-changes')
    const { listPendingChanges, listProposableDecisions } = await import('@/lib/writes/owner-change-reads')
    const { reviewChangeRequest } = await import('@/lib/writes/change-review')

    const proposable = await listProposableDecisions(DEMO_ACCOUNT_ID)
    expect(proposable.ok && proposable.rows.map((row) => row.id).sort()).toEqual([DEMO_DECISION_IDS.budget, DEMO_DECISION_IDS.pause].sort())

    const proposed = await proposeOwnerChange({ decisionId: DEMO_DECISION_IDS.budget, ownerUserId: OWNER, actor: 'owner@example.com', params: { new_daily_budget: 10.35 } })
    expect(proposed).toMatchObject({ status: 'PENDING_APPROVAL', http: 201 })
    expect(proposed.preview).toMatch(/^Raise ad set "Website visitors · 30 days" daily budget \$9\.00 → \$10\.35 \(\+15\.0%\)\. Projected active account total: \$73\.35\/day/)
    const id = proposed.change_request_id as string
    const again = await proposeOwnerChange({ decisionId: DEMO_DECISION_IDS.budget, ownerUserId: OWNER, params: { new_daily_budget: 10.35 } })
    expect(again).toMatchObject({ status: 'ALREADY_REQUESTED', change_request_id: id })

    const pending = await listPendingChanges(DEMO_ACCOUNT_ID)
    expect(pending.ok && pending.rows.map((row) => [row.id, row.initiated_by, row.status])).toEqual([[id, 'owner', 'pending']])

    const applied = await reviewChangeRequest({ id, action: 'approve_and_apply', actor: 'owner@example.com', accountId: DEMO_ACCOUNT_ID })
    expect(applied).toMatchObject({ http: 200, body: { status: 'DEMO_SIMULATED', simulated: true, message: expect.stringMatching(/^Demo: simulated/) } })
    expect(await query('SELECT status, initiated_by, requested_by_user_id, result FROM public.change_requests WHERE id = $1', [id]))
      .toEqual([expect.objectContaining({ status: 'executed', initiated_by: 'owner', requested_by_user_id: OWNER, result: expect.objectContaining({ simulated: true }) })])
    expect(await query('SELECT status, actor, verified FROM public.action_log WHERE change_request_id = $1', [id]))
      .toEqual([{ status: 'simulated', actor: 'owner@example.com', verified: false }])
    expect(await query(`SELECT daily_budget::float AS budget FROM public.adsets WHERE adset_id = '120000000000000203'`)).toEqual([{ budget: 10.35 }])
    expect(await query('SELECT approval_state FROM public.action_decisions WHERE id = $1', [DEMO_DECISION_IDS.budget])).toEqual([{ approval_state: 'approved' }])

    // Double click: no second simulated run.
    expect((await reviewChangeRequest({ id, action: 'approve_and_apply', actor: 'owner@example.com', accountId: DEMO_ACCOUNT_ID })).body)
      .toMatchObject({ status: 'ALREADY_EXECUTED' })
    expect(await query('SELECT count(*)::int AS n FROM public.action_log WHERE change_request_id = $1', [id])).toEqual([{ n: 1 }])

    const rollback = await proposeRollback({ changeRequestId: id, ownerUserId: OWNER, accountId: DEMO_ACCOUNT_ID })
    expect(rollback).toMatchObject({ status: 'PENDING_APPROVAL', preview: expect.stringMatching(/Lower ad set "Website visitors · 30 days" daily budget \$10\.35 → \$9\.00/) })
    const undone = await reviewChangeRequest({ id: rollback.change_request_id as string, action: 'approve_and_apply', actor: 'owner@example.com', accountId: DEMO_ACCOUNT_ID })
    expect(undone.body).toMatchObject({ status: 'DEMO_SIMULATED' })
    expect(await query(`SELECT daily_budget::float AS budget FROM public.adsets WHERE adset_id = '120000000000000203'`)).toEqual([{ budget: 9 }])
  })

  it('pauses the seeded ad through the simulated executor', async () => {
    const { proposeOwnerChange } = await import('@/lib/writes/owner-changes')
    const { reviewChangeRequest } = await import('@/lib/writes/change-review')
    const paused = await proposeOwnerChange({ decisionId: DEMO_DECISION_IDS.pause, ownerUserId: OWNER })
    expect(paused).toMatchObject({ status: 'PENDING_APPROVAL', preview: 'Pause ad "Before and after portrait" (currently ACTIVE).' })
    const result = await reviewChangeRequest({ id: paused.change_request_id as string, action: 'approve_and_apply', actor: 'owner@example.com', accountId: DEMO_ACCOUNT_ID })
    expect(result.body).toMatchObject({ status: 'DEMO_SIMULATED', after_state: expect.objectContaining({ status: 'PAUSED' }) })
    expect(await query(`SELECT status FROM public.ads WHERE ad_id = '120000000000000302'`)).toEqual([{ status: 'PAUSED' }])
  })
})
