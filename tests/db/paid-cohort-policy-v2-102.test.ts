import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000001021'
const ACTIVATION = '00000000-0000-4000-8000-000000001022'
const LEGACY_RUN = '00000000-0000-4000-8000-000000001023'
const CURRENT_RUN = '00000000-0000-4000-8000-000000001024'
let db: PGlite

function generationIds(run: string): [string, string] {
  const suffix = run === LEGACY_RUN ? '1025' : '1027'
  return [
    `00000000-0000-4000-8000-00000000${suffix}`,
    `00000000-0000-4000-8000-00000000${Number(suffix) + 1}`,
  ]
}

function pair(run: string) {
  const [recent, matured] = generationIds(run)
  return [
    {
      id: recent,
      cohort_kind: 'recent_scale',
      window_start: '2026-07-16',
      window_end: '2026-07-29',
      activation_id: ACTIVATION,
      account_spend: 100,
      entity_spend: 100,
      landing_page_views: 2,
      captured_landing_views: 2,
      complete: true,
      blocker_codes: [] as string[],
      source_heads: {
        daily_insights: '2026-07-30T10:00:00.000Z',
        appointment_ledger: '2026-07-30T10:00:00.000Z',
        appointment_ledger_window_basis: 'booking_date_et',
        appointment_ledger_window_start: '2026-07-01',
        appointment_ledger_window_end: '2026-07-30',
      },
      metrics: { bookings: 1, booked_value: 220, outcome_recorded_revenue: 176, revenue_roas: 1.76 },
      units: [{
        entity_level: 'account', entity_id: 'act_102', spend: 100,
        landing_page_views: 2, captured_touches: 2, bookings: 1, booked_value: 220,
        complete: true, blocker_codes: [] as string[], metrics: { outcome_recorded_revenue: 176, revenue_roas: 1.76 },
      }],
    },
    {
      id: matured,
      cohort_kind: 'matured_cut',
      window_start: '2026-07-02',
      window_end: '2026-07-15',
      activation_id: ACTIVATION,
      account_spend: 300,
      entity_spend: 300,
      landing_page_views: 3,
      captured_landing_views: 3,
      complete: true,
      blocker_codes: [] as string[],
      source_heads: {
        daily_insights: '2026-07-30T10:00:00.000Z',
        appointment_ledger: '2026-07-30T10:00:00.000Z',
        appointment_ledger_window_basis: 'booking_date_et',
        appointment_ledger_window_start: '2026-07-01',
        appointment_ledger_window_end: '2026-07-30',
      },
      metrics: { bookings: 0, booked_value: 0, outcome_recorded_revenue: 0, revenue_roas: 0 },
      units: [{
        entity_level: 'account', entity_id: 'act_102', spend: 300,
        landing_page_views: 3, captured_touches: 3, bookings: 0, booked_value: 0,
        complete: true, blocker_codes: [] as string[], metrics: { outcome_recorded_revenue: 0, revenue_roas: 0 },
      }],
    },
  ]
}

async function publish(run: string, policyVersion: number) {
  return db.query<{ result: Record<string, unknown> }>(`
    SELECT public.commit_paid_cohort_pair($1,$2,'2026-07-30',1,$3,14,$4::jsonb) result
  `, [ACCOUNT, run, policyVersion, JSON.stringify(pair(run))])
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_102')
  await db.query(`SELECT public.record_paid_measurement_activation(
    $1,$2,'2026-06-01T12:00:00Z',1,1,'controlled_journey','owner journey 2026-06-01'
  )`, [ACCOUNT, ACTIVATION])
})

describe('paid cohort evidence policy v2', () => {
  it('retires v1 publication but accepts v2 evidence against the existing v1 activation', async () => {
    await expect(publish(CURRENT_RUN, 1)).rejects.toThrow(/unsupported paid cohort/i)

    const published = await publish(CURRENT_RUN, 2)
    expect(published.rows[0].result).toMatchObject({ evaluation_run_id: CURRENT_RUN })
    const rows = await db.query<{ policy_version: number; activation_policy_version: number }>(`
      SELECT g.policy_version, a.policy_version activation_policy_version
      FROM public.paid_cohort_generations g
      JOIN public.paid_measurement_activations a ON a.id=g.activation_id
      WHERE g.evaluation_run_id=$1 ORDER BY g.cohort_kind
    `, [CURRENT_RUN])
    expect(rows.rows).toEqual([
      { policy_version: 2, activation_policy_version: 1 },
      { policy_version: 2, activation_policy_version: 1 },
    ])
  })

  it('cannot retry a published run under another policy or insert a new legacy row directly', async () => {
    // A v1 run can no longer exist in a fresh install (see the test above), so the cross-policy
    // replay is proved on a v2 run retried under the dormant-but-enabled v3 policy.
    await publish(CURRENT_RUN, 2)
    await expect(publish(CURRENT_RUN, 3)).rejects.toThrow(/publication collision/i)
    await expect(db.query(`
      INSERT INTO public.paid_cohort_generations(
        id,ad_account_id,evaluation_run_id,cohort_kind,window_start,window_end,as_of_date,
        contract_version,policy_version,complete,blocker_codes,publication_fingerprint
      ) VALUES (
        '00000000-0000-4000-8000-000000001099',$1,
        '00000000-0000-4000-8000-000000001098','recent_scale',
        '2026-07-16','2026-07-29','2026-07-30',1,1,false,
        ARRAY['activation_missing'],'00000000000000000000000000000000'
      )
    `, [ACCOUNT])).rejects.toThrow(/enabled contract\/policy version/i)
  })

  it('rejects a complete v2 cohort whose booking-date coverage or revenue metrics are missing', async () => {
    const missingCoverage = pair(CURRENT_RUN)
    delete (missingCoverage[0].source_heads as Partial<typeof missingCoverage[0]['source_heads']>)
      .appointment_ledger_window_basis
    await expect(db.query(`
      SELECT public.commit_paid_cohort_pair($1,$2,'2026-07-30',1,2,14,$3::jsonb)
    `, [ACCOUNT, CURRENT_RUN, JSON.stringify(missingCoverage)]))
      .rejects.toThrow(/booking-date source coverage/i)
  })
})
