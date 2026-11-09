import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertOutcome, outcomeUuid } from './acuity-harness'

const ACCOUNT = '00000000-0000-4000-8000-000000000790'
const TOUCH = '00000000-0000-4000-8000-000000000791'
const ATTRIBUTION_RECORD_ID = '00000000-0000-4000-8000-000000000792'
const HASH = `sha256:${'a'.repeat(64)}`
let db: PGlite

async function initialize(): Promise<void> {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_79')
  // scheduled_by NULL with an observed origin: a by-id-observed client booking.
  await insertOutcome(db, 101, {
    occurred_at: '2026-07-02T12:00:00Z', origin: 'website',
    origin_observed_at: '2026-07-02T12:00:00Z', origin_observed_source: 'webhook',
  }, ACCOUNT)
}

async function insertTouch(observedAt: string, createdAt: string): Promise<void> {
  await db.query(`INSERT INTO public.paid_touch_observations(
    id,ad_account_id,browser_capture_id,observed_at,source,fbclid,
    meta_campaign_id,meta_adset_id,meta_ad_id,utm_source,utm_medium,
    landing_url,contract_version,capture_fingerprint,created_at)
  VALUES ($1,$2,'00000000-0000-4000-8000-000000000793',$3,'meta','fbclid',
    '1001','2001','3001','meta','paid_social','https://example.com',1,$4,$5)`, [
    TOUCH, ACCOUNT, observedAt, HASH, createdAt,
  ])
}

beforeEach(async () => initialize())

describe('paid-touch temporal integrity', () => {
  it('rejects observations recorded before they were observed and links recorded before booking', async () => {
    await expect(insertTouch('2026-07-03T00:00:00Z', '2026-07-02T00:00:00Z'))
      .rejects.toThrow(/chronology|check constraint/i)

    await insertTouch('2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    await db.query(`INSERT INTO public.paid_attribution_tokens(
      id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,
      policy_version,issued_at,expires_at,created_at)
    VALUES ($1,$2,$3,$3,$3,$4,1,'2026-07-01T10:00:00Z','2026-10-01T10:00:00Z','2026-07-01T10:00:00Z')`, [
      ATTRIBUTION_RECORD_ID, ACCOUNT, TOUCH, HASH,
    ])
    await expect(db.query(`INSERT INTO public.outcome_touch_links(
      ad_account_id,outcome_id,token_id,first_touch_id,last_touch_id,
      first_interaction_at,last_interaction_at,outcome_created_at,policy_version,linked_at)
    VALUES ($1,$4,$2,$3,$3,'2026-07-01T10:00:00Z','2026-07-01T10:00:00Z',
      '2026-07-02T12:00:00Z',1,'2026-07-02T11:59:59Z')`, [ACCOUNT, ATTRIBUTION_RECORD_ID, TOUCH, outcomeUuid(101)]))
      .rejects.toThrow(/chronology|check constraint/i)
  })
})
