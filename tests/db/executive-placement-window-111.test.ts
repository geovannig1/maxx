import type { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000111'
let db: PGlite

const row = (date: string, dimension: string, value: string, account = ACCOUNT) => ({
  ad_account_id: account,
  date_start: date,
  entity_level: 'adset',
  meta_entity_id: 'adset-1',
  breakdown_type: dimension,
  breakdown_value: value,
  spend: 10,
  impressions: 100,
  clicks: 5,
  leads: 1,
  bookings: 0,
  ctr: 5,
  cpa: 10,
})

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
})

afterEach(async () => db.close())

async function replace(rows: unknown[]) {
  return db.query<{ count: number }>(`
    SELECT public.replace_executive_placement_window(
      $1,'2026-08-09','2026-08-15',$2::jsonb,'2026-08-16T14:00:00Z'
    ) count
  `, [ACCOUNT, JSON.stringify(rows)])
}

describe('executive placement evidence window', () => {
  it('atomically replaces the exact window and records its complete source head', async () => {
    await expect(replace([
      row('2026-08-09', 'publisher_platform', 'instagram'),
      row('2026-08-09', 'platform_position', 'reels'),
    ])).resolves.toMatchObject({ rows: [{ count: 2 }] })

    const health = await db.query<{ value: string }>(`
      SELECT value FROM app_settings WHERE key='executive_placement_evidence_health'
    `)
    expect(JSON.parse(health.rows[0].value)).toMatchObject({
      complete: true,
      window_start: '2026-08-09',
      window_end: '2026-08-15',
      row_count: 2,
      dimensions: ['publisher_platform', 'platform_position'],
    })

    await replace([])
    await expect(db.query('SELECT id FROM insight_breakdowns')).resolves.toMatchObject({ rows: [] })
  })

  it('rejects a partial or cross-account payload without deleting the prior good window', async () => {
    await replace([row('2026-08-09', 'publisher_platform', 'instagram')])
    await expect(replace([row(
      '2026-08-09', 'publisher_platform', 'bad',
      '00000000-0000-4000-8000-000000000999',
    )])).rejects.toThrow(/cross-account/i)
    await expect(db.query('SELECT breakdown_value FROM insight_breakdowns')).resolves.toMatchObject({
      rows: [{ breakdown_value: 'instagram' }],
    })
  })

  it('accepts Meta\'s literal unknown placement value', async () => {
    await expect(replace([
      row('2026-08-09', 'publisher_platform', 'unknown'),
    ])).resolves.toMatchObject({ rows: [{ count: 1 }] })
    await expect(db.query('SELECT breakdown_value FROM insight_breakdowns')).resolves.toMatchObject({
      rows: [{ breakdown_value: 'unknown' }],
    })
  })

  it('accepts atomic unknown outcomes but rejects missing delivery and mixed outcome shapes', async () => {
    await expect(replace([
      { ...row('2026-08-09', 'publisher_platform', 'instagram'), leads: null, bookings: null },
    ])).resolves.toMatchObject({ rows: [{ count: 1 }] })
    await expect(db.query('SELECT leads,bookings,spend FROM insight_breakdowns')).resolves.toMatchObject({
      // The shipped column is unconstrained numeric (any currency), so the preserved spend keeps
      // the scale it was written with.
      rows: [{ leads: null, bookings: null, spend: '10' }],
    })

    await expect(replace([
      { ...row('2026-08-09', 'publisher_platform', 'instagram'), spend: null },
    ])).rejects.toThrow(/malformed/i)
    await expect(replace([
      { ...row('2026-08-09', 'publisher_platform', 'instagram'), leads: null, bookings: 0 },
    ])).rejects.toThrow(/malformed/i)
  })

  it('blocks direct restatements inside the committed window', async () => {
    await replace([row('2026-08-09', 'publisher_platform', 'instagram')])

    await expect(db.query(`UPDATE public.insight_breakdowns
      SET spend=99 WHERE ad_account_id=$1 AND date_start='2026-08-09'`, [ACCOUNT]))
      .rejects.toThrow(/atomic placement publisher/i)
    await expect(db.query(`DELETE FROM public.insight_breakdowns
      WHERE ad_account_id=$1 AND date_start='2026-08-09'`, [ACCOUNT]))
      .rejects.toThrow(/atomic placement publisher/i)
  })
})
