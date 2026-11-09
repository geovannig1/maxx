import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MIN_SWITCHBACK_BLOCKS, causalDb, fixtureUnitIds, insertClientAppointment, insertSwitchbackHistory, outcomeUuid,
} from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000101'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000102'
const EXPERIMENT = '00000000-0000-4000-8000-000000000103'
const DESIGN = '00000000-0000-4000-8000-000000000104'
const APPROVAL = '00000000-0000-4000-8000-000000000105'
const SOURCE_HEAD = `sha256:${'c'.repeat(64)}`
let db: PGlite

type Row = Record<string, unknown>

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

// A closed time-block experiment as the shipped schema admits one: twelve one-day
// switchback blocks from 2026-01-01 local midnight, with complete assignment coverage of the window.
let coverageWindow: { start: string; end: string; observedThrough: string }
async function createDesignAndAssignmentCoverage() {
  const unitIds = fixtureUnitIds(0x9085, MIN_SWITCHBACK_BLOCKS)
  const history = await insertSwitchbackHistory(db, {
    account: ACCOUNT, experiment: EXPERIMENT, design: DESIGN, approval: APPROVAL, unitIds,
  })
  coverageWindow = {
    start: history.start, end: history.end,
    observedThrough: new Date(Date.parse(history.end) + 86_400_000).toISOString(),
  }
  await db.query(`SELECT public.commit_causal_assignment_coverage_manifest(
    $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,true,ARRAY[]::text[],$8,
    $9::uuid[],$10,1,NULL,'appointment-assignment-coverage')`, [
    ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, coverageWindow.start, coverageWindow.end, coverageWindow.observedThrough,
    unitIds.length, unitIds, `sha256:${'f'.repeat(64)}`,
  ])
}

async function insertAppointment(id: number, over: Record<string, unknown> = {}) {
  const args = {
    created: '2026-01-02T12:00:00Z', scheduledBy: null,
    observed: '2026-01-02T12:00:01Z', error: null, ...over,
  } as { created: string; scheduledBy: string | null; observed: string | null; error: string | null }
  await insertClientAppointment(db, {
    id, account: ACCOUNT, createdAt: args.created, scheduledBy: args.scheduledBy,
    observedAt: args.observed, error: args.error,
  })
}

async function linkAppointment(id: number) {
  return one<Row>(`SELECT (public.link_causal_time_block_outcome(
    $1,$2,$3,$4,$5,1,$6
  )).*`, [ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, outcomeUuid(id), `appointment-link-${id}`])
}

async function commitCoverage(over: Record<string, unknown> = {}) {
  const args = {
    complete: true, blockers: [], expected: 1, appointments: [8501],
    sourceHead: SOURCE_HEAD, previous: null, dedupe: 'appointment-coverage-v1', ...over,
  }
  return one<Row>(`SELECT (public.commit_causal_outcome_coverage_manifest(
    $1,$2,$3,$4,$12::timestamptz,$13::timestamptz,
    $14::timestamptz,$5,$6::text[],$7,$8::uuid[],$9,1,$10::uuid,$11
  )).*`, [
    ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, args.complete, args.blockers, args.expected,
    (args.appointments as number[]).map(outcomeUuid), args.sourceHead, args.previous, args.dedupe,
    coverageWindow.start, coverageWindow.end, coverageWindow.observedThrough,
  ])
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT, OTHER_ACCOUNT)
  await createDesignAndAssignmentCoverage()
})

describe('causal appointment coverage manifests', () => {
  it('commits exact linked appointment membership and retries idempotently', async () => {
    await insertAppointment(8501)
    const link = await linkAppointment(8501)
    const first = await commitCoverage()
    const retry = await commitCoverage()
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      complete: true, revision: 1, expected_outcome_count: 1,
      actual_link_count: 1, membership_fingerprint: expect.stringMatching(/^md5:/),
    })
    expect(await one<{ link_id: string }>(`SELECT link_id FROM
      public.causal_outcome_coverage_members WHERE manifest_id=$1`, [first.id]))
      .toEqual({ link_id: link.id })
  })

  it('rejects a proven client booking that has no deterministic assignment link', async () => {
    await insertAppointment(8501)
    await expect(commitCoverage()).rejects.toThrow(/every proven client booking.*linked/i)
  })

  it('rejects incomplete or duplicate caller membership', async () => {
    await insertAppointment(8501)
    await linkAppointment(8501)
    await expect(commitCoverage({ appointments: [] })).rejects.toThrow(/exact membership/i)
    await expect(commitCoverage({
      appointments: [8501, 8501], dedupe: 'duplicate-appointments',
    })).rejects.toThrow(/duplicate/i)
  })

  it('blocks completeness while any appointment origin is unresolved', async () => {
    await insertAppointment(8502, { observed: null, error: 'origin_unknown' })
    await expect(commitCoverage({ expected: 0, appointments: [] }))
      .rejects.toThrow(/unresolved appointment origin/i)
  })

  it('preserves a complete zero-appointment coverageWindow', async () => {
    const manifest = await commitCoverage({ expected: 0, appointments: [] })
    expect(manifest).toMatchObject({
      complete: true, expected_outcome_count: 0, actual_link_count: 0,
    })
  })

  it('records an incomplete blocker and recovers only as a new exact-coverageWindow revision', async () => {
    const blocked = await commitCoverage({
      complete: false, blockers: ['outcome_unavailable'], expected: null, appointments: [],
      dedupe: 'appointment-coverage-blocked',
    })
    const recovered = await commitCoverage({
      expected: 0, appointments: [], previous: blocked.id,
      sourceHead: `sha256:${'1'.repeat(64)}`, dedupe: 'appointment-coverage-recovered',
    })
    expect(recovered).toMatchObject({ revision: 2, previous_manifest_id: blocked.id, complete: true })
  })

  it('keeps both ledgers append-only and private', async () => {
    const manifest = await commitCoverage({ expected: 0, appointments: [] })
    await expect(db.query(`UPDATE public.causal_outcome_coverage_manifests
      SET complete=false WHERE id=$1`, [manifest.id])).rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          CROSS JOIN (VALUES ('causal_outcome_coverage_manifests'),
            ('causal_outcome_coverage_members')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_outcome_coverage_manifests'),
            ('causal_outcome_coverage_members')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) browser_reads,
        (SELECT count(*)::int FROM (VALUES ('causal_outcome_coverage_manifests'),
            ('causal_outcome_coverage_members')) t(table_name)
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 2 })
  })
})
