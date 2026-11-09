import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001141'
const ACTIVATION = '00000000-0000-4000-8000-000000001142'
const V2_RUN = '00000000-0000-4000-8000-000000001143'
const V3_RUN = '00000000-0000-4000-8000-000000001144'
const TRANSITION_V2_RUN = '00000000-0000-4000-8000-000000001151'
const RETIRED_V2_RUN = '00000000-0000-4000-8000-000000001152'
const RECENT_MANIFEST = '00000000-0000-4000-8000-000000001145'
const MATURED_MANIFEST = '00000000-0000-4000-8000-000000001146'
let db: PGlite

function pair(run: string, options: { complete?: boolean; withManifest?: boolean } = {}) {
  const complete = options.complete ?? true
  const blockers = complete ? [] : ['paid_completeness_manifest_unavailable']
  const manifests = options.withManifest ? [RECENT_MANIFEST, MATURED_MANIFEST] : [null, null]
  const generationIds: Record<string, [string, string]> = {
    [V2_RUN]: [
      '00000000-0000-4000-8000-000000001147',
      '00000000-0000-4000-8000-000000001148',
    ],
    [V3_RUN]: [
      '00000000-0000-4000-8000-000000001149',
      '00000000-0000-4000-8000-000000001150',
    ],
    [TRANSITION_V2_RUN]: [
      '00000000-0000-4000-8000-000000001153',
      '00000000-0000-4000-8000-000000001154',
    ],
    [RETIRED_V2_RUN]: [
      '00000000-0000-4000-8000-000000001155',
      '00000000-0000-4000-8000-000000001156',
    ],
  }
  const ids = generationIds[run]
  if (!ids) throw new Error(`missing generation IDs for ${run}`)
  return [
    {
      id: ids[0],
      cohort_kind: 'recent_scale', window_start: '2026-07-16', window_end: '2026-07-29',
      activation_id: ACTIVATION, account_spend: 100, entity_spend: 100,
      landing_page_views: 2, captured_landing_views: 2, complete, blocker_codes: blockers,
      source_heads: {
        daily_insights: '2026-07-30T10:00:00.000Z',
        appointment_ledger: '2026-07-30T10:00:00.000Z',
        appointment_ledger_window_basis: 'booking_date_et',
        appointment_ledger_window_start: '2026-07-01',
        appointment_ledger_window_end: '2026-07-30',
        paid_completeness_manifest: manifests[0],
        paid_completeness_manifest_run: options.withManifest ? run : null,
        paid_completeness_source_not_before: options.withManifest
          ? '2026-07-30T10:00:00.000Z' : null,
        paid_capture_completed_at: options.withManifest ? '2026-07-30T11:00:00.000Z' : null,
        paid_linker_completed_at: options.withManifest ? '2026-07-30T11:00:00.000Z' : null,
      },
      metrics: {
        bookings: 1, booked_value: 220, outcome_recorded_revenue: 176, revenue_roas: 1.76,
        capture_eligible_inputs: options.withManifest ? 2 : null,
        manifest_captured_touches: options.withManifest ? 2 : null,
        linker_eligible_appointments: options.withManifest ? 1 : null,
        linker_evaluated_appointments: options.withManifest ? 1 : null,
        manifest_linked_appointments: options.withManifest ? 1 : null,
      },
      units: [{
        entity_level: 'account', entity_id: 'act_114', spend: 100,
        landing_page_views: 2, captured_touches: 2, bookings: 1, booked_value: 220,
        complete, blocker_codes: blockers,
        metrics: { outcome_recorded_revenue: 176, revenue_roas: 1.76 },
      }],
    },
    {
      id: ids[1],
      cohort_kind: 'matured_cut', window_start: '2026-07-02', window_end: '2026-07-15',
      activation_id: ACTIVATION, account_spend: 300, entity_spend: 300,
      landing_page_views: 3, captured_landing_views: 3, complete, blocker_codes: blockers,
      source_heads: {
        daily_insights: '2026-07-30T10:00:00.000Z',
        appointment_ledger: '2026-07-30T10:00:00.000Z',
        appointment_ledger_window_basis: 'booking_date_et',
        appointment_ledger_window_start: '2026-07-01',
        appointment_ledger_window_end: '2026-07-30',
        paid_completeness_manifest: manifests[1],
        paid_completeness_manifest_run: options.withManifest ? run : null,
        paid_completeness_source_not_before: options.withManifest
          ? '2026-07-30T10:00:00.000Z' : null,
        paid_capture_completed_at: options.withManifest ? '2026-07-30T11:00:00.000Z' : null,
        paid_linker_completed_at: options.withManifest ? '2026-07-30T11:00:00.000Z' : null,
      },
      metrics: {
        bookings: 0, booked_value: 0, outcome_recorded_revenue: 0, revenue_roas: 0,
        capture_eligible_inputs: options.withManifest ? 3 : null,
        manifest_captured_touches: options.withManifest ? 3 : null,
        linker_eligible_appointments: options.withManifest ? 0 : null,
        linker_evaluated_appointments: options.withManifest ? 0 : null,
        manifest_linked_appointments: options.withManifest ? 0 : null,
      },
      units: [{
        entity_level: 'account', entity_id: 'act_114', spend: 300,
        landing_page_views: 3, captured_touches: 3, bookings: 0, booked_value: 0,
        complete, blocker_codes: blockers,
        metrics: { outcome_recorded_revenue: 0, revenue_roas: 0 },
      }],
    },
  ]
}

async function publish(run: string, policyVersion: number, payload: ReturnType<typeof pair>) {
  return db.query(`
    SELECT public.commit_paid_cohort_pair($1,$2,'2026-07-30',1,$3,14,$4::jsonb)
  `, [ACCOUNT, run, policyVersion, JSON.stringify(payload)])
}

async function insertManifests(options: { zeroCapture?: boolean; run?: string } = {}) {
  const run = options.run ?? V3_RUN
  await db.query(`
    INSERT INTO public.paid_cohort_completeness_manifests(
      id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,
      source_not_before,capture_completed_at,linker_completed_at,contract_version,policy_version,
      capture_complete,linker_complete,capture_eligible_inputs,captured_touches,
      eligible_outcomes,evaluated_outcomes,linked_outcomes,blocker_codes
    ) VALUES
      ($1,$3,$4,'recent_scale','2026-07-16','2026-07-29','2026-07-30T10:00:00Z',
       '2026-07-30T11:00:00Z','2026-07-30T11:00:00Z',1,1,true,true,$5,$5,1,1,1,ARRAY[]::text[]),
      ($2,$3,$4,'matured_cut','2026-07-02','2026-07-15','2026-07-30T10:00:00Z',
       '2026-07-30T11:00:00Z','2026-07-30T11:00:00Z',1,1,true,true,3,3,0,0,0,ARRAY[]::text[])
  `, [RECENT_MANIFEST, MATURED_MANIFEST, ACCOUNT, run, options.zeroCapture ? 0 : 2])
}

// The v3 cutover is deployment state, not schema: a fresh install ships v3 dormant
// (no marker row). Re-arming it is exactly this insert (see the `paid_cohort_policy_cutovers` table comment).
async function applyV3Cutover() {
  await db.exec(`INSERT INTO public.paid_cohort_policy_cutovers(policy_version) VALUES (3)`)
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_114')
  await db.exec(`
    INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES
      ('${V3_RUN}','${ACCOUNT}','success'),
      ('00000000-0000-4000-8000-000000001199','${ACCOUNT}','success');
  `)
  await db.query(`SELECT public.record_paid_measurement_activation(
    $1,$2,'2026-06-01T12:00:00Z',1,1,'controlled_journey','owner journey 2026-06-01'
  )`, [ACCOUNT, ACTIVATION])
  await publish(V2_RUN, 2, pair(V2_RUN))
})

describe('paid cohort current-run completeness policy v3', () => {
  it('keeps rollout compatible, then preserves v2 history and retires new v2 writes at cutover', async () => {
    await expect(publish(TRANSITION_V2_RUN, 2, pair(TRANSITION_V2_RUN)))
      .resolves.toBeDefined()

    await applyV3Cutover()
    await expect(publish(RETIRED_V2_RUN, 2, pair(RETIRED_V2_RUN, { complete: false })))
      .rejects.toThrow(/unsupported paid cohort/i)
    await expect(publish(V3_RUN, 3, pair(V3_RUN, { complete: false }))).resolves.toBeDefined()

    const versions = await db.query<{ policy_version: number; n: number }>(`
      SELECT policy_version,count(*)::int n FROM public.paid_cohort_generations
      GROUP BY policy_version ORDER BY policy_version
    `)
    expect(versions.rows).toEqual([{ policy_version: 2, n: 4 }, { policy_version: 3, n: 2 }])
  })

  it('rejects complete v3 evidence without exact-run manifests, then accepts a fully reconciled pair', async () => {
    await expect(publish(V3_RUN, 3, pair(V3_RUN, { withManifest: true })))
      .rejects.toThrow(/completeness manifest/i)

    await insertManifests()
    await expect(publish(V3_RUN, 3, pair(V3_RUN, { withManifest: true }))).resolves.toBeDefined()
  })

  it('rejects zero capture and a manifest from a different evaluation run', async () => {
    await expect(insertManifests({ zeroCapture: true })).rejects.toThrow(/capture/i)
    await insertManifests({ run: '00000000-0000-4000-8000-000000001199' })
    await expect(publish(V3_RUN, 3, pair(V3_RUN, { withManifest: true })))
      .rejects.toThrow(/completeness manifest/i)
  })
})
