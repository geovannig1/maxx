import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

// documents stored before the v1 release named the reference outcome source in shared vocabulary. A forward
// migration rewrote stored documents; since the v1 release the schema ships as one baseline and no install holds such
// documents, so that rewrite is gone. What remains shipped: the paid-cohort commit's renamed metric key,
// the append-only guards, and the application's read-time upgrade for fingerprinted documents.

const ACCOUNT = '00000000-0000-4000-8000-000000000001'

const LEGACY = {
  acuity: { acuityRecordedRevenue: 120.5, acuityRecordedAmountPaid: 100, valueBearingBookings: 3, todayAcuityRecordedRevenue: null },
  sources: { acuity: { availability: 'available', blockerCodes: ['acuity_window_invalid:lastDay', 'acuity:acuity_reader_missing'] } },
  claims: [{ metricKey: 'acuity.booked_value', source: { system: 'acuity', evidencePlane: 'acuity_business' },
    entity: { level: 'business', id: 'acuity-type:7' }, label: 'Acuity booked value', other: 'acuity-name:Studio', unit: 'usd' }],
  metrics: { acuity_recorded_revenue: 99, snapshotAcuityAvailable: true },
  notes: ['Acuity ledger reconciled'],
}
const EXPECTED = {
  outcomes: { recordedOutcomeValue: 120.5, observedCollectedValue: 100, valueBearingBookings: 3, todayRecordedOutcomeValue: null },
  sources: { outcomes: { availability: 'available', blockerCodes: ['outcome_window_invalid:lastDay', 'outcomes:outcome_reader_missing'] } },
  claims: [{ metricKey: 'outcomes.booked_value', source: { system: 'outcomes', evidencePlane: 'outcome_business' },
    entity: { level: 'business', id: 'outcome-type:7' }, label: 'Acuity booked value', other: 'outcome-label:Studio', unit: 'money' }],
  metrics: { outcome_recorded_revenue: 99, snapshotOutcomeAvailable: true },
  notes: ['Acuity ledger reconciled'],
}

async function enabledGuards(db: PGlite, table: string): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `select tgname || ':' || tgenabled::text t from pg_trigger where tgrelid = ('public.' || $1)::regclass and not tgisinternal order by 1`, [table])
  return rows.map((r) => r.t)
}

describe('outcome vocabulary in stored JSON documents', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await freshSchemaDb()
    await insertAdAccount(db, ACCOUNT)
    await db.query(`INSERT INTO public.executive_evidence_generations
        (ad_account_id, report_date, contract_version, evidence_json, evidence_fingerprint, source_generated_at)
      VALUES ($1, '2026-10-01', 1, $2, 'sha256:' || repeat('a', 64), now())`, [ACCOUNT, JSON.stringify({
      contract: 'executive_evidence_snapshot', version: 1, account: { id: ACCOUNT }, lastCompleteDate: '2026-10-01',
      authority: { tier: 'diagnostic_only', moneyActionsAuthorized: false }, ...EXPECTED })])
  }, 120_000)
  afterAll(async () => db.close())

  it('keeps every append-only guard enabled, and the guard refuses an update', async () => {
    for (const table of ['daily_reports', 'executive_evidence_generations', 'paid_cohort_units']) {
      const guards = await enabledGuards(db, table)
      expect(guards.length, table).toBeGreaterThan(0)
      expect(guards.filter((g) => !g.endsWith(':O')), table).toEqual([])
    }
    await expect(db.query(`update public.executive_evidence_generations set report_date = report_date`)).rejects.toThrow()
  })

  it('makes the paid-cohort commit require the renamed revenue metric key', async () => {
    const { rows } = await db.query<{ s: string }>(`select prosrc s from pg_proc where proname = 'commit_paid_cohort_pair'`)
    expect(rows[0].s).toContain(`'outcome_recorded_revenue'`)
    expect(rows[0].s).not.toMatch(/acuity/i)
  })

  it('upgrades a legacy document at read time, and leaves an upgraded one unchanged', () => {
    expect(upgradeLegacyVocabulary(LEGACY)).toEqual(EXPECTED)
    expect(upgradeLegacyVocabulary(EXPECTED)).toEqual(EXPECTED)
  })
})
