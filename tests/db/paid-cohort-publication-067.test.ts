import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

const ACCOUNT = '00000000-0000-4000-8000-000000000771'
const ACTIVATION = '00000000-0000-4000-8000-000000000772'
const RUN = '00000000-0000-4000-8000-000000000773'
const RECENT = '00000000-0000-4000-8000-000000000774'
const MATURED = '00000000-0000-4000-8000-000000000775'
let db: PGlite

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

// The shipped publication policy. v1 is retired and the v3 cutover is reverted (`paid_cohort_policy_cutovers`), so new
// pairs publish under v2, whose complete cohorts must carry booking-date coverage and revenue metrics.
const POLICY_VERSION = 2
const SOURCE_HEADS = {
  daily_insights: '2026-07-30T10:00:00.000Z',
  appointment_ledger: '2026-07-30T10:00:00.000Z',
  appointment_ledger_window_basis: 'booking_date_et',
  appointment_ledger_window_start: '2026-06-01',
  appointment_ledger_window_end: '2026-07-30',
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_067')
})

function pair(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: RECENT,
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
      source_heads: SOURCE_HEADS,
      metrics: { bookings: 1, booked_value: 220, outcome_recorded_revenue: 176, revenue_roas: 1.76 },
      units: [{
        entity_level: 'account', entity_id: 'act_067', spend: 100,
        landing_page_views: 2, captured_touches: 2, bookings: 1, booked_value: 220,
        complete: true, blocker_codes: [] as string[], metrics: { outcome_recorded_revenue: 176, revenue_roas: 1.76 },
      }],
    },
    {
      id: MATURED,
      cohort_kind: 'matured_cut',
      window_start: '2026-06-16',
      window_end: '2026-07-15',
      activation_id: ACTIVATION,
      account_spend: 300,
      entity_spend: 300,
      landing_page_views: 3,
      captured_landing_views: 3,
      complete: true,
      blocker_codes: [] as string[],
      source_heads: SOURCE_HEADS,
      metrics: { bookings: 0, booked_value: 0, outcome_recorded_revenue: 0, revenue_roas: 0 },
      units: [{
        entity_level: 'account', entity_id: 'act_067', spend: 300,
        landing_page_views: 3, captured_touches: 3, bookings: 0, booked_value: 0,
        complete: true, blocker_codes: [] as string[], metrics: { outcome_recorded_revenue: 0, revenue_roas: 0 },
      }],
    },
  ].map((row) => ({ ...row, ...overrides }))
}

async function activate() {
  return one<{ result: Record<string, unknown> }>(`
    SELECT public.record_paid_measurement_activation(
      $1,$2,'2026-06-01T12:00:00Z',1,1,'controlled_journey','owner journey 2026-06-01'
    ) result`, [ACCOUNT, ACTIVATION])
}

async function publish(payload: unknown = pair()) {
  return one<{ result: Record<string, unknown> }>(`
    SELECT public.commit_paid_cohort_pair($1,$2,'2026-07-30',1,$3,14,$4::jsonb) result`,
  [ACCOUNT, RUN, POLICY_VERSION, JSON.stringify(payload)])
}

describe('owner activation boundary', () => {
  it('records a real boundary idempotently, rejects changed/future facts, and is not exposed to service_role', async () => {
    const first = await activate()
    const retry = await activate()
    expect(retry.result.id).toBe(first.result.id)
    await expect(one(`SELECT public.record_paid_measurement_activation(
      $1,$2,'2026-06-02T12:00:00Z',1,1,'controlled_journey','changed') result`,
    [ACCOUNT, ACTIVATION])).rejects.toThrow(/activation collision/i)
    await expect(one(`SELECT public.record_paid_measurement_activation(
      $1,'00000000-0000-4000-8000-000000000779',now()+interval '1 day',1,1,
      'controlled_journey','future') result`, [ACCOUNT])).rejects.toThrow(/future/i)

    const privilege = await one<{ service_can_activate: boolean; service_can_publish: boolean }>(`
      SELECT
        has_function_privilege('service_role','public.record_paid_measurement_activation(uuid,uuid,timestamptz,integer,integer,text,text)','EXECUTE') service_can_activate,
        has_function_privilege('service_role','public.commit_paid_cohort_pair(uuid,uuid,date,integer,integer,integer,jsonb)','EXECUTE') service_can_publish`)
    expect(privilege).toEqual({ service_can_activate: false, service_can_publish: true })
  })
})

describe('atomic direction-specific publication', () => {
  it('publishes recent+older-matured generations under one run and retries exactly', async () => {
    await activate()
    const first = await publish()
    expect(first.result).toMatchObject({ evaluation_run_id: RUN, recent_generation_id: RECENT, matured_generation_id: MATURED })
    expect((await publish()).result).toEqual(first.result)

    const counts = await one<{ generations: number; units: number; runs: number }>(`
      SELECT count(*)::int generations,
        (SELECT count(*)::int FROM public.paid_cohort_units) units,
        count(DISTINCT evaluation_run_id)::int runs
      FROM public.paid_cohort_generations`)
    expect(counts).toEqual({ generations: 2, units: 2, runs: 1 })
  })

  it('rejects overlap, an unmatured cut, inconsistent completeness, and rolls the pair back', async () => {
    await activate()
    const overlap = pair()
    overlap[1].window_end = '2026-07-16'
    await expect(publish(overlap)).rejects.toThrow(/non-overlapping/i)

    const immature = pair()
    immature[1].window_end = '2026-07-20'
    immature[0].window_start = '2026-07-21'
    await expect(publish(immature)).rejects.toThrow(/maturity lag/i)

    const inconsistent = pair()
    inconsistent[1].complete = false
    await expect(publish(inconsistent)).rejects.toThrow(/blocker/i)
    expect((await one<{ n: number }>(`SELECT count(*)::int n FROM public.paid_cohort_generations`)).n).toBe(0)
  })

  it('rejects a changed same-run retry instead of mixing stages', async () => {
    await activate()
    await publish()
    const changed = pair()
    changed[0].account_spend = 999
    await expect(publish(changed)).rejects.toThrow(/publication collision/i)
  })

  it('persists an explicitly blocked pair when no activation fact exists', async () => {
    const blocked = pair({
      activation_id: null,
      complete: false,
      blocker_codes: ['activation_missing'],
    })
    for (const generation of blocked) {
      generation.units = generation.units.map((unit) => ({
        ...unit,
        complete: false,
        blocker_codes: ['activation_missing'],
      }))
    }

    await expect(publish(blocked)).resolves.toMatchObject({
      result: { evaluation_run_id: RUN },
    })
    const rows = await db.query<{ activation_id: string | null; complete: boolean; blocker_codes: string[] }>(`
      SELECT activation_id, complete, blocker_codes
      FROM public.paid_cohort_generations ORDER BY cohort_kind`)
    expect(rows.rows).toEqual([
      { activation_id: null, complete: false, blocker_codes: ['activation_missing'] },
      { activation_id: null, complete: false, blocker_codes: ['activation_missing'] },
    ])
  })

  it('persists a pre-activation direction only when it is explicitly blocked', async () => {
    await one(`SELECT public.record_paid_measurement_activation(
      $1,$2,'2026-07-15T12:00:00Z',1,1,'controlled_journey','owner journey 2026-07-15'
    ) result`, [ACCOUNT, ACTIVATION])
    const blocked = pair()
    blocked[1] = {
      ...blocked[1],
      complete: false,
      blocker_codes: ['pre_activation_window'],
      units: [{
        ...blocked[1].units[0],
        complete: false,
        blocker_codes: ['pre_activation_window'],
      }],
    }

    await expect(publish(blocked)).resolves.toMatchObject({
      result: { evaluation_run_id: RUN },
    })
    const matured = await one<{ complete: boolean; blocker_codes: string[] }>(`
      SELECT complete, blocker_codes FROM public.paid_cohort_generations
      WHERE cohort_kind='matured_cut'`)
    expect(matured).toEqual({ complete: false, blocker_codes: ['pre_activation_window'] })
  })

  it('rejects complete or falsely-labelled generations at the activation boundary', async () => {
    const noActivation = pair({ activation_id: null })
    await expect(publish(noActivation)).rejects.toThrow(/activation_missing/i)

    const blockedWithoutReason = pair({
      activation_id: null,
      complete: false,
      blocker_codes: ['missing_account_insight_days'],
    })
    for (const generation of blockedWithoutReason) {
      generation.units = generation.units.map((unit) => ({
        ...unit,
        complete: false,
        blocker_codes: ['missing_account_insight_days'],
      }))
    }
    await expect(publish(blockedWithoutReason)).rejects.toThrow(/activation_missing/i)
  })
})
