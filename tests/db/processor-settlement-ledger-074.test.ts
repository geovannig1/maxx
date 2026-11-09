import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000074'
const OTHER = '00000000-0000-4000-8000-000000000075'
const BATCH = '00000000-0000-4000-8000-000000000174'
const EVENT = '00000000-0000-4000-8000-000000000274'
const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`

let db: PGlite

const event = (over: Record<string, unknown> = {}) => ({
  id: EVENT,
  processor_event_id: 'evt_1',
  processor_transaction_id: 'txn_1',
  event_kind: 'payment_settled',
  occurred_at: '2026-08-01T12:00:00Z',
  available_at: '2026-08-02T12:00:00Z',
  currency: 'USD',
  outcome_id: outcomeUuid(101),
  collected_ex_tax_minor: 20_000,
  refunds_ex_tax_minor: 0,
  chargebacks_ex_tax_minor: 0,
  recovered_chargebacks_ex_tax_minor: 0,
  payment_fees_minor: 600,
  tax_amount_minor: 1_400,
  source_fingerprint: HASH_A,
  ...over,
})

async function commit(over: Record<string, unknown> = {}) {
  const args = {
    account: ACCOUNT,
    batch: BATCH,
    processor: 'unknown_processor',
    processorAccount: 'merchant_1',
    start: '2026-08-01T00:00:00Z',
    end: '2026-08-03T00:00:00Z',
    sourceHead: 'cursor_1',
    complete: true,
    blockers: [] as string[],
    events: [event()],
    fingerprint: HASH_A,
    ...over,
  }
  return db.query<{ result: Record<string, unknown> }>(`
    SELECT public.commit_processor_settlement_batch(
      $1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::timestamptz,$7,
      $8::boolean,$9::text[],$10::jsonb,1,$11
    ) AS result
  `, [
    args.account, args.batch, args.processor, args.processorAccount, args.start, args.end,
    args.sourceHead, args.complete, args.blockers, JSON.stringify(args.events), args.fingerprint,
  ])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER)
  await insertOutcome(db, ACCOUNT, 101)
  await insertOutcome(db, OTHER, 202)
})

describe('processor settlement ledger', () => {
  it('commits a complete source window atomically and retries idempotently', async () => {
    const first = await commit()
    const retry = await commit()
    expect(first.rows[0].result).toEqual(retry.rows[0].result)
    expect(first.rows[0].result).toMatchObject({ complete: true, event_count: 1, import_sequence: 1 })

    const totals = await db.query<Record<string, string>>(`
      SELECT count(*)::text AS events,
        sum(collected_ex_tax_minor)::text AS collected,
        sum(payment_fees_minor)::text AS fees
      FROM public.processor_settlement_events
    `)
    expect(totals.rows[0]).toMatchObject({ events: '1', collected: '20000', fees: '600' })
  })

  it('rejects an immutable provider-event collision instead of silently overwriting money', async () => {
    await commit()
    await expect(commit({
      batch: '00000000-0000-4000-8000-000000000374',
      sourceHead: 'cursor_2',
      fingerprint: HASH_B,
      events: [event({ id: '00000000-0000-4000-8000-000000000474', collected_ex_tax_minor: 99_900 })],
    })).rejects.toThrow(/settlement event collision/i)
  })

  it('serializes each merchant source into a monotonic import cut', async () => {
    await commit()
    const second = await commit({
      batch: '00000000-0000-4000-8000-000000000374',
      sourceHead: 'cursor_2',
      fingerprint: HASH_B,
      events: [event({
        id: '00000000-0000-4000-8000-000000000474',
        processor_event_id: 'evt_2',
      })],
    })
    expect(second.rows[0].result).toMatchObject({ import_sequence: 2 })
    const cuts = await db.query<{ import_sequence: string }>(`
      SELECT import_sequence::text FROM public.processor_settlement_events ORDER BY import_sequence
    `)
    expect(cuts.rows.map((row) => row.import_sequence)).toEqual(['1', '2'])
  })

  it('rejects reuse of one source cursor under a different batch identity', async () => {
    await commit()
    await expect(commit({ batch: '00000000-0000-4000-8000-000000000374' }))
      .rejects.toThrow(/settlement batch collision/i)
  })

  it('rejects a settlement linked to another account appointment', async () => {
    await expect(commit({ events: [event({ outcome_id: outcomeUuid(202) })] }))
      .rejects.toThrow(/foreign key|appointment/i)
  })

  it('rejects event-kind/component contradictions and non-USD money', async () => {
    await expect(commit({ events: [event({ refunds_ex_tax_minor: 1_000 })] }))
      .rejects.toThrow(/settlement_event_kind_components/i)
    await expect(commit({ events: [event({ currency: 'EUR' })] }))
      .rejects.toThrow(/settlement_event_currency/i)
    await expect(commit({ events: [event({ collected_ex_tax_minor: 20_000.5 })] }))
      .rejects.toThrow(/bigint|invalid input syntax/i)
  })

  it('persists an explicitly blocked empty window but cannot attach money to it', async () => {
    const blocked = await commit({
      complete: false,
      blockers: ['source_page_failed'],
      events: [],
      fingerprint: HASH_B,
    })
    expect(blocked.rows[0].result).toMatchObject({ complete: false, event_count: 0 })
    await expect(commit({ complete: false, blockers: ['source_page_failed'] }))
      .rejects.toThrow(/blocked settlement batch cannot contain events/i)
  })

  it('keeps batches and events immutable and denies app-role table writes', async () => {
    await commit()
    await expect(db.exec(`UPDATE public.processor_settlement_events SET collected_ex_tax_minor=1`))
      .rejects.toThrow(/immutable|append-only/i)
    await expect(db.exec(`DELETE FROM public.processor_settlement_batches`))
      .rejects.toThrow(/immutable|append-only/i)

    const privileges = await db.query<{ service_insert: boolean; auth_select: boolean }>(`
      SELECT
        has_table_privilege('service_role','public.processor_settlement_events','INSERT') AS service_insert,
        has_table_privilege('authenticated','public.processor_settlement_events','SELECT') AS auth_select
    `)
    expect(privileges.rows[0]).toEqual({ service_insert: false, auth_select: false })
  })
})
