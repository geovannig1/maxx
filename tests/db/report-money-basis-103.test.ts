import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { fixtureUuid, freshSchemaDb, insertAdAccount } from './schema-db'

let db: PGlite
const ACCOUNT = fixtureUuid(1030)
const id = (n: number) => fixtureUuid(1030 + n)

// Minimal shipped-schema rows: the account and date columns the real report tables require.
function insertDaily(n: number, reportJson: unknown, revenue: number | null) {
  return db.query(`INSERT INTO public.daily_reports(id,ad_account_id,report_date,report_json,business_revenue)
    VALUES ($1,$2,'2026-08-01',$3,$4)`, [id(n), ACCOUNT, reportJson, revenue])
}
function insertWeekly(n: number, reportJson: unknown, revenue: number | null) {
  return db.query(`INSERT INTO public.weekly_reports(id,ad_account_id,week_start,week_end,report_json,business_revenue)
    VALUES ($1,$2,'2026-08-10','2026-08-16',$3,$4)`, [id(n), ACCOUNT, reportJson, revenue])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})
afterEach(async () => db.close())

describe('report money-basis contract', () => {
  it('stores complete amount_paid revenue with durable versioned lineage', async () => {
    await insertDaily(1, {
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: true,
        revenue_complete: true,
        observed_collected_value_lower_bound: 500,
        covered_outcomes: 3,
        total_outcomes: 3,
      },
    }, 500)
    const result = await db.query<Record<string, unknown>>(`SELECT * FROM public.daily_reports WHERE id=$1`, [id(1)])
    expect(result.rows[0]).toMatchObject({
      money_basis_version: 1,
      business_revenue_basis: 'outcome_collected_value',
      business_revenue_complete: true,
      collected_value_covered_outcomes: 3,
      collected_value_total_outcomes: 3,
    })
    expect(Number(result.rows[0].business_revenue)).toBe(500)
  })

  it('keeps an incomplete observed sum as a lower bound and forbids a revenue value', async () => {
    const reportJson = {
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: true,
        revenue_complete: false,
        observed_collected_value_lower_bound: 400,
        covered_outcomes: 2,
        total_outcomes: 3,
      },
    }
    await insertWeekly(1, reportJson, null)
    const result = await db.query<Record<string, unknown>>(`SELECT * FROM public.weekly_reports WHERE id=$1`, [id(1)])
    expect(result.rows[0]).toMatchObject({
      business_revenue_complete: false,
      collected_value_covered_outcomes: 2,
      collected_value_total_outcomes: 3,
    })
    expect(Number(result.rows[0].collected_value_lower_bound)).toBe(400)
    expect(result.rows[0].business_revenue).toBeNull()

    await expect(insertWeekly(2, reportJson, 400)).rejects.toThrow(/weekly_reports_money_basis_contract/)
  })

  it('distinguishes a failed ledger read from both legacy data and incomplete amount_paid coverage', async () => {
    await insertWeekly(3, {
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: false,
        revenue_complete: null,
        observed_collected_value_lower_bound: null,
        covered_outcomes: null,
        total_outcomes: null,
      },
    }, null)
    const result = await db.query<Record<string, unknown>>(`SELECT * FROM public.weekly_reports WHERE id=$1`, [id(3)])
    expect(result.rows[0]).toMatchObject({
      money_basis_version: 1,
      outcome_source_available: false,
      business_revenue_complete: null,
      collected_value_lower_bound: null,
      collected_value_covered_outcomes: null,
      collected_value_total_outcomes: null,
      business_revenue: null,
    })
  })

  it('rejects every new report that omits or malforms money_basis', async () => {
    await expect(insertDaily(5, {}, 900))
      .rejects.toThrow(/require report_json\.money_basis/i)
    await expect(insertDaily(6, {
      money_basis: { version: 'not-an-integer' },
    }, 900)).rejects.toThrow()
    await expect(insertWeekly(7, {
      money_basis: {
        version: 1,
        basis: 'outcome_collected_value',
        source_available: true,
      },
    }, 900)).rejects.toThrow(/weekly_reports_money_basis_contract/)
  })
})
