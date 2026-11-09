import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { ensureAcuitySource, outcomeUuid } from './causal-fixture'

// Generic currency, migrations 20261112000100..300: economics and causal money carry the ad
// account's ISO 4217 currency. A EUR account's ledgers accept EUR; another currency on the same account is
// refused (never converted); the causal functions write the design's currency and refuse mixed inputs.

const EUR_ACCOUNT = '00000000-0000-4000-8000-0000000000e1'
const USD_ACCOUNT = '00000000-0000-4000-8000-0000000000e2'
let db: PGlite

const event = (currency: string, id: string, outcome: string) => ({
  id, processor_event_id: `evt_${id.slice(-4)}`, processor_transaction_id: `txn_${id.slice(-4)}`, event_kind: 'payment_settled',
  occurred_at: '2026-08-01T12:00:00Z', available_at: '2026-08-02T12:00:00Z', currency, outcome_id: outcome,
  collected_ex_tax_minor: 20_000, refunds_ex_tax_minor: 0, chargebacks_ex_tax_minor: 0, recovered_chargebacks_ex_tax_minor: 0,
  payment_fees_minor: 600, tax_amount_minor: 1_400, source_fingerprint: `sha256:${'a'.repeat(64)}`,
})

function commit(account: string, batch: string, events: unknown[]) {
  return db.query<{ result: Record<string, unknown> }>(`
    SELECT public.commit_processor_settlement_batch($1::uuid,$2::uuid,'unknown_processor','merchant_1',
      '2026-08-01T00:00:00Z'::timestamptz,'2026-08-03T00:00:00Z'::timestamptz,'cursor_1',true,ARRAY[]::text[],$3::jsonb,1,$4) AS result`,
  [account, batch, JSON.stringify(events), `sha256:${'b'.repeat(64)}`])
}

async function outcome(account: string, n: number, currency: string): Promise<string> {
  const source = await ensureAcuitySource(db, account)
  await db.query(`INSERT INTO public.outcomes (id, ad_account_id, source_id, external_id, outcome_type, currency)
    VALUES ($1, $2, $3, $4, 'booking', $5)`, [outcomeUuid(n), account, source, String(n), currency])
  return outcomeUuid(n)
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, EUR_ACCOUNT)
  await db.query(`UPDATE public.ad_accounts SET currency = 'EUR' WHERE id = $1`, [EUR_ACCOUNT])
  await insertAdAccount(db, USD_ACCOUNT)
})

describe('account currency in the economics ledgers', () => {
  it('commits a EUR settlement on a EUR account and sums it in minor units', async () => {
    const id = await outcome(EUR_ACCOUNT, 301, 'EUR')
    const result = await commit(EUR_ACCOUNT, '00000000-0000-4000-8000-0000000003b1', [event('EUR', '00000000-0000-4000-8000-0000000003e1', id)])
    expect(result.rows[0].result).toMatchObject({ complete: true, event_count: 1 })
    const { rows } = await db.query<{ currency: string; collected: string }>(
      `select currency, sum(collected_ex_tax_minor)::text collected from public.processor_settlement_events where ad_account_id = $1 group by 1`, [EUR_ACCOUNT])
    expect(rows).toEqual([{ currency: 'EUR', collected: '20000' }])
  })

  it('refuses a USD settlement on the EUR account (mixed currencies are refused, never converted)', async () => {
    const id = await outcome(EUR_ACCOUNT, 302, 'EUR')
    await expect(commit(EUR_ACCOUNT, '00000000-0000-4000-8000-0000000003b2', [event('USD', '00000000-0000-4000-8000-0000000003e2', id)]))
      .rejects.toThrow(/settlement_event_currency: currency USD does not match the ad account currency EUR/)
    const { rows } = await db.query<{ n: number }>(`select count(*)::int n from public.processor_settlement_events`)
    expect(rows[0].n).toBe(0)
  })

  it('still refuses EUR on a USD account, and a malformed code anywhere (controls)', async () => {
    const id = await outcome(USD_ACCOUNT, 303, 'USD')
    await expect(commit(USD_ACCOUNT, '00000000-0000-4000-8000-0000000003b3', [event('EUR', '00000000-0000-4000-8000-0000000003e3', id)]))
      .rejects.toThrow(/settlement_event_currency/)
    await expect(commit(USD_ACCOUNT, '00000000-0000-4000-8000-0000000003b4', [event('usd', '00000000-0000-4000-8000-0000000003e4', id)]))
      .rejects.toThrow()
    const usd = await commit(USD_ACCOUNT, '00000000-0000-4000-8000-0000000003b5', [event('USD', '00000000-0000-4000-8000-0000000003e5', id)])
    expect(usd.rows[0].result).toMatchObject({ complete: true, event_count: 1 })
  })

  it('has no USD-only CHECK, default or literal left in the economics and causal schema', async () => {
    const { rows } = await db.query<{ o: string }>(`
      select conrelid::regclass::text || ' ' || conname o from pg_constraint
       where connamespace = 'public'::regnamespace and pg_get_constraintdef(oid) ~ '''USD'''
      union all select 'default ' || table_name || '.' || column_name from information_schema.columns
       where table_schema = 'public' and column_default ~ '''USD''' and table_name <> 'ad_accounts'
      union all select 'function ' || proname from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~ '''USD'''
        -- meta_currency_offset is Meta's whole currency table (USD among ~66 codes), not a USD default.
        and proname <> 'meta_currency_offset'`)
    expect(rows).toEqual([])
    const { rows: table } = await db.query<{ eur: number; jpy: number; krw: number }>(
      `select meta_currency_offset('EUR') eur, meta_currency_offset('JPY') jpy, meta_currency_offset('KRW') krw`)
    expect(table[0]).toEqual({ eur: 100, jpy: 1, krw: 1 })
    const { rows: guard } = await db.query<{ s: string }>(`select prosrc s from pg_proc where proname = 'materialize_causal_contribution_outcomes'`)
    expect(guard[0].s).toMatch(/refuses mixed currencies/)
    expect(guard[0].s).toMatch(/v_design\.currency,v_now/)
  })

  it('every currency-carrying economics table has the account-currency guard', async () => {
    const { rows } = await db.query<{ t: string }>(`
      select c.relname t from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
       where tg.tgname = c.relname || '_account_currency' and not tg.tgisinternal order by 1`)
    expect(rows.map((r) => r.t)).toEqual([
      'causal_contribution_estimates', 'causal_contribution_generations', 'causal_contribution_unit_outcomes',
      'causal_measurement_design_versions', 'economics_policy_versions', 'outcomes', 'processor_settlement_events', 'variable_cost_events',
    ])
  })
})
