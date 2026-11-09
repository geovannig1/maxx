import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { insertAdset, insertCampaign } from './decision-fixture'

const ACCOUNT = fixtureUuid(71)
const CAMPAIGN = fixtureUuid(72)
const PARENT_ADSET = fixtureUuid(73)
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  await insertCampaign(db, CAMPAIGN, ACCOUNT)
  await insertAdset(db, PARENT_ADSET, ACCOUNT, CAMPAIGN, 'parent-adset')
})

afterEach(async () => {
  await db.close()
})

describe.each(['adsets', 'ads'] as const)('delivery sub-status %s constraints', (table) => {
  const idColumn = table === 'adsets' ? 'adset_id' : 'ad_id'
  // Every row needs its parent hierarchy; the columns under test follow it.
  const parentColumns = table === 'adsets' ? 'ad_account_id, campaign_id' : 'ad_account_id, campaign_id, adset_id'
  const parentValues = table === 'adsets'
    ? `'${ACCOUNT}', '${CAMPAIGN}'`
    : `'${ACCOUNT}', '${CAMPAIGN}', '${PARENT_ADSET}'`
  // The parent ad set is fixture scaffolding, not a row under test.
  const underTest = table === 'adsets' ? `WHERE adset_id <> 'parent-adset'` : ''

  it('allows all three truthful states', async () => {
    await db.exec(`
      INSERT INTO public.${table} (${parentColumns}, ${idColumn}) VALUES (${parentValues}, 'unavailable');
      INSERT INTO public.${table} (
        ${parentColumns}, ${idColumn}, delivery_sub_status, delivery_sub_status_read_available,
        delivery_sub_status_synced_at
      ) VALUES (
        ${parentValues}, 'payload', '{"status":"warning","substatuses":["budget_limited_learning_fail"]}',
        true, '2026-08-01T20:00:00Z'
      );
      INSERT INTO public.${table} (
        ${parentColumns}, ${idColumn}, delivery_sub_status, delivery_sub_status_read_available,
        delivery_sub_status_synced_at
      ) VALUES (${parentValues}, 'omitted', NULL, true, '2026-08-01T20:01:00Z');
    `)

    const result = await db.query<{
      id: string
      payload: unknown
      available: boolean
      observed_at: Date | null
    }>(`
      SELECT ${idColumn} AS id, delivery_sub_status AS payload,
             delivery_sub_status_read_available AS available,
             delivery_sub_status_synced_at AS observed_at
      FROM public.${table}
      ${underTest}
      ORDER BY ${idColumn}
    `)

    expect(result.rows).toEqual([
      {
        id: 'omitted',
        payload: null,
        available: true,
        observed_at: new Date('2026-08-01T20:01:00Z'),
      },
      {
        id: 'payload',
        payload: { status: 'warning', substatuses: ['budget_limited_learning_fail'] },
        available: true,
        observed_at: new Date('2026-08-01T20:00:00Z'),
      },
      { id: 'unavailable', payload: null, available: false, observed_at: null },
    ])
  })

  it.each([
    {
      name: 'array payload',
      values: `'array', '["warning"]', true, '2026-08-01T20:00:00Z'`,
    },
    {
      name: 'readable row without an observation time',
      values: `'missing-time', NULL, true, NULL`,
    },
    {
      name: 'unavailable row carrying a payload',
      values: `'unavailable-payload', '{"status":"warning"}', false, NULL`,
    },
    {
      name: 'unavailable row carrying an observation time',
      values: `'unavailable-time', NULL, false, '2026-08-01T20:00:00Z'`,
    },
  ])('rejects a contradictory $name', async ({ values }) => {
    await expect(db.exec(`
      INSERT INTO public.${table} (
        ${parentColumns}, ${idColumn}, delivery_sub_status, delivery_sub_status_read_available,
        delivery_sub_status_synced_at
      ) VALUES (${parentValues}, ${values});
    `)).rejects.toThrow(/constraint/i)
  })

  it('clears a prior warning when a later successful read omits the field', async () => {
    await db.exec(`
      INSERT INTO public.${table} (
        ${parentColumns}, ${idColumn}, delivery_sub_status, delivery_sub_status_read_available,
        delivery_sub_status_synced_at
      ) VALUES (
        ${parentValues}, 'entity-1', '{"status":"warning","substatuses":["historical"]}',
        true, '2026-08-01T19:00:00Z'
      );
      INSERT INTO public.${table} (
        ${parentColumns}, ${idColumn}, delivery_sub_status, delivery_sub_status_read_available,
        delivery_sub_status_synced_at
      ) VALUES (${parentValues}, 'entity-1', NULL, true, '2026-08-01T20:00:00Z')
      ON CONFLICT (${idColumn}) DO UPDATE SET
        delivery_sub_status = EXCLUDED.delivery_sub_status,
        delivery_sub_status_read_available = EXCLUDED.delivery_sub_status_read_available,
        delivery_sub_status_synced_at = EXCLUDED.delivery_sub_status_synced_at;
    `)

    const result = await db.query<{
      payload: unknown
      available: boolean
      observed_at: Date
    }>(`
      SELECT delivery_sub_status AS payload,
             delivery_sub_status_read_available AS available,
             delivery_sub_status_synced_at AS observed_at
      FROM public.${table}
      WHERE ${idColumn} = 'entity-1'
    `)

    expect(result.rows).toEqual([{
      payload: null,
      available: true,
      observed_at: new Date('2026-08-01T20:00:00Z'),
    }])
  })
})
