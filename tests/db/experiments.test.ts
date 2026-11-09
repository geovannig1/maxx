import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// REAL-POSTGRES proofs for the `experiments` registry. The registry's value is that its constraints make a
// dishonest experiment record impossible to write: a completed test with no outcome, a stopped test
// with no reason, or two concurrent tests on the same variable contaminating each other.

const ACCOUNT = '00000000-0000-4000-8000-000000000001'

async function freshDb(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT)
  return db
}

// experiments_guard_transitions requires coherent timestamps for non-draft states, so a direct insert into a
// terminal state must supply them (the RPCs do this automatically in real use).
const INSERT = `
  INSERT INTO experiments
    (ad_account_id, hypothesis, changed_variable, control_ref, challenger_ref, invariants,
     primary_metric, guardrails, min_sample, min_spend, success_contract, status, outcome, stop_reason,
     entity_level, entity_ref,
     started_at, ended_at)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,
     CASE WHEN $12 IN ('running','stopped','complete') THEN now() END,
     CASE WHEN $12 IN ('stopped','complete') THEN now() END)
  RETURNING id`

async function insert(
  db: PGlite,
  over: Partial<{
    variable: string; status: string; outcome: string | null; stopReason: string | null
    entityLevel: string | null; entityRef: string | null
  }> = {},
) {
  // An experiment cannot START without a non-blank identity, so the default helper
  // supplies one. Tests that need the no-identity case pass entityRef: null explicitly.
  const p = {
    variable: 'daily_budget', status: 'draft', outcome: null as string | null, stopReason: null as string | null,
    entityLevel: 'adset' as string | null, entityRef: 'entity-A' as string | null, ...over,
  }
  return db.query<{ id: string }>(INSERT, [
    ACCOUNT,
    'Increasing delivery causes more first-party bookings rather than re-attributing them',
    p.variable, 'current $30', 'proposed $45',
    JSON.stringify({ audience: 'unchanged', placements: 'unchanged' }),
    'first-party bookings',
    JSON.stringify(['abort above breakeven CPA']),
    30, 500,
    'SUCCESS: ... FAILURE: ... INCONCLUSIVE: ... fixed before the run',
    p.status, p.outcome, p.stopReason, p.entityLevel, p.entityRef,
  ])
}

describe('experiment registry', () => {
  it('stores a full test brief', async () => {
    const db = await freshDb()
    const r = await insert(db)
    expect(r.rows[0].id).toBeTruthy()

    const row = await db.query<{
      hypothesis: string; changed_variable: string; primary_metric: string
      min_sample: number; min_spend: string; success_contract: string; status: string
      invariants: Record<string, unknown>; guardrails: unknown[]
    }>(`SELECT * FROM experiments WHERE id = $1`, [r.rows[0].id])
    const e = row.rows[0]
    expect(e.changed_variable).toBe('daily_budget')
    expect(e.primary_metric).toBe('first-party bookings')
    expect(e.min_sample).toBe(30)
    expect(Number(e.min_spend)).toBe(500)
    expect(e.status).toBe('draft')
    expect(e.invariants).toMatchObject({ audience: 'unchanged' })
    expect(e.guardrails).toHaveLength(1)
  })

  it('a COMPLETE experiment must carry an outcome', async () => {
    const db = await freshDb()
    await expect(insert(db, { status: 'complete', outcome: null }))
      .rejects.toThrow(/experiments_complete_needs_outcome/)
    await expect(insert(db, { status: 'complete', outcome: 'inconclusive' })).resolves.toBeTruthy()
  })

  it('a STOPPED experiment must state why', async () => {
    const db = await freshDb()
    await expect(insert(db, { status: 'stopped', stopReason: null }))
      .rejects.toThrow(/experiments_stopped_needs_reason/)
    await expect(insert(db, { status: 'stopped', stopReason: 'guardrail breached' })).resolves.toBeTruthy()
  })

  it('rejects an unknown status and an unknown outcome', async () => {
    const db = await freshDb()
    await expect(insert(db, { status: 'winning' })).rejects.toThrow(/experiments_status_chk/)
    await expect(insert(db, { status: 'complete', outcome: 'probably_good' })).rejects.toThrow(/experiments_outcome_chk/)
  })

  it('allows the three legitimate outcomes', async () => {
    const db = await freshDb()
    for (const o of ['success', 'failure', 'inconclusive']) {
      await expect(insert(db, { status: 'complete', outcome: o, variable: `v_${o}` })).resolves.toBeTruthy()
    }
  })

  it('at most ONE running experiment per changed variable — concurrent tests cannot contaminate', async () => {
    const db = await freshDb()
    await insert(db, { status: 'running' })
    // Another entity, so only the per-variable index applies: a row that also duplicates the open
    // (entity, variable) pair is reported by whichever unique index Postgres checks first.
    await expect(insert(db, { status: 'running', entityRef: 'entity-B' }))
      .rejects.toThrow(/uniq_experiments_running_variable/)
    // A DIFFERENT variable may run at the same time.
    await expect(insert(db, { status: 'running', variable: 'creative' })).resolves.toBeTruthy()
    // The schema additionally forbids a second OPEN row for the same (entity, variable) — a draft
    // duplicating a running test on the same ad set is not a legitimate second brief.
    await expect(insert(db, { status: 'draft' })).rejects.toThrow(/uniq_experiments_open_per_entity_variable/)
    // A draft for a DIFFERENT entity on the same variable is fine.
    await expect(insert(db, { status: 'draft', entityRef: 'entity-OTHER' })).resolves.toBeTruthy()
  })

  it('an owner decision and its timestamp must be set together', async () => {
    const db = await freshDb()
    const r = await insert(db)
    await expect(
      db.query(`UPDATE experiments SET owner_decision = 'adopt' WHERE id = $1`, [r.rows[0].id]),
    ).rejects.toThrow(/experiments_owner_decision_needs_time/)
    await expect(
      db.query(`UPDATE experiments SET owner_decision = 'adopt', owner_decided_at = now() WHERE id = $1`, [r.rows[0].id]),
    ).resolves.toBeTruthy()
  })

  it('is account-scoped and CASCADEs with its account', async () => {
    const db = await freshDb()
    await insert(db)
    const before = await db.query<{ n: string }>(`SELECT count(*) n FROM experiments WHERE ad_account_id = $1`, [ACCOUNT])
    expect(Number(before.rows[0].n)).toBe(1)
    await db.query(`DELETE FROM ad_accounts WHERE id = $1`, [ACCOUNT])
    const after = await db.query<{ n: string }>(`SELECT count(*) n FROM experiments`)
    expect(Number(after.rows[0].n)).toBe(0)
  })

  it('requires the non-negotiable brief fields', async () => {
    const db = await freshDb()
    for (const missing of ['hypothesis', 'changed_variable', 'primary_metric', 'success_contract']) {
      await expect(
        db.query(
          `INSERT INTO experiments (ad_account_id, hypothesis, changed_variable, control_ref, challenger_ref, primary_metric, success_contract)
           VALUES ($1,$2,$3,'c','ch',$4,$5)`,
          [
            ACCOUNT,
            missing === 'hypothesis' ? null : 'h',
            missing === 'changed_variable' ? null : 'v',
            missing === 'primary_metric' ? null : 'm',
            missing === 'success_contract' ? null : 's',
          ],
        ),
      ).rejects.toThrow(/null value in column/)
    }
  })
})


// ── The state machine ─────────────────────────────────────────────────────────────────
describe('experiments are a durable state machine', () => {
  const rpc = async (db: PGlite, fn: string, args: unknown[]) =>
    (await db.query<Record<string, unknown>>(`SELECT ${fn} AS r`, args)).rows[0].r as Record<string, unknown>

  it('floors are NON-NULL and non-negative', async () => {
    const db = await freshDb()
    await expect(
      db.query(`INSERT INTO experiments (ad_account_id, hypothesis, changed_variable, control_ref, challenger_ref, primary_metric, success_contract, min_sample)
                VALUES ($1,'h','v','c','ch','m','s',-1)`, [ACCOUNT]),
    ).rejects.toThrow(/experiments_floors_nonnegative/)
    // Omitted floors default to 0 rather than NULL.
    const r = await db.query<{ min_sample: number; min_spend: string }>(
      `INSERT INTO experiments (ad_account_id, hypothesis, changed_variable, control_ref, challenger_ref, primary_metric, success_contract)
       VALUES ($1,'h','v2','c','ch','m','s') RETURNING min_sample, min_spend`, [ACCOUNT])
    expect(r.rows[0].min_sample).toBe(0)
  })

  it('a RUNNING experiment must carry REAL floors — a zero floor clears trivially', async () => {
    const db = await freshDb()
    const id = (await insert(db, { variable: 'zero_floor' })).rows[0].id
    await db.query(`UPDATE experiments SET min_sample = 0, min_spend = 0 WHERE id=$1`, [id])
    await expect(rpc(db, 'start_experiment($1)', [id])).rejects.toThrow(/experiments_running_needs_real_floors/)
  })

  it('preregistration is IMMUTABLE once the experiment leaves draft', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await rpc(db, 'start_experiment($1)', [id])
    for (const col of ['hypothesis', 'changed_variable', 'primary_metric', 'success_contract']) {
      await expect(db.query(`UPDATE experiments SET ${col} = 'edited' WHERE id=$1`, [id]))
        .rejects.toThrow(/preregistration fields \(including entity identity\) are immutable/)
    }
    await expect(db.query(`UPDATE experiments SET min_sample = 1 WHERE id=$1`, [id]))
      .rejects.toThrow(/preregistration fields \(including entity identity\) are immutable/)
  })

  it('a DRAFT may still be edited', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await expect(db.query(`UPDATE experiments SET hypothesis = 'refined' WHERE id=$1`, [id])).resolves.toBeTruthy()
  })

  it('only documented status transitions are allowed', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    // draft -> complete is NOT an edge.
    await expect(db.query(`UPDATE experiments SET status='complete', outcome='success', ended_at=now() WHERE id=$1`, [id]))
      .rejects.toThrow(/invalid status transition draft -> complete/)
    await rpc(db, 'start_experiment($1)', [id])
    await rpc(db, 'complete_experiment($1,$2)', [id, 'success'])
    // complete is TERMINAL.
    await expect(db.query(`UPDATE experiments SET status='running' WHERE id=$1`, [id]))
      .rejects.toThrow(/invalid status transition complete -> running/)
  })

  it('an outcome can never be revised once recorded', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await rpc(db, 'start_experiment($1)', [id])
    await rpc(db, 'complete_experiment($1,$2)', [id, 'failure'])
    await expect(db.query(`UPDATE experiments SET outcome='success' WHERE id=$1`, [id]))
      .rejects.toThrow(/outcome cannot be revised/)
  })

  it('the RPCs stamp the required timestamps', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    const started = await rpc(db, 'start_experiment($1)', [id])
    expect(started.started_at).toBeTruthy()
    const done = await rpc(db, 'complete_experiment($1,$2)', [id, 'inconclusive'])
    expect(done.ended_at).toBeTruthy()
    expect(done.outcome).toBe('inconclusive')
  })

  it('stop_experiment requires a reason', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await rpc(db, 'start_experiment($1)', [id])
    await expect(rpc(db, 'stop_experiment($1,$2)', [id, '  '])).rejects.toThrow(/stop reason is required/)
    const r = await rpc(db, 'stop_experiment($1,$2)', [id, 'guardrail breached'])
    expect(r.stop_reason).toBe('guardrail breached')
  })

  it('complete_experiment rejects an invented outcome', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await rpc(db, 'start_experiment($1)', [id])
    await expect(rpc(db, 'complete_experiment($1,$2)', [id, 'probably_good']))
      .rejects.toThrow(/outcome must be success\|failure\|inconclusive/)
  })

  it('an owner decision requires a RESULT to decide on', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    // Still a draft: there is no result yet.
    await expect(rpc(db, 'record_experiment_owner_decision($1,$2)', [id, 'adopt']))
      .rejects.toThrow(/is not complete or stopped/)
    await rpc(db, 'start_experiment($1)', [id])
    await rpc(db, 'complete_experiment($1,$2)', [id, 'success'])
    const r = await rpc(db, 'record_experiment_owner_decision($1,$2)', [id, 'adopt'])
    expect(r.owner_decision).toBe('adopt')
    expect(r.owner_decided_at).toBeTruthy()
  })

  it('ended_at cannot precede started_at', async () => {
    const db = await freshDb()
    const id = (await insert(db)).rows[0].id
    await rpc(db, 'start_experiment($1)', [id])
    await expect(db.query(`UPDATE experiments SET ended_at = '2000-01-01' WHERE id=$1`, [id]))
      .rejects.toThrow(/experiments_end_after_start/)
  })
})


// A pre-squash migration added entity_level/entity_ref but never extended the transition guard, so a RUNNING or
// COMPLETED experiment could be RETARGETED to a different entity after its evidence was observed —
// post-hoc retargeting of causal evidence, the exact failure preregistration exists to prevent.
describe('experiment IDENTITY is immutable once launched', () => {
  const rpc = async (db: PGlite, fn: string, args: unknown[]) =>
    (await db.query<Record<string, unknown>>(`SELECT ${fn} AS r`, args)).rows[0].r as Record<string, unknown>

  const withIdentity = async (db: PGlite, level = 'adset', ref = 'entity-A') =>
    (await insert(db, { entityLevel: level, entityRef: ref })).rows[0].id

  it('a RUNNING experiment cannot be retargeted to another entity', async () => {
    const db = await freshDb()
    const id = await withIdentity(db)
    await rpc(db, 'start_experiment($1)', [id])
    await expect(db.query(`UPDATE experiments SET entity_ref='entity-B' WHERE id=$1`, [id]))
      .rejects.toThrow(/preregistration fields \(including entity identity\) are immutable/)
    await expect(db.query(`UPDATE experiments SET entity_level='campaign' WHERE id=$1`, [id]))
      .rejects.toThrow(/immutable/)
  })

  it('a COMPLETED experiment cannot be retargeted either', async () => {
    const db = await freshDb()
    const id = await withIdentity(db)
    await rpc(db, 'start_experiment($1)', [id])
    await rpc(db, 'complete_experiment($1,$2)', [id, 'success'])
    await expect(db.query(`UPDATE experiments SET entity_level='campaign', entity_ref='entity-B' WHERE id=$1`, [id]))
      .rejects.toThrow(/immutable/)
  })

  it('a DRAFT may still have its identity corrected', async () => {
    const db = await freshDb()
    const id = await withIdentity(db)
    await expect(db.query(`UPDATE experiments SET entity_ref='entity-corrected' WHERE id=$1`, [id])).resolves.toBeTruthy()
  })

  it('an experiment cannot START without a non-blank identity', async () => {
    const db = await freshDb()
    const noIdentity = (await insert(db, { variable: 'v_no_ident', entityLevel: null, entityRef: null })).rows[0].id
    await expect(rpc(db, 'start_experiment($1)', [noIdentity]))
      .rejects.toThrow(/cannot start without a non-blank entity_level\/entity_ref/)
  })

  it('a BLANK entity_ref is rejected outright', async () => {
    const db = await freshDb()
    const id = (await insert(db, { variable: 'v_blank' })).rows[0].id
    await expect(db.query(`UPDATE experiments SET entity_ref='   ' WHERE id=$1`, [id]))
      .rejects.toThrow(/experiments_entity_ref_nonblank/)
  })
})
