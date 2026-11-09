import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001051'
let db: PGlite

const row = (id: string, account = ACCOUNT) => ({
  ad_account_id: account,
  audience_id: id,
  name: `Audience ${id}`,
  subtype: 'WEBSITE',
  meta_account_id: '100000000000777',
  operation_status: { code: 200 },
  delivery_status: { code: 200 },
})

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

async function replace(rows: unknown[]) {
  return db.query<{ count: number }>(`
    SELECT public.replace_custom_audience_inventory(
      $1,'100000000000777',$2::jsonb,'2026-08-16T12:00:00Z'
    ) count
  `, [ACCOUNT, JSON.stringify(rows)])
}

describe('atomic custom-audience inventory', () => {
  it('atomically replaces rows and records a complete source head', async () => {
    await expect(replace([row('a'), row('b')])).resolves.toMatchObject({ rows: [{ count: 2 }] })
    expect((await db.query(`SELECT audience_id FROM custom_audiences ORDER BY audience_id`)).rows)
      .toEqual([{ audience_id: 'a' }, { audience_id: 'b' }])

    await expect(replace([])).resolves.toMatchObject({ rows: [{ count: 0 }] })
    expect((await db.query(`SELECT audience_id FROM custom_audiences`)).rows).toEqual([])
    const health = await db.query<{ value: string }>(`
      SELECT value FROM app_settings WHERE key='custom_audience_inventory_health'
    `)
    expect(JSON.parse(health.rows[0].value)).toMatchObject({ complete: true, row_count: 0 })
  })

  it('rejects a cross-account snapshot without deleting the prior good inventory', async () => {
    await replace([row('good')])
    await expect(replace([row('bad', '00000000-0000-4000-8000-000000001099')]))
      .rejects.toThrow(/cross-account/i)
    expect((await db.query(`SELECT audience_id FROM custom_audiences`)).rows)
      .toEqual([{ audience_id: 'good' }])
  })
})
