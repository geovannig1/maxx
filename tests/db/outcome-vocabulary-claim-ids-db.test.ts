import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb } from './schema-db'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'

// claim ids written before the v1 release embedded the reference source after a `report:` segment. A forward
// migration rewrote them in stored documents; since the v1 release the schema ships as one baseline and no install
// holds such documents, so that rewrite is gone. The read-time upgrade for fingerprinted documents and
// the report guards remain.

const ID = 'report:acuity:business:00000000-0000-4000-8000-000000000001:booked_value:2026-09-02:2026-09-04'
const LEGACY = {
  claims: [{ claimId: ID, inputClaimIds: [ID, 'report:meta:account:x'], source: { system: 'outcomes' } }],
  byId: { [ID]: 1 },
  note: 'free text mentioning report:acuity: stays',
}
const EXPECTED = {
  claims: [{ claimId: ID.replace('report:acuity:', 'report:outcomes:'), inputClaimIds: [ID.replace('report:acuity:', 'report:outcomes:'), 'report:meta:account:x'], source: { system: 'outcomes' } }],
  byId: { [ID.replace('report:acuity:', 'report:outcomes:')]: 1 },
  note: 'free text mentioning report:acuity: stays',
}

const guards = async (db: PGlite, table: string) => (await db.query<{ t: string }>(
  `select tgname || ':' || tgenabled::text t from pg_trigger where tgrelid = ('public.' || $1)::regclass and not tgisinternal order by 1`, [table])).rows.map((r) => r.t)

describe('claim-id vocabulary', () => {
  let db: PGlite

  beforeAll(async () => { db = await freshSchemaDb() }, 120_000)
  afterAll(async () => db.close())

  it('ships the daily report guards enabled', async () => {
    const reportGuards = await guards(db, 'daily_reports')
    expect(reportGuards.length).toBeGreaterThan(0)
    expect(reportGuards.filter((g) => !g.endsWith(':O'))).toEqual([])
  })

  it('upgrades legacy claim ids at read time, leaving free text alone', () => {
    expect(upgradeLegacyVocabulary(LEGACY)).toEqual(EXPECTED)
    // Control: a document without a legacy claim id is unchanged.
    const plain = { claimId: 'report:meta:account:y', note: 'prose about report:acuity: ids' }
    expect(upgradeLegacyVocabulary(plain)).toEqual(plain)
  })
})
