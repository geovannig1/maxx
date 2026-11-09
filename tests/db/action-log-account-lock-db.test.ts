import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// the executor's claim insert is also the per-account execution lock. Two approved changes on one
// ad account cannot both be 'executing', so both cannot pass the account-total ceiling check and apply.

const ACCOUNT_A = '00000000-0000-4000-8000-0000000000a1'
const ACCOUNT_B = '00000000-0000-4000-8000-0000000000b1'
let db: PGlite

const claim = (account: string, key: string, status = 'executing') => db.query(
  `INSERT INTO public.action_log (ad_account_id, action_type, entity_level, meta_entity_id, idempotency_key, status)
   VALUES ($1, 'adjust_budget', 'adset', 'adset-1', $2, $3)`, [account, key, status])

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT_A)
  await insertAdAccount(db, ACCOUNT_B)
})

describe('one executing write per ad account', () => {
  it('refuses a second executing claim on the same account', async () => {
    await claim(ACCOUNT_A, 'key-1')
    await expect(claim(ACCOUNT_A, 'key-2')).rejects.toThrow(/idx_action_log_one_executing_per_account/)
  })

  it('allows another account, and the next claim once the first is finalized (controls)', async () => {
    await claim(ACCOUNT_A, 'key-1')
    await claim(ACCOUNT_B, 'key-2')
    await db.query(`UPDATE public.action_log SET status = 'verified' WHERE idempotency_key = 'key-1'`)
    await claim(ACCOUNT_A, 'key-3')
    await claim(ACCOUNT_A, 'key-4', 'failed')
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.action_log`)
    expect(rows[0].n).toBe(4)
  })
})
