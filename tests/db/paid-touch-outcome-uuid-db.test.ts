import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './acuity-harness'
import { pgliteSupabase } from './postgrest-pglite'
import { readPaidTouchAdAssignments } from '@/lib/economics/paid-touch-assignment-reader'

// Paid-touch ad assignments are keyed by OUTCOME UUID (`outcomeId`), so an outcome from any
// source resolves, including one whose external id is not a number. Real schema, real triggers.

const ACCOUNT = '00000000-0000-4000-8000-000000000890'
const WEBHOOK_SOURCE = '00000000-0000-4000-c000-000000000890'
const WEBHOOK_OUTCOME = '00000000-0000-4000-9000-000000000890'
const TOUCH = '00000000-0000-4000-8000-000000000891'
const ATTRIBUTION_RECORD = '00000000-0000-4000-8000-000000000892'
const HASH = `sha256:${'b'.repeat(64)}`
let db: PGlite

async function link(outcomeId: string): Promise<void> {
  await db.query(`INSERT INTO public.outcome_touch_links(
    ad_account_id,outcome_id,token_id,first_touch_id,last_touch_id,
    first_interaction_at,last_interaction_at,outcome_created_at,policy_version,linked_at)
  VALUES ($1,$2,$3,$4,$4,'2026-07-01T10:00:00Z','2026-07-01T10:00:00Z','2026-07-02T12:00:00Z',1,'2026-07-02T12:00:01Z')`,
  [ACCOUNT, outcomeId, ATTRIBUTION_RECORD, TOUCH])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_89')
  const website = { occurred_at: '2026-07-02T12:00:00Z', origin: 'website', origin_observed_at: '2026-07-02T12:00:00Z', origin_observed_source: 'webhook' }
  await insertOutcome(db, 101, website, ACCOUNT)
  await db.query(`INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled) VALUES ($1, $2, 'webhook', 'Shop', true)`, [WEBHOOK_SOURCE, ACCOUNT])
  await db.query(`INSERT INTO public.outcomes (id, ad_account_id, source_id, external_id, outcome_type, currency, status, occurred_at, origin, origin_observed_at, origin_observed_source)
    VALUES ($1, $2, $3, 'order-1001', 'sale', 'USD', 'confirmed', '2026-07-02T12:00:00Z', 'website', '2026-07-02T12:00:00Z', 'webhook')`, [WEBHOOK_OUTCOME, ACCOUNT, WEBHOOK_SOURCE])
  await db.query(`INSERT INTO public.paid_touch_observations(
    id,ad_account_id,browser_capture_id,observed_at,source,fbclid,meta_campaign_id,meta_adset_id,meta_ad_id,
    utm_source,utm_medium,landing_url,contract_version,capture_fingerprint,created_at)
  VALUES ($1,$2,'00000000-0000-4000-8000-000000000893','2026-07-01T10:00:00Z','meta','fbclid','1001','2001','3001',
    'meta','paid_social','https://example.com',1,$3,'2026-07-01T10:00:00Z')`, [TOUCH, ACCOUNT, HASH])
  await db.query(`INSERT INTO public.paid_attribution_tokens(id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,policy_version,issued_at,expires_at,created_at)
    VALUES ($1,$2,$3,$3,$3,$4,1,'2026-07-01T10:00:00Z','2026-10-01T10:00:00Z','2026-07-01T10:00:00Z')`, [ATTRIBUTION_RECORD, ACCOUNT, TOUCH, HASH])
})

describe('paid-touch assignments keyed by outcome uuid', () => {
  it('assigns a webhook outcome (non-numeric external id) and an Acuity outcome alike', async () => {
    await link(outcomeUuid(101))
    await link(WEBHOOK_OUTCOME)
    const read = await readPaidTouchAdAssignments(pgliteSupabase(db), ACCOUNT, [WEBHOOK_OUTCOME, outcomeUuid(101)], '2026-07-03T00:00:00Z')
    expect(read.requestedOutcomeCount).toBe(2)
    expect(read.assignments.map((a) => a.outcomeId).sort()).toEqual([outcomeUuid(101), WEBHOOK_OUTCOME].sort())
    expect(read.assignments[0]).toMatchObject({ metaCampaignId: '1001', metaAdsetId: '2001', metaAdId: '3001' })
    expect(read.unassignedOutcomeIds).toEqual([])
  })

  it('reports an unlinked outcome as unassigned by its uuid (control)', async () => {
    await link(outcomeUuid(101))
    const read = await readPaidTouchAdAssignments(pgliteSupabase(db), ACCOUNT, [WEBHOOK_OUTCOME, outcomeUuid(101)], '2026-07-03T00:00:00Z')
    expect(read.assignments.map((a) => a.outcomeId)).toEqual([outcomeUuid(101)])
    expect(read.unassignedOutcomeIds).toEqual([WEBHOOK_OUTCOME])
  })

  it('rejects an identity that is not an outcome uuid', async () => {
    await expect(readPaidTouchAdAssignments(pgliteSupabase(db), ACCOUNT, ['101'], '2026-07-03T00:00:00Z')).rejects.toThrow()
  })
})
