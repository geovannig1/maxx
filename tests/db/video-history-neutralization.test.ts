import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { insertCampaign } from './decision-fixture'

// The baseline schema NEUTRALISES the historically ambiguous video columns rather than
// relabelling them. Legacy rows (no video_metrics_contract) held the p25 retention milestone in `video_views` and derived
// hook/hold from that invalid proxy; no early-view field was ever collected for them, so nothing can
// be recomputed truthfully. A wrong number removed is honest; a wrong number relabelled is not.
// The one-time neutralisation of rows written before 055 is history; what ships is the provenance
// contract below, which every writer must claim explicitly.

const ACCT = '00000000-0000-4000-8000-000000000001'
const CAMPAIGN_A = '00000000-0000-4000-8000-000000000002'
const CAMPAIGN_B = '00000000-0000-4000-8000-000000000003'

async function db(): Promise<PGlite> {
  const d = await freshSchemaDb()
  await insertAdAccount(d, ACCT)
  return d
}

describe('ambiguous video history is neutralised, not relabelled', () => {
  // There is NO column default. A default would silently grant the new provenance to
  // any OLD or unknown writer — a rolled-back build, a manual insert, a code path that forgets to
  // stamp. Provenance must be CLAIMED, never inherited.
  it('an UNSTAMPED writer gets NULL, never the rev_i provenance', async () => {
    const d = await db()
    await d.query(
      `INSERT INTO daily_insights (ad_account_id, entity_level, date_start, date_stop, impressions, video_views, video_plays)
       VALUES ($1,'account','2026-07-01','2026-07-01', 10000, 4000, 4000)`, [ACCT])
    const r = (await d.query<Record<string, unknown>>(`SELECT * FROM daily_insights WHERE date_start='2026-07-01'`)).rows[0]
    expect(r.video_metrics_contract).toBeNull()
    expect(Number(r.video_views)).toBe(4000) // a genuine START count survives
  })

  it('the rev_i writer stamps the contract EXPLICITLY', async () => {
    const d = await db()
    await d.query(
      `INSERT INTO daily_insights (ad_account_id, entity_level, date_start, date_stop, impressions, video_views, video_plays, video_metrics_contract)
       VALUES ($1,'account','2026-07-02','2026-07-02', 10000, 4000, 4000, 'rev_i')`, [ACCT])
    const r = (await d.query<Record<string, unknown>>(`SELECT * FROM daily_insights WHERE date_start='2026-07-02'`)).rows[0]
    expect(r.video_metrics_contract).toBe('rev_i')
  })

  it('the shipped schema declares NO column default', async () => {
    const d = await db()
    const r = await d.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema='public' AND table_name='daily_insights' AND column_name='video_metrics_contract'`)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].column_default).toBeNull()
  })

  it('a pre-contract row is DISTINGUISHABLE from a contract-bearing one without guessing by date', async () => {
    const d = await db()
    await insertCampaign(d, CAMPAIGN_A, ACCT)
    await insertCampaign(d, CAMPAIGN_B, ACCT)
    // A legacy-shaped writer (no contract claim) and a rev_i writer on the SAME date.
    await d.query(
      `INSERT INTO daily_insights (ad_account_id, entity_level, campaign_id, date_start, date_stop, impressions, video_views)
       VALUES ($1,'campaign',$2,'2026-06-01','2026-06-01', 10000, 1200)`, [ACCT, CAMPAIGN_A])
    await d.query(
      `INSERT INTO daily_insights (ad_account_id, entity_level, campaign_id, date_start, date_stop, impressions, video_views, video_plays, video_metrics_contract)
       VALUES ($1,'campaign',$2,'2026-06-01','2026-06-01', 10000, 4000, 4000, 'rev_i')`, [ACCT, CAMPAIGN_B])
    const rows = (await d.query<Record<string, unknown>>(
      `SELECT video_metrics_contract, video_views FROM daily_insights ORDER BY campaign_id`)).rows
    expect(rows[0].video_metrics_contract).toBeNull()   // same DATE, different contract
    expect(rows[1].video_metrics_contract).toBe('rev_i')
  })

  it('rejects an unknown contract label', async () => {
    const d = await db()
    await expect(
      d.query(`INSERT INTO daily_insights (ad_account_id, entity_level, date_start, date_stop, video_metrics_contract) VALUES ($1,'account','2026-07-01','2026-07-01','rev_z')`, [ACCT]),
    ).rejects.toThrow(/daily_insights_video_contract_chk/)
  })
})
