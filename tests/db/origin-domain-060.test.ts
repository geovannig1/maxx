import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './acuity-harness'

// REAL-POSTGRES proofs for the origin-domain vocabulary (baseline schema).
//
// 059 stated the origin rule only in a COMMENT; 4673eb2 enforced it in the ledger writer. 060 narrows
// the allowed VOCABULARY and requires the at/source pair to be coherent.
//
// WHAT THESE CONSTRAINTS DO NOT DO — stated plainly because an earlier version of this file
// overclaimed it: they cannot verify AUTHENTICITY. A direct SQL INSERT writing
// origin_observed_source='webhook' is accepted, because the database cannot know which process wrote
// a row. Authenticity is enforced one layer up (ORIGIN_OBSERVING_SOURCES in lib/outcomes/adapters/acuity/ledger.ts) and
// is covered by the ledger unit tests and the lifecycle integration test. What 060 does prevent is a
// row claiming a source that NO honest writer could produce, and a half-populated pair.

const ACCOUNT = '00000000-0000-4000-8000-000000000060'

async function freshDb(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_060')
  return db
}

const insert = (db: PGlite, id: number, cols: Record<string, unknown>) => insertOutcome(db, id, cols, ACCOUNT)

describe('origin domain — the VOCABULARY is enforced against raw SQL (authenticity is not)', () => {
  it('rejects an out-of-domain source even from a direct INSERT', async () => {
    const db = await freshDb()
    await expect(insert(db, 30, { gross_value: 300, status: 'confirmed', origin_observed_at: '2026-05-10T12:00:00Z', origin_observed_source: 'sweep' }))
      .rejects.toThrow(/outcomes_origin_source_domain/)
  })

  it('rejects a half-populated pair from a direct INSERT', async () => {
    const db = await freshDb()
    await expect(insert(db, 31, { gross_value: 300, status: 'confirmed', origin_observed_at: null, origin_observed_source: 'webhook' }))
      .rejects.toThrow(/outcomes_origin_pair_coherent/)
  })

  it('CANNOT tell a forged in-domain claim from a real one — the limit, stated', async () => {
    // A raw INSERT labelling itself 'webhook' is accepted. This is not a gap the database can close;
    // it is why the writer-side allowlist and its tests exist. Pinned so the claim is never inflated.
    const db = await freshDb()
    await insert(db, 34, { gross_value: 300, status: 'confirmed', origin_observed_at: '2026-05-10T12:00:00Z', origin_observed_source: 'webhook' })
    const { rows } = await db.query<{ s: string }>(`SELECT origin_observed_source AS s FROM outcomes WHERE id=$1`, [outcomeUuid(34)])
    expect(rows[0].s).toBe('webhook')
  })

  it('still allows the honest states: a real observation, and unknown', async () => {
    const db = await freshDb()
    await insert(db, 32, { gross_value: 300, status: 'confirmed', origin_observed_at: '2026-05-10T12:00:00Z', origin_observed_source: 'webhook' })
    await insert(db, 33, { gross_value: 300, status: 'confirmed' })
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outcomes`)
    expect(rows[0].n).toBe(2)
  })
})

describe('v_business_outcomes — the canonical booking rule lives next to the data', () => {
  it('classifies the observed comp, an active comp, and a real booking distinctly', async () => {
    const db = await freshDb()
    // The motivating shape: charged 0, NOMINAL 125, canceled. GA reported $125 for this.
    // price_sold is no longer a column; the nominal Acuity value survives only in raw.
    await insert(db, 40, { gross_value: 0, raw: { priceSold: '125.00' }, status: 'cancelled' })
    await insert(db, 41, { gross_value: 0, raw: { priceSold: '125.00' }, status: 'confirmed' })
    await insert(db, 42, { gross_value: 220, raw: { priceSold: '220.00' }, status: 'confirmed' })

    const { rows } = await db.query<{ id: string; st: string }>(
      `SELECT id, business_state AS st FROM v_business_outcomes ORDER BY external_id::bigint`)
    // The vocabulary is deliberately NOT 'comp'/'test': an active $0 appointment may be a package,
    // gift certificate, staff block, comp or test, and the ledger cannot distinguish them.
    expect(rows.map((r) => r.st)).toEqual(['cancelled', 'active_zero_value', 'active_value_bearing'])

    // Revenue is sum(gross_value) over business rows only — never price_sold.
    const { rows: t } = await db.query<{ n: number; rev: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(gross_value),0) AS rev FROM v_business_outcomes WHERE business_state='active_value_bearing'`)
    expect(t[0].n).toBe(1)
    expect(Number(t[0].rev)).toBe(220)
  })
})
