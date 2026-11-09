import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000076'
const OTHER = '00000000-0000-4000-8000-000000000077'
const BATCH = '00000000-0000-4000-8000-000000000176'
const EVENT = '00000000-0000-4000-8000-000000000276'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
let db: PGlite
let policyId: string
let approvalId: string

const event = (over: Record<string, unknown> = {}) => ({
  id: EVENT,
  source_event_id: 'cost_evt_1',
  event_kind: 'cost_incurred',
  reverses_source_event_id: null,
  occurred_at: '2026-07-01T12:00:00Z',
  available_at: '2026-07-02T12:00:00Z',
  currency: 'USD',
  outcome_id: outcomeUuid(101),
  category: 'consumables',
  amount_minor: 2_500,
  source_fingerprint: HASH_A,
  ...over,
})

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

async function commitBatch(over: Record<string, unknown> = {}) {
  const args = {
    batch: BATCH,
    source: 'owner_actual_cost_export',
    sourceHead: 'cost_cursor_1',
    complete: true,
    blockers: [] as string[],
    events: [event()],
    fingerprint: HASH_A,
    windowStart: '2026-07-01T00:00:00Z',
    windowEnd: '2026-07-03T00:00:00Z',
    ...over,
  }
  return one<Record<string, unknown>>(`
    SELECT public.commit_variable_cost_batch(
      $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9::text[],$10::jsonb,1,$11
    ) AS result`, [
    ACCOUNT, args.batch, approvalId, args.source, args.windowStart,
    args.windowEnd, args.sourceHead, args.complete, args.blockers,
    JSON.stringify(args.events), args.fingerprint,
  ])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER)
  await db.query(`UPDATE public.ad_accounts SET is_active=false WHERE id=$1`, [OTHER])
  await insertOutcome(db, ACCOUNT, 101)
  await insertOutcome(db, OTHER, 202)
  const policy = await one<{ id: string }>(`
    SELECT (public.commit_economics_policy_version(
      $1,1,'maximize_incremental_contribution_from_ad_attributed_collected_revenue',
      'USD','unknown_processor','merchant_1',30,'outcome_actual_entries',
      ARRAY['owner_actual_cost_export'],ARRAY['consumables','provider_commission'],
      '{"consumables":"owner_actual_cost_export","provider_commission":"owner_actual_cost_export"}'::jsonb,
      'excluded_from_contribution',$2,'owner_entry','owner worksheet',
      '2026-08-02T12:00:00Z','policy-v1'
    )).*`, [ACCOUNT, HASH_A])
  policyId = policy.id
  const approval = await one<{ id: string }>(`
    SELECT (public.approve_economics_policy_version(
      $1,$2,$3,NULL,'2026-07-01T00:00:00Z','owner','verified actual cost sources',
      $4,'approve-policy-v1'
    )).*`, [ACCOUNT, policyId, HASH_A, new Date(Date.now() + 365 * 86_400_000).toISOString()])
  approvalId = approval.id
})

describe('actual variable-cost ledger', () => {
  it('commits an exact complete source window atomically and retries idempotently', async () => {
    const first = await commitBatch()
    const retry = await commitBatch()
    expect(retry.result).toEqual(first.result)
    expect(first.result).toMatchObject({ event_count: 1, complete: true, import_sequence: 1 })
    const stored = await one<Record<string, unknown>>(`
      SELECT economics_policy_id::text,amount_minor::text,category
      FROM public.variable_cost_events`)
    expect(stored).toMatchObject({ economics_policy_id: policyId, amount_minor: '2500', category: 'consumables' })
  })

  it('rejects unapproved sources, categories, currencies, and fractional minor units', async () => {
    await expect(commitBatch({ source: 'unapproved_export' })).rejects.toThrow(/required cost source/i)
    await expect(commitBatch({ events: [event({ category: 'rent' })] }))
      .rejects.toThrow(/allowed variable-cost category/i)
    await expect(commitBatch({ events: [event({ currency: 'EUR' })] }))
      .rejects.toThrow(/currency|check constraint/i)
    await expect(commitBatch({ events: [event({ amount_minor: 2_500.5 })] }))
      .rejects.toThrow(/bigint|invalid input syntax/i)
  })

  it('rejects a cost linked to another account appointment', async () => {
    await expect(commitBatch({ events: [event({ outcome_id: outcomeUuid(202) })] }))
      .rejects.toThrow(/foreign key|appointment/i)
  })

  it('allows a matching partial reversal but never more than the original cost', async () => {
    await commitBatch()
    const reversal = event({
      id: '00000000-0000-4000-8000-000000000376',
      source_event_id: 'cost_evt_2', event_kind: 'cost_reversed',
      reverses_source_event_id: 'cost_evt_1', amount_minor: 1_000,
    })
    await commitBatch({
      batch: '00000000-0000-4000-8000-000000000476',
      sourceHead: 'cost_cursor_2', events: [reversal], fingerprint: HASH_B,
    })
    await expect(commitBatch({
      batch: '00000000-0000-4000-8000-000000000576',
      sourceHead: 'cost_cursor_3', fingerprint: `sha256:${'c'.repeat(64)}`,
      events: [event({
        id: '00000000-0000-4000-8000-000000000676',
        source_event_id: 'cost_evt_3', event_kind: 'cost_reversed',
        reverses_source_event_id: 'cost_evt_1', amount_minor: 1_501,
      })],
    })).rejects.toThrow(/exceed.*original cost/i)
  })

  it('rejects a reversal detached from the original appointment or category', async () => {
    await commitBatch()
    await expect(commitBatch({
      batch: '00000000-0000-4000-8000-000000000476', sourceHead: 'cost_cursor_2',
      events: [event({
        id: '00000000-0000-4000-8000-000000000376', source_event_id: 'cost_evt_2',
        event_kind: 'cost_reversed', reverses_source_event_id: 'cost_evt_1',
        category: 'provider_commission',
      })],
    })).rejects.toThrow(/match original appointment and category/i)
    await expect(commitBatch({
      batch: '00000000-0000-4000-8000-000000000576', sourceHead: 'cost_cursor_3',
      events: [event({
        id: '00000000-0000-4000-8000-000000000676', source_event_id: 'cost_evt_3',
        event_kind: 'cost_reversed', reverses_source_event_id: 'cost_evt_1',
        occurred_at: '2026-07-01T11:59:59Z', available_at: '2026-07-01T13:00:00Z',
      })],
    })).rejects.toThrow(/cannot precede the original cost/i)
  })

  it('persists a blocked source window only when it is empty', async () => {
    const blocked = await commitBatch({
      complete: false, blockers: ['source_export_failed'], events: [], fingerprint: HASH_B,
    })
    expect(blocked.result).toMatchObject({ complete: false, event_count: 0 })
    await expect(commitBatch({ complete: false, blockers: ['source_export_failed'] }))
      .rejects.toThrow(/blocked variable-cost batch cannot contain events/i)
  })

  it('rejects imports after the referenced economics approval is withdrawn', async () => {
    await one(`SELECT public.withdraw_economics_policy_approval(
      $1,$2,'owner','cost source changed','withdraw-policy-v1')`, [ACCOUNT, approvalId])
    await expect(commitBatch()).rejects.toThrow(/current approved economics policy/i)
  })

  it('rejects premature completeness and events not yet available to the importer', async () => {
    await expect(commitBatch({
      windowStart: '2999-01-01T00:00:00Z',
      windowEnd: '2999-01-02T00:00:00Z',
      events: [event({
        occurred_at: '2999-01-01T12:00:00Z',
        available_at: '2999-01-01T13:00:00Z',
      })],
    })).rejects.toThrow(/window.*complete|chronology|check constraint/i)

    await expect(commitBatch({
      events: [event({ available_at: '2999-01-01T00:00:00Z' })],
    })).rejects.toThrow(/imported.*available|chronology|check constraint/i)
  })

  it('keeps all cost facts immutable and denies application-role direct writes', async () => {
    await commitBatch()
    await expect(db.exec(`UPDATE public.variable_cost_events SET amount_minor=1`))
      .rejects.toThrow(/immutable|append-only/i)
    await expect(db.exec(`DELETE FROM public.variable_cost_batches`))
      .rejects.toThrow(/immutable|append-only/i)
    const grants = await one<{ dml: number; browser_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('variable_cost_batches'),('variable_cost_events')) t(table_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) AS dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('variable_cost_batches'),('variable_cost_events')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) AS browser_reads
    `)
    expect(grants).toEqual({ dml: 0, browser_reads: 0 })
  })
})
