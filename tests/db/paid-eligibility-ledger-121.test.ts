import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { outcomeSourceId, outcomeUuid } from './acuity-harness'

const ACCOUNT = '00000000-0000-4000-8000-000000001231'
const RUN = '00000000-0000-4000-8000-000000001232'
const ATTEMPT = '00000000-0000-4000-8000-000000001233'
const CAPTURE = '00000000-0000-4000-8000-000000001234'
const TOUCH = '00000000-0000-4000-8000-000000001235'
const TOKEN_FIXTURE_ID = '00000000-0000-4000-8000-000000001236'
const LINK = '00000000-0000-4000-8000-000000001237'
const EVALUATION = '00000000-0000-4000-8000-000000001238'
const ELIGIBILITY_INPUT = '00000000-0000-4000-8000-000000001258'
const MANIFEST = '00000000-0000-4000-8000-000000001239'
const SOURCE = outcomeSourceId(ACCOUNT)
const O501 = outcomeUuid(501)
const O502 = outcomeUuid(502)
const TODAY_ET_PARTS = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date()).map((part) => [part.type, part.value]))
const TODAY_ET = `${TODAY_ET_PARTS.year}-${TODAY_ET_PARTS.month}-${TODAY_ET_PARTS.day}`
let db: PGlite

async function setupCompleteWindow() {
  for (const [surface, suffix] of [
    ['capture_attempt', 'a'], ['scheduler_delivery', 'b'],
    ['outcome_link_evaluation', 'c'], ['collected_value_observation', 'd'],
  ]) {
    await db.query(`SELECT public.record_paid_eligibility_surface_activation(
      $1,$2,$3,'2026-08-01T00:00:00Z',1,$4
    )`, [ACCOUNT, `00000000-0000-4000-8000-00000000124${suffix}`, surface, `controlled-${surface}`])
  }
  // The paid-eligibility ledger is prospective: the pre-existing appointment is not backfilled. This first live
  // post-activation change creates the immutable amount_paid observation used by the manifest.
  await db.exec(`UPDATE public.outcomes SET collected_value=151 WHERE id='${O501}'`)
  await db.query(`SELECT public.record_paid_capture_attempt($1,$2,$3,$4,1)`, [
    ACCOUNT, ATTEMPT, CAPTURE, `sha256:${'a'.repeat(64)}`,
  ])
  await db.query(`SELECT public.record_paid_capture_outcome(
    $1,$2,'00000000-0000-4000-8000-000000001250','touch_persisted',NULL,$3,$4,1
  )`, [ACCOUNT, ATTEMPT, TOUCH, TOKEN_FIXTURE_ID])
  await db.query(`SELECT public.record_paid_destination_token_delivery(
    $1,'00000000-0000-4000-8000-000000001251',$2,$3,$4,'scheduler_decorated',1
  )`, [ACCOUNT, CAPTURE, TOKEN_FIXTURE_ID, `sha256:${'b'.repeat(64)}`])
  await db.query(`SELECT public.record_paid_outcome_eligibility_input(
    $1,$2,$3,'${O501}','2026-08-10T14:00:00Z',true,true,$4,151,false,1
  )`, [ACCOUNT, ELIGIBILITY_INPUT, `sha256:${'d'.repeat(64)}`, TOKEN_FIXTURE_ID])
  await db.query(`SELECT public.record_paid_outcome_link_evaluation(
    $1,$2,$3,$4,'${O501}','2026-08-10T14:00:00Z',true,$5,$6,$7,'2026-08-10T13:00:00Z',
    'linked',NULL,151,false,1
  )`, [ACCOUNT, EVALUATION, `sha256:${'c'.repeat(64)}`, ELIGIBILITY_INPUT, TOKEN_FIXTURE_ID, LINK, TOUCH])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_121')
  await db.exec(`
    INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES ('${RUN}','${ACCOUNT}','success');
    INSERT INTO public.outcome_sources(id,ad_account_id,kind,label,enabled)
      VALUES ('${SOURCE}','${ACCOUNT}','acuity','Acuity Scheduling',true);
    INSERT INTO public.outcomes(id,ad_account_id,source_id,external_id,outcome_type,currency,
      occurred_at,collected_value,status,observation_source)
      VALUES ('${O501}','${ACCOUNT}','${SOURCE}','501','booking','USD','2026-08-10T14:00:00Z',150,'confirmed','webhook');
    INSERT INTO public.paid_touch_observations(
      id,ad_account_id,browser_capture_id,observed_at,source,utm_source,utm_medium,landing_url,
      contract_version,capture_fingerprint)
      VALUES ('${TOUCH}','${ACCOUNT}','${CAPTURE}','2026-08-10T13:00:00Z','meta','meta','paid_social',
        'https://example-studio.test/book/',1,'sha256:${'f'.repeat(64)}');
    INSERT INTO public.paid_attribution_tokens(
      id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,policy_version,issued_at,expires_at)
      VALUES ('${TOKEN_FIXTURE_ID}','${ACCOUNT}','${TOUCH}','${TOUCH}','${TOUCH}','sha256:${'b'.repeat(64)}',1,
        '2026-08-10T13:00:00Z','2026-11-08T13:00:00Z');
    INSERT INTO public.outcome_touch_links(
      id,ad_account_id,outcome_id,token_id,first_touch_id,last_touch_id,first_interaction_at,
      last_interaction_at,outcome_created_at,policy_version)
      VALUES ('${LINK}','${ACCOUNT}','${O501}','${TOKEN_FIXTURE_ID}','${TOUCH}','${TOUCH}','2026-08-10T13:00:00Z',
        '2026-08-10T13:00:00Z','2026-08-10T14:00:00Z',1);
  `)
})

describe('independent paid eligibility ledgers', () => {
  // The capture side fails closed: public capture submissions cannot establish the
  // universe of eligible paid landings, so capture is never complete and its denominator is withheld.
  // The linker side (scheduler delivery, webhook evaluation, amount lineage) is still derived from the
  // ledgers, and that is what this test pins.
  it('derives the linker side from the ledgers while the capture denominator stays unavailable', async () => {
    await setupCompleteWindow()
    const produced = await db.query<{ produce_paid_cohort_completeness_manifest: Record<string, unknown> }>(`
      SELECT public.produce_paid_cohort_completeness_manifest(
        $1,$2,$3,'recent_scale','2026-08-01','${TODAY_ET}','2026-08-21T15:00:00Z',1,1
      )
    `, [MANIFEST, ACCOUNT, RUN])
    expect(produced.rows[0].produce_paid_cohort_completeness_manifest).toMatchObject({
      id: MANIFEST,
      cohort_kind: 'recent_scale',
      capture_complete: false,
      linker_complete: true,
      capture_eligible_inputs: 0,
      captured_touches: 1,
      eligible_outcomes: 1,
      evaluated_outcomes: 1,
      linked_outcomes: 1,
    })
    expect(produced.rows[0].produce_paid_cohort_completeness_manifest.blocker_codes)
      .toEqual(['independent_capture_denominator_unavailable'])
  })

  // A rejected capture still blocks (never a false zero), but it no longer feeds a
  // capture denominator, because that denominator is withheld entirely.
  it('blocks on a rejected capture instead of reporting a false zero', async () => {
    await db.query(`SELECT public.record_paid_capture_attempt($1,$2,$3,$4,1)`, [
      ACCOUNT, ATTEMPT, CAPTURE, `sha256:${'a'.repeat(64)}`,
    ])
    await db.query(`SELECT public.record_paid_capture_outcome(
      $1,$2,'00000000-0000-4000-8000-000000001252','rejected_invalid','invalid_payload',NULL,NULL,1
    )`, [ACCOUNT, ATTEMPT])
    const result = await db.query<{ produce_paid_cohort_completeness_manifest: Record<string, unknown> }>(`
      SELECT public.produce_paid_cohort_completeness_manifest(
        $1,$2,$3,'recent_scale','2026-08-01','${TODAY_ET}','2026-08-21T15:00:00Z',1,1
      )
    `, [MANIFEST, ACCOUNT, RUN])
    expect(result.rows[0].produce_paid_cohort_completeness_manifest).toMatchObject({
      capture_complete: false,
      capture_eligible_inputs: 0,
      captured_touches: 0,
    })
    expect(result.rows[0].produce_paid_cohort_completeness_manifest.blocker_codes)
      .toContain('independent_capture_denominator_unavailable')
  })

  it('counts paid webhook inputs independently and blocks when no evaluation row exists', async () => {
    await db.query(`SELECT public.record_paid_eligibility_surface_activation(
      $1,'00000000-0000-4000-8000-000000001259','outcome_link_evaluation',
      '2026-08-01T00:00:00Z',1,'controlled-linker'
    )`, [ACCOUNT])
    await db.query(`SELECT public.record_paid_outcome_eligibility_input(
      $1,$2,$3,'${O501}','2026-08-10T14:00:00Z',true,true,$4,150,false,1
    )`, [ACCOUNT, ELIGIBILITY_INPUT, `sha256:${'e'.repeat(64)}`, TOKEN_FIXTURE_ID])
    const result = await db.query<{ produce_paid_cohort_completeness_manifest: Record<string, unknown> }>(`
      SELECT public.produce_paid_cohort_completeness_manifest(
        $1,$2,$3,'recent_scale','2026-08-01','${TODAY_ET}','2026-08-21T15:00:00Z',1,1
      )
    `, [MANIFEST, ACCOUNT, RUN])
    expect(result.rows[0].produce_paid_cohort_completeness_manifest).toMatchObject({
      eligible_outcomes: 1,
      evaluated_outcomes: 0,
      linked_outcomes: 0,
      linker_complete: false,
    })
    expect(result.rows[0].produce_paid_cohort_completeness_manifest.blocker_codes)
      .toContain('link_evaluations_incomplete')
  })

  it('blocks when the Acuity ledger has an appointment with no signed-webhook eligibility input', async () => {
    await setupCompleteWindow()
    await db.exec(`
      INSERT INTO public.outcomes(id,ad_account_id,source_id,external_id,outcome_type,currency,
        occurred_at,collected_value,status,observation_source)
      VALUES ('${O502}','${ACCOUNT}','${SOURCE}','502','booking','USD','2026-08-11T14:00:00Z',75,'confirmed','webhook')
    `)
    const result = await db.query<{ produce_paid_cohort_completeness_manifest: Record<string, unknown> }>(`
      SELECT public.produce_paid_cohort_completeness_manifest(
        $1,$2,$3,'recent_scale','2026-08-01','${TODAY_ET}','2026-08-21T15:00:00Z',1,1
      )
    `, [MANIFEST, ACCOUNT, RUN])
    expect(result.rows[0].produce_paid_cohort_completeness_manifest).toMatchObject({
      linker_complete: false,
      eligible_outcomes: 1,
      evaluated_outcomes: 1,
      linked_outcomes: 1,
    })
    expect(result.rows[0].produce_paid_cohort_completeness_manifest.blocker_codes)
      .toContain('outcome_eligibility_inputs_incomplete')
  })

  it('is account-scoped, append-only, idempotent, and does not infer pre-activation coverage', async () => {
    await setupCompleteWindow()
    const args = [MANIFEST, ACCOUNT, RUN]
    const sql = `SELECT public.produce_paid_cohort_completeness_manifest(
      $1,$2,$3,'recent_scale','2026-07-01','2026-07-31','2026-08-21T15:00:00Z',1,1
    )`
    const first = await db.query(sql, args)
    const second = await db.query(sql, args)
    expect(second.rows).toEqual(first.rows)
    expect(JSON.stringify(first.rows)).toContain('pre_activation_window')
    await expect(db.exec(`UPDATE public.paid_capture_attempts SET contract_version=1`))
      .rejects.toThrow(/append-only/i)
  })
})
