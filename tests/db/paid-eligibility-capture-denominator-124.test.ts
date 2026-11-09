import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001331'
const RUN = '00000000-0000-4000-8000-000000001332'
const ATTEMPT = '00000000-0000-4000-8000-000000001333'
const CAPTURE = '00000000-0000-4000-8000-000000001334'
const TOUCH = '00000000-0000-4000-8000-000000001335'
const TOKEN_FIXTURE_ID = '00000000-0000-4000-8000-000000001336'
const MANIFEST = '00000000-0000-4000-8000-000000001337'
let db: PGlite

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_124')
  await db.exec(`
    INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES ('${RUN}','${ACCOUNT}','success');
    INSERT INTO public.paid_touch_observations(
      id,ad_account_id,browser_capture_id,source,utm_source,utm_medium,landing_url,
      contract_version,capture_fingerprint)
      VALUES ('${TOUCH}','${ACCOUNT}','${CAPTURE}','meta','meta','paid_social',
        'https://example-studio.test/book/',1,'sha256:${'f'.repeat(64)}');
    INSERT INTO public.paid_attribution_tokens(
      id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,policy_version,expires_at)
      VALUES ('${TOKEN_FIXTURE_ID}','${ACCOUNT}','${TOUCH}','${TOUCH}','${TOUCH}','sha256:${'a'.repeat(64)}',1,
        pg_catalog.transaction_timestamp() + interval '90 days');
  `)
})

describe('paid capture denominator integrity', () => {
  it('never treats public capture-attempt rows as an exhaustive eligibility denominator', async () => {
    for (const [surface, id] of [
      ['capture_attempt', '00000000-0000-4000-8000-000000001341'],
      ['scheduler_delivery', '00000000-0000-4000-8000-000000001342'],
      ['outcome_link_evaluation', '00000000-0000-4000-8000-000000001343'],
      ['collected_value_observation', '00000000-0000-4000-8000-000000001344'],
    ]) {
      await db.query(`SELECT public.record_paid_eligibility_surface_activation($1,$2,$3,'2026-01-01T00:00:00Z',1,$4)`, [ACCOUNT, id, surface, `controlled-${surface}`])
    }
    await db.query(`SELECT public.record_paid_capture_attempt($1,$2,$3,$4,1)`, [ACCOUNT, ATTEMPT, CAPTURE, `sha256:${'b'.repeat(64)}`])
    await db.query(`SELECT public.record_paid_capture_outcome($1,$2,'00000000-0000-4000-8000-000000001345','touch_persisted',NULL,$3,$4,1)`, [ACCOUNT, ATTEMPT, TOUCH, TOKEN_FIXTURE_ID])
    await db.query(`SELECT public.record_paid_destination_token_delivery($1,'00000000-0000-4000-8000-000000001346',$2,$3,$4,'scheduler_decorated',1)`, [ACCOUNT, CAPTURE, TOKEN_FIXTURE_ID, `sha256:${'a'.repeat(64)}`])

    const result = await db.query<{ produce_paid_cohort_completeness_manifest: Record<string, unknown> }>(`
      SELECT public.produce_paid_cohort_completeness_manifest($1,$2,$3,'recent_scale','2026-01-01','2099-01-01','2026-08-21T15:00:00Z',1,1)
    `, [MANIFEST, ACCOUNT, RUN])
    const manifest = result.rows[0].produce_paid_cohort_completeness_manifest

    expect(manifest.capture_complete).toBe(false)
    expect(manifest.capture_eligible_inputs).toBe(0)
    expect(manifest.captured_touches).toBe(1)
    expect(manifest.blocker_codes).toContain('independent_capture_denominator_unavailable')
  })
})
