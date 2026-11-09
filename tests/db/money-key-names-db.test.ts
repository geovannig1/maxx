import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

// documents stored before the v1 release named money keys after one currency (spendUsd, daily_usd, ...). A
// forward migration rewrote stored documents; since the v1 release the schema ships as one baseline and no install
// holds such documents, so that rewrite is gone. What remains shipped: the application's read-time
// upgrade for fingerprinted documents (same map, src/lib/outcomes/legacy-money-keys.ts), and the
// append-only guards on the documents it reads.

const ACCOUNT = '00000000-0000-4000-8000-000000000001'

const LEGACY = {
  meta: { spendUsd: 120.5, modeledBookingValueUsd: null, weeks: [{ spendUsd: 3, impressions: 10 }] },
  outcomes: { activeAmountPaidRevenueUsd: 99, bookedValueUsd: 150, activeAmountPaidObservedUsd: 90 },
  setup: { budget: { daily_usd: 40, lifetime_usd: null }, bid: { strategy: 'LOWEST_COST', amount_usd: null } },
  metricKey: 'currentAccountDailyBudgetUsd',
  notes: ['spendUsd is mentioned in free text'],
}
const EXPECTED = {
  meta: { spendAmount: 120.5, modeledBookingValue: null, weeks: [{ spendAmount: 3, impressions: 10 }] },
  outcomes: { activeAmountPaidRevenue: 99, bookedValue: 150, activeAmountPaidObserved: 90 },
  setup: { budget: { daily_amount: 40, lifetime_amount: null }, bid: { strategy: 'LOWEST_COST', amount: null } },
  metricKey: 'currentAccountDailyBudget',
  notes: ['spendUsd is mentioned in free text'],
}

async function enabledGuards(db: PGlite, table: string): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `select tgname || ':' || tgenabled::text t from pg_trigger where tgrelid = ('public.' || $1)::regclass and not tgisinternal order by 1`, [table])
  return rows.map((r) => r.t)
}

describe('currency-neutral money keys', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await freshSchemaDb()
    await insertAdAccount(db, ACCOUNT)
    await db.query(`INSERT INTO public.executive_evidence_generations
        (ad_account_id, report_date, contract_version, evidence_json, evidence_fingerprint, source_generated_at)
      VALUES ($1, '2026-10-01', 1, $2, 'sha256:' || repeat('b', 64), now())`, [ACCOUNT, JSON.stringify({
      contract: 'executive_evidence_snapshot', version: 1, account: { id: ACCOUNT }, lastCompleteDate: '2026-10-01',
      authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false }, ...EXPECTED })])
  }, 120_000)
  afterAll(async () => db.close())

  it('keeps every append-only guard enabled, and the guard refuses an update', async () => {
    for (const table of ['daily_reports', 'executive_evidence_generations', 'action_decisions']) {
      const guards = await enabledGuards(db, table)
      expect(guards.length, table).toBeGreaterThan(0)
      expect(guards.filter((g) => !g.endsWith(':O')), table).toEqual([])
    }
    await expect(db.query(`update public.executive_evidence_generations set report_date = report_date`)).rejects.toThrow()
  })

  it('upgrades a legacy document at read time, and leaves an upgraded one unchanged', () => {
    expect(upgradeLegacyVocabulary(LEGACY)).toEqual(EXPECTED)
    expect(upgradeLegacyVocabulary(EXPECTED)).toEqual(EXPECTED)
  })
})
