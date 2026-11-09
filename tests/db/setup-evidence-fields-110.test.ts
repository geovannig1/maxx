import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertCampaign } from './decision-fixture'

const ACCOUNT = fixtureUuid(110)
const CAMPAIGN = fixtureUuid(111)
const PARENT_ADSET = fixtureUuid(112)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertCampaign(db, CAMPAIGN, ACCOUNT)
  await db.query(
    `INSERT INTO public.adsets(id, ad_account_id, campaign_id, adset_id) VALUES ($1,$2,$3,'parent-adset')`,
    [PARENT_ADSET, ACCOUNT, CAMPAIGN],
  )
})

afterEach(async () => {
  await db.close()
})

const insertAdset = (adsetId: string, attributionSpec?: string) => db.query(
  `INSERT INTO public.adsets(ad_account_id, campaign_id, adset_id${attributionSpec ? ', attribution_spec' : ''})
   VALUES ($1,$2,$3${attributionSpec ? ',$4' : ''})`,
  [ACCOUNT, CAMPAIGN, adsetId, ...(attributionSpec ? [attributionSpec] : [])],
)

const insertAd = (adId: string, destinationUrl?: string) => db.query(
  `INSERT INTO public.ads(ad_account_id, campaign_id, adset_id, ad_id${destinationUrl ? ', destination_url' : ''})
   VALUES ($1,$2,$3,$4${destinationUrl ? ',$5' : ''})`,
  [ACCOUNT, CAMPAIGN, PARENT_ADSET, adId, ...(destinationUrl ? [destinationUrl] : [])],
)

describe('setup evidence fields', () => {
  it('round-trips observed attribution and destination without coercion', async () => {
    await insertAdset('211', '[{"event_type":"CLICK_THROUGH","window_days":7}]')
    await insertAd('311', 'https://example.com/book?offer=1')

    await expect(db.query('SELECT attribution_spec FROM public.adsets WHERE adset_id = $1', ['211']))
      .resolves.toMatchObject({
        rows: [{ attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }] }],
      })
    await expect(db.query('SELECT destination_url FROM public.ads WHERE ad_id = $1', ['311']))
      .resolves.toMatchObject({ rows: [{ destination_url: 'https://example.com/book?offer=1' }] })
  })

  it('preserves omission as nullable unknown', async () => {
    await insertAdset('unknown-adset')
    await insertAd('unknown-ad')

    await expect(db.query('SELECT attribution_spec FROM public.adsets WHERE adset_id = $1', ['unknown-adset']))
      .resolves.toMatchObject({ rows: [{ attribution_spec: null }] })
    await expect(db.query('SELECT destination_url FROM public.ads WHERE ad_id = $1', ['unknown-ad']))
      .resolves.toMatchObject({ rows: [{ destination_url: null }] })
  })
})
