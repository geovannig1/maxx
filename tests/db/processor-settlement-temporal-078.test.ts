import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000078'
const HASH = `sha256:${'a'.repeat(64)}`
let db: PGlite

async function initialize(): Promise<void> {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertOutcome(db, ACCOUNT, 101)
}

async function commit(over: Record<string, unknown> = {}): Promise<void> {
  const input = {
    batchId: '00000000-0000-4000-8000-000000000178',
    windowStart: '2026-07-01T00:00:00Z',
    windowEnd: '2026-07-03T00:00:00Z',
    sourceHead: 'cursor_1',
    occurredAt: '2026-07-01T12:00:00Z',
    availableAt: '2026-07-02T12:00:00Z',
    ...over,
  }
  const events = [{
    id: '00000000-0000-4000-8000-000000000278',
    processor_event_id: 'evt_1', processor_transaction_id: 'txn_1',
    event_kind: 'payment_settled', occurred_at: input.occurredAt,
    available_at: input.availableAt, currency: 'USD', outcome_id: outcomeUuid(101),
    collected_ex_tax_minor: 20_000, refunds_ex_tax_minor: 0,
    chargebacks_ex_tax_minor: 0, recovered_chargebacks_ex_tax_minor: 0,
    payment_fees_minor: 600, tax_amount_minor: 1_400, source_fingerprint: HASH,
  }]
  await db.query(`SELECT public.commit_processor_settlement_batch(
    $1::uuid,$2::uuid,'unknown_processor','merchant_1',$3::timestamptz,$4::timestamptz,
    $5,true,ARRAY[]::text[],$6::jsonb,1,$7)`, [
    ACCOUNT, input.batchId, input.windowStart, input.windowEnd,
    input.sourceHead, JSON.stringify(events), HASH,
  ])
}

beforeEach(async () => initialize())

describe('processor settlement temporal integrity', () => {
  it('rejects future-complete windows and events unavailable at import time', async () => {
    await expect(commit({
      windowStart: '2999-01-01T00:00:00Z', windowEnd: '2999-01-02T00:00:00Z',
      occurredAt: '2999-01-01T12:00:00Z', availableAt: '2999-01-01T13:00:00Z',
    })).rejects.toThrow(/chronology|check constraint/i)
    await expect(commit({ availableAt: '2999-01-01T00:00:00Z' }))
      .rejects.toThrow(/chronology|check constraint/i)
  })
})
