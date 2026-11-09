import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// money columns typed numeric(14,2) / numeric(10,2) silently rounded a three-decimal currency
// (KWD 3.333 stored as 3.33). The shipped schema has them as unconstrained numeric, as the outcome tables
// already are, and names alerts.dollars_at_risk amount_at_risk. Since the v1 release the schema ships as one baseline,
// so these assertions run on it; the upgrade from the old types is no longer a path any install takes.

const ACCOUNT = '00000000-0000-4000-8000-000000000001'

/** Every widened money column, by table. */
const WIDENED: Record<string, string[]> = {
  ad_accounts: ['amount_spent', 'spend_cap'],
  adsets: ['bid_amount', 'daily_budget', 'lifetime_budget'],
  alerts: ['amount_at_risk'],
  campaigns: ['daily_budget', 'lifetime_budget'],
  competitor_sources: ['hourly_rate_low', 'hourly_rate_high'],
  insight_breakdowns: ['spend', 'cpa'],
  learned_patterns: ['sample_spend', 'cpa'],
  tests: ['budget_daily', 'min_spend_threshold'],
}
const TABLES = Object.keys(WIDENED)

/** Constrained numeric columns that are NOT money and may keep a scale below four (ISO 4217's largest
 *  minor unit is four digits: CLF, UYW). Every other constrained numeric column must hold four decimals. */
const NON_MONEY_LOW_SCALE = ['learned_patterns.win_rate']

/** One row per table, ids fixed, every widened column set to `amount`. */
async function seedRows(db: PGlite, amount: string) {
  const set = (table: string) => WIDENED[table]
  const values = (table: string) => WIDENED[table].map(() => amount).join(', ')
  await db.query(`UPDATE public.ad_accounts SET (${set('ad_accounts').join(', ')}) = ROW(${values('ad_accounts')}) WHERE id = $1`, [ACCOUNT])
  await db.query(`INSERT INTO public.campaigns (id, ad_account_id, campaign_id, ${set('campaigns')}) VALUES ($1, $2, 'c-1', ${values('campaigns')})`, [ACCOUNT, ACCOUNT])
  await db.query(`INSERT INTO public.adsets (id, ad_account_id, campaign_id, adset_id, ${set('adsets')}) VALUES ($1, $2, $1, 's-1', ${values('adsets')})`, [ACCOUNT, ACCOUNT])
  await db.query(`INSERT INTO public.alerts (ad_account_id, alert_date, alert_type, title, message, ${set('alerts')}) VALUES ($1, '2026-11-01', 'spend_spike', 't', 'm', ${values('alerts')})`, [ACCOUNT])
  await db.query(`INSERT INTO public.competitor_sources (ad_account_id, name, ${set('competitor_sources')}) VALUES ($1, 'n', ${values('competitor_sources')})`, [ACCOUNT])
  await db.query(`INSERT INTO public.insight_breakdowns (ad_account_id, date_start, entity_level, meta_entity_id, breakdown_type, breakdown_value, ${set('insight_breakdowns')}) VALUES ($1, '2026-11-01', 'ad', 'e', 'age', '25-34', ${values('insight_breakdowns')})`, [ACCOUNT])
  await db.query(`INSERT INTO public.learned_patterns (ad_account_id, dimension, segment, verdict, ${set('learned_patterns')}) VALUES ($1, 'd', 's', 'v', ${values('learned_patterns')})`, [ACCOUNT])
  await db.query(`INSERT INTO public.tests (ad_account_id, test_name, hypothesis, test_type, ${set('tests')}) VALUES ($1, 'n', 'h', 't', ${values('tests')})`, [ACCOUNT])
}

async function storedText(db: PGlite, table: string, column: string): Promise<string[]> {
  const { rows } = await db.query<{ v: string }>(`SELECT ${column}::text AS v FROM public.${table} ORDER BY 1`)
  return rows.map((r) => r.v)
}

/** Constrained numeric table columns whose scale cannot hold every ISO currency. */
async function lowScaleColumns(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ col: string }>(`
    SELECT c.relname || '.' || a.attname AS col
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'numeric'::regtype AND a.atttypmod <> -1 AND ((a.atttypmod - 4) & 65535) < 4
     ORDER BY 1`)
  return rows.map((r) => r.col)
}
const unlisted = (cols: string[]) => cols.filter((col) => !NON_MONEY_LOW_SCALE.includes(col))

describe('money columns hold any ISO currency', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await freshSchemaDb()
    await insertAdAccount(db, ACCOUNT)
    await seedRows(db, '12.34')
    // Control: the old two-decimal type silently rounds a three-decimal amount (the defect).
    expect((await db.query<{ v: string }>(`SELECT 3.333::numeric(14,2)::text AS v`)).rows[0].v).toBe('3.33')
  })
  afterAll(async () => { await db?.close() })

  it('stores a USD value exactly in every widened column (control)', async () => {
    for (const table of TABLES) {
      for (const column of WIDENED[table]) expect(await storedText(db, table, column), `${table}.${column}`).toEqual(['12.34'])
    }
  })

  it('stores a three-decimal KWD amount exactly in every widened column', async () => {
    for (const table of TABLES) {
      for (const column of WIDENED[table]) {
        await db.query(`UPDATE public.${table} SET ${column} = $1::numeric`, ['3.333'])
        expect(await storedText(db, table, column), `${table}.${column}`).toEqual(['3.333'])
        const { rows } = await db.query<{ t: string }>(
          `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = ('public.' || $1)::regclass AND attname = $2`, [table, column])
        expect(rows[0]?.t, `${table}.${column}`).toBe('numeric')
      }
    }
  })

  it('names the column amount_at_risk, with its index', async () => {
    const cols = await db.query<{ attname: string }>(`SELECT attname FROM pg_attribute WHERE attrelid = 'public.alerts'::regclass AND attname LIKE '%at_risk'`)
    expect(cols.rows.map((r) => r.attname)).toEqual(['amount_at_risk'])
    const idx = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'alerts' AND indexname LIKE '%at_risk'`)
    expect(idx.rows.map((r) => r.indexname)).toEqual(['idx_alerts_amount_at_risk'])
    expect(idx.rows[0].indexdef).toContain('amount_at_risk DESC NULLS LAST')
  })

  it('keeps row-level security on and the browser roles without grants on every affected table', async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1) ORDER BY 1`, [TABLES])
    expect(rls.rows.map((r) => r.relname)).toEqual([...TABLES].sort())
    expect(rls.rows.every((r) => r.relrowsecurity === true), 'RLS on').toBe(true)
    const grants = await db.query<{ table_name: string; grantee: string }>(
      `SELECT table_name, grantee FROM information_schema.role_table_grants WHERE table_schema = 'public' AND table_name = ANY($1)`, [TABLES])
    expect(grants.rows.length, 'the grant query sees the service role (non-vacuous)').toBeGreaterThan(0)
    expect(grants.rows.filter((g) => g.grantee === 'anon' || g.grantee === 'authenticated')).toEqual([])
  })
})

describe('population: no constrained numeric column rounds below four decimals unless listed as non-money', () => {
  it('flags a planted two-decimal money column and accepts the shipped schema', async () => {
    const db = await freshSchemaDb()
    try {
      // The non-money list is exactly what the instrument finds: no stale entry, nothing unlisted.
      expect(await lowScaleColumns(db)).toEqual(NON_MONEY_LOW_SCALE)
      // Planted control: the same instrument must report a two-decimal money column it has never seen.
      await db.exec(`CREATE TABLE public.zz_planted (spend numeric(14,2), ratio numeric(10,6))`)
      expect(unlisted(await lowScaleColumns(db))).toEqual(['zz_planted.spend'])
    } finally {
      await db.close()
    }
  })
})

// numeric(14,4) / numeric(10,4) money columns capped an amount at 9,999,999,999.9999 (CPC and CPM at
// 999,999.9999), too small for large-unit currencies (IDR, VND, IRR totals). Every money column is now
// unconstrained numeric. The constrained numeric columns that remain are listed here with their reason.
const CONSTRAINED_NON_MONEY: Record<string, string> = {
  'causal_contribution_estimates.bootstrap_probability_positive': 'probability',
  'causal_contribution_estimates.confidence_level': 'probability',
  'causal_contribution_estimates.estimate_minor': 'minor units of the row currency; deliberate 4-decimal statistic',
  'causal_contribution_estimates.interval_lower_minor': 'minor units of the row currency; deliberate 4-decimal statistic',
  'causal_contribution_estimates.interval_upper_minor': 'minor units of the row currency; deliberate 4-decimal statistic',
  'causal_measurement_design_versions.confidence_level': 'probability',
  'daily_insights.ctr': 'rate',
  'daily_insights.frequency': 'ratio',
  'daily_insights.hold_rate': 'rate',
  'daily_insights.hook_rate': 'rate',
  'daily_insights.roas': 'ratio',
  'daily_insights.video_avg_play_time': 'seconds',
  'daypart_insights.ctr': 'rate',
  'flags.ctr_in_window': 'rate',
  'flags.frequency_in_window': 'ratio',
  'insight_breakdowns.ctr': 'rate',
  'learned_patterns.ctr': 'rate',
  'learned_patterns.win_rate': 'rate',
}

/** Every money column the scale migration widened, by table. */
const P7_WIDENED: Record<string, string[]> = {
  alerts: ['baseline_value', 'metric_value', 'threshold_value'],
  daily_insights: ['appointment_value', 'cost_per_booking', 'cost_per_lead', 'cpc', 'cpm', 'spend'],
  daily_reports: ['avg_cpb', 'avg_cpl', 'total_spend'],
  daypart_insights: ['cpa', 'spend'],
  flags: ['cpa_in_window', 'spend_in_window'],
  recommendation_outcomes: ['baseline_value', 'observed_value'],
}

async function constrainedNumericColumns(db: PGlite): Promise<string[]> {
  const { rows } = await db.query<{ col: string }>(`
    SELECT c.relname || '.' || a.attname AS col
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
       AND a.atttypid = 'numeric'::regtype AND a.atttypmod <> -1
     ORDER BY 1`)
  return rows.map((r) => r.col)
}

describe('scale migration population: no money column is a constrained numeric', () => {
  it('lists exactly the constrained numeric columns that are not money, and flags a planted money column', async () => {
    const db = await freshSchemaDb()
    try {
      expect(await constrainedNumericColumns(db)).toEqual(Object.keys(CONSTRAINED_NON_MONEY).sort())
      // Planted control: a numeric(14,4) spend column, the removed shape, is reported by the same instrument.
      await db.exec(`CREATE TABLE public.zz_planted (spend numeric(14,4), ctr numeric(10,6))`)
      const unlistedCols = (await constrainedNumericColumns(db)).filter((col) => !(col in CONSTRAINED_NON_MONEY))
      expect(unlistedCols).toEqual(['zz_planted.ctr', 'zz_planted.spend'])
    } finally {
      await db.close()
    }
  })

  it('stores an amount beyond the old numeric(14,4) cap exactly in every widened column', async () => {
    const db = await freshSchemaDb()
    try {
      for (const [table, columns] of Object.entries(P7_WIDENED)) {
        for (const column of columns) {
          const { rows } = await db.query<{ t: string }>(
            `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = ('public.' || $1)::regclass AND attname = $2`, [table, column])
          expect(rows[0]?.t, `${table}.${column}`).toBe('numeric')
        }
      }
      // Control: the old type refuses the amount (the defect), so the column check above is not vacuous.
      await expect(db.query(`SELECT 12345678901.5::numeric(14,4)`)).rejects.toThrow(/overflow/i)
      await insertAdAccount(db, ACCOUNT)
      await db.query(`INSERT INTO public.alerts (ad_account_id, alert_date, alert_type, title, message, metric_value, baseline_value, threshold_value)
        VALUES ($1, '2026-11-01', 'spend_spike', 't', 'm', 12345678901.5, 1234567.123456, 0.0001)`, [ACCOUNT])
      const { rows } = await db.query<{ m: string; b: string; t: string }>(`SELECT metric_value::text m, baseline_value::text b, threshold_value::text t FROM public.alerts`)
      expect(rows[0]).toEqual({ m: '12345678901.5', b: '1234567.123456', t: '0.0001' })
    } finally {
      await db.close()
    }
  })
})
