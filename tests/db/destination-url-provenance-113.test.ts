import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT = fixtureUuid(113)
const CAMPAIGN = fixtureUuid(114)
const ADSET = fixtureUuid(115)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertCampaign(db, CAMPAIGN, ACCOUNT)
  await insertAdset(db, ADSET, ACCOUNT, CAMPAIGN)
})

afterEach(async () => db.close())

// Every ad row needs its parent hierarchy; the columns under test follow it.
const PARENT_COLUMNS = 'ad_account_id,campaign_id,adset_id'
const PARENT_VALUES = `'${ACCOUNT}','${CAMPAIGN}','${ADSET}'`

describe('destination URL provenance', () => {
  it('round-trips available and unavailable observations without coercion', async () => {
    await db.exec(`
      INSERT INTO public.ads(
        ${PARENT_COLUMNS}, ad_id, destination_url, destination_url_read_available, destination_url_synced_at
      ) VALUES
        (${PARENT_VALUES}, 'available', 'https://example.com/book', true, '2026-08-16T12:00:00Z'),
        (${PARENT_VALUES}, 'unavailable', 'https://example.com/prior', false, null),
        (${PARENT_VALUES}, 'legacy', null, null, null)
    `)

    const rows = await db.query<{
      ad_id: string
      destination_url: string | null
      destination_url_read_available: boolean | null
      destination_url_synced_at: Date | null
    }>(`SELECT ad_id, destination_url, destination_url_read_available, destination_url_synced_at
        FROM public.ads ORDER BY ad_id`)
    expect(rows.rows.map((row) => ({
      ...row,
      destination_url_synced_at: row.destination_url_synced_at?.toISOString() ?? null,
    }))).toEqual([
      {
        ad_id: 'available', destination_url: 'https://example.com/book',
        destination_url_read_available: true,
        destination_url_synced_at: '2026-08-16T12:00:00.000Z',
      },
      {
        ad_id: 'legacy', destination_url: null,
        destination_url_read_available: null, destination_url_synced_at: null,
      },
      {
        ad_id: 'unavailable', destination_url: 'https://example.com/prior',
        destination_url_read_available: false, destination_url_synced_at: null,
      },
    ])
  })

  it('requires a source timestamp exactly when the field read was available', async () => {
    await expect(db.exec(`INSERT INTO public.ads(${PARENT_COLUMNS},ad_id,destination_url_read_available)
      VALUES (${PARENT_VALUES},'invalid-available',true)`)).rejects.toThrow(/destination_url_read_contract/i)
    await expect(db.exec(`INSERT INTO public.ads(
      ${PARENT_COLUMNS},ad_id,destination_url_read_available,destination_url_synced_at
    ) VALUES (${PARENT_VALUES},'invalid-unavailable',false,'2026-08-16T12:00:00Z')`))
      .rejects.toThrow(/destination_url_read_contract/i)
  })
})
