import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshOutcomeDb, insertAppt, upsertAppt, observations, ACCOUNT, outcomeSourceId, outcomeUuid } from './acuity-harness'

// REAL-POSTGRES proofs for the outcome observation/delivery lineage. These verify the DB contract that makes the report's
// "expected value timing" claim falsifiable: without a recorded first observation and a recorded
// change, no difference may be called an expected timing delta.

/** PGlite hands back timestamptz as Date instances — normalise before comparing. */
const ts = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v)

async function row(db: PGlite, id: number) {
  const r = await db.query<{
    initial_price: string | null
    initial_canceled: boolean | null
    initial_provenance: string | null
    initial_observation_source: string | null
    initial_observed_at: string | null
    first_seen_at: string
    price: string | null
    canceled: boolean
    capi_sent_at: string | null
    capi_send_error: string | null
  }>(
    `SELECT initial_gross_value AS initial_price, (initial_status = 'cancelled') AS initial_canceled,
            initial_provenance, initial_observation_source, initial_observed_at, first_seen_at,
            gross_value AS price, (status = 'cancelled') AS canceled,
            conversion_sent_at AS capi_sent_at, conversion_send_error AS capi_send_error
     FROM outcomes WHERE id = $1`,
    [outcomeUuid(id)],
  )
  return r.rows[0]
}

describe('first observation', () => {
  it('stamps initial_* on INSERT and labels it observed', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 101, price: 410, source: 'webhook' })
    const r = await row(db, 101)
    expect(Number(r.initial_price)).toBe(410)
    expect(r.initial_canceled).toBe(false)
    expect(r.initial_provenance).toBe('observed')
    expect(r.initial_observation_source).toBe('webhook')
    expect(r.initial_observed_at).not.toBeNull()
  })

  it('records a first_observation lineage row', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 102, price: 250, source: 'sweep' })
    const obs = await observations(db, 102)
    expect(obs).toHaveLength(1)
    expect(obs[0].change_kind).toBe('first_observation')
    expect(obs[0].provenance).toBe('observed')
    expect(obs[0].observation_source).toBe('sweep')
    expect(Number(obs[0].new_gross_value)).toBe(250)
    expect(obs[0].old_gross_value).toBeNull()
  })

  it('an unset writer source is recorded as "unknown", never guessed', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 103, price: 100, source: null })
    expect((await row(db, 103)).initial_observation_source).toBe('unknown')
    expect((await observations(db, 103))[0].observation_source).toBe('unknown')
  })
})

describe('material change capture', () => {
  it('records a price_change with old and new values', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 201, price: 410, source: 'webhook' })
    await upsertAppt(db, { id: 201, price: 500, source: 'sweep' })

    const obs = await observations(db, 201)
    expect(obs.map((o) => o.change_kind)).toEqual(['first_observation', 'price_change'])
    expect(Number(obs[1].old_gross_value)).toBe(410)
    expect(Number(obs[1].new_gross_value)).toBe(500)
    expect(obs[1].observation_source).toBe('sweep')

    // The first observation is NOT rewritten by the later sweep — that is the whole point.
    const r = await row(db, 201)
    expect(Number(r.initial_price)).toBe(410)
    expect(Number(r.price)).toBe(500)
  })

  it('records a status_change when canceled flips', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 202, price: 300, canceled: false, source: 'webhook' })
    await upsertAppt(db, { id: 202, price: 300, canceled: true, source: 'sweep' })
    const obs = await observations(db, 202)
    expect(obs.map((o) => o.change_kind)).toEqual(['first_observation', 'status_change'])
    expect(obs[1].old_cancelled).toBe(false)
    expect(obs[1].new_cancelled).toBe(true)
  })

  it('records price_and_status_change when both move in one write', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 203, price: 300, canceled: false, source: 'webhook' })
    await upsertAppt(db, { id: 203, price: 0, canceled: true, source: 'sweep' })
    const obs = await observations(db, 203)
    expect(obs[1].change_kind).toBe('price_and_status_change')
  })

  it('an idempotent re-sync of identical values writes NO change row', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 204, price: 300, source: 'webhook' })
    await upsertAppt(db, { id: 204, price: 300, source: 'sweep' })
    await upsertAppt(db, { id: 204, price: 300, source: 'sweep' })
    expect(await observations(db, 204)).toHaveLength(1)
  })

  it('a NULL -> value price transition is material (IS DISTINCT FROM, not =)', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 205, price: null, source: 'webhook' })
    await upsertAppt(db, { id: 205, price: 175, source: 'sweep' })
    const obs = await observations(db, 205)
    expect(obs).toHaveLength(2)
    expect(obs[1].change_kind).toBe('price_change')
    expect(obs[1].old_gross_value).toBeNull()
    expect(Number(obs[1].new_gross_value)).toBe(175)
  })

  it('SEQUENTIAL same-appointment upserts lose no intermediate change', async () => {
    // Row locks serialise writers on one appointment id, so every committed transition must appear.
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 206, price: 100, source: 'webhook' })
    for (const p of [200, 300, 400, 500]) await upsertAppt(db, { id: 206, price: p, source: 'sweep' })
    const obs = await observations(db, 206)
    expect(obs).toHaveLength(5)
    expect(obs.slice(1).map((o) => Number(o.new_gross_value))).toEqual([200, 300, 400, 500])
    expect(obs.slice(1).map((o) => Number(o.old_gross_value))).toEqual([100, 200, 300, 400])
  })

  it('a multi-statement TRANSACTION records every step and rolls back atomically', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 207, price: 100, source: 'webhook' })
    await db.exec('BEGIN')
    await upsertAppt(db, { id: 207, price: 150, source: 'sweep' })
    await upsertAppt(db, { id: 207, price: 175, source: 'sweep' })
    await db.exec('ROLLBACK')
    // The observations were written in the SAME transaction, so they roll back with it — the log can
    // never claim a change that did not commit.
    expect(await observations(db, 207)).toHaveLength(1)
    expect(Number((await row(db, 207)).price)).toBe(100)
  })
})

describe('provenance labels', () => {
  it('rejects an unknown provenance label', async () => {
    const db = await freshOutcomeDb()
    await expect(
      db.query(
        `INSERT INTO outcomes (id, ad_account_id, source_id, external_id, outcome_type, currency, gross_value, initial_provenance)
         VALUES ($1, $2, $3, '306', 'booking', 'USD', 100, 'booking_time')`,
        [outcomeUuid(306), ACCOUNT, outcomeSourceId(ACCOUNT)],
      ),
    ).rejects.toThrow(/outcomes_initial_provenance_chk/)
  })
})

describe('first_seen_at semantics preserved', () => {
  it('an upsert never rewrites first_seen_at', async () => {
    const db = await freshOutcomeDb()
    await upsertAppt(db, { id: 401, price: 100, source: 'webhook' })
    const before = ts((await row(db, 401)).first_seen_at)
    await upsertAppt(db, { id: 401, price: 900, source: 'sweep' })
    expect(ts((await row(db, 401)).first_seen_at)).toBe(before)
  })
})

describe('no PII in the change log', () => {
  it('the observations table has no name/email/phone/raw columns', async () => {
    const db = await freshOutcomeDb()
    const r = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'outcome_observations'`,
    )
    const cols = r.rows.map((c) => c.column_name)
    for (const forbidden of ['first_name', 'last_name', 'email', 'phone', 'raw']) {
      expect(cols).not.toContain(forbidden)
    }
    expect(cols).toEqual(
      expect.arrayContaining(['outcome_id', 'old_gross_value', 'new_gross_value', 'old_cancelled', 'new_cancelled']),
    )
  })
})

// ── CAPI delivery lineage ──────────────────────────────────────────────────────────────────

async function recordDelivery(
  db: PGlite,
  over: Partial<{
    outcome_id: string; event_id: string; event_time: string; value: number | null; currency: string | null
    send_mode: string; events_received: number | null; error_state: string | null; error_class: string | null
    api_version: string
  }> = {},
) {
  const p = {
    outcome_id: outcomeUuid(501), event_id: 'acuity-501', event_time: '2026-07-20T14:00:00Z',
    value: 410, currency: 'USD', send_mode: 'live', events_received: 1,
    error_state: null as string | null, error_class: null as string | null, api_version: 'v25.0',
    ...over,
  }
  const r = await db.query<{ record_conversion_delivery: Record<string, unknown> }>(
    `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [p.outcome_id, p.event_id, p.event_time, p.value, p.currency, p.send_mode,
     p.events_received, p.error_state, p.error_class, p.api_version],
  )
  return r.rows[0].record_conversion_delivery as {
    accepted: boolean; accepted_at: string | null; delivered_at: string | null
    attempt_count: number; marked_sent: boolean; events_received: number | null
  }
}

describe('CAPI delivery lineage', () => {
  it('a live accepted delivery (events_received = 1) records lineage AND stamps capi_sent_at atomically', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const out = await recordDelivery(db)
    expect(out.accepted).toBe(true)
    expect(out.accepted_at).not.toBeNull()
    expect(out.delivered_at).not.toBeNull()
    expect(out.marked_sent).toBe(true)
    expect((await row(db, 501)).capi_sent_at).not.toBeNull()
  })

  it('events_received = 0 is NOT accepted and never stamps capi_sent_at', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const out = await recordDelivery(db, { events_received: 0 })
    expect(out.accepted).toBe(false)
    expect(out.accepted_at).toBeNull()
    expect(out.marked_sent).toBe(false)
    expect((await row(db, 501)).capi_sent_at).toBeNull()
  })

  it('events_received > 1 is NOT accepted — the payload was not the single event we sent', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const out = await recordDelivery(db, { events_received: 2 })
    expect(out.accepted).toBe(false)
    expect((await row(db, 501)).capi_sent_at).toBeNull()
  })

  it('a NULL events_received (call never landed) is NOT accepted', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const out = await recordDelivery(db, { events_received: null, error_state: 'http_error' })
    expect(out.accepted).toBe(false)
    expect((await row(db, 501)).capi_sent_at).toBeNull()
  })

  it('a TEST-mode accepted send records lineage but never marks delivery (R2)', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const out = await recordDelivery(db, { send_mode: 'test' })
    expect(out.accepted).toBe(true)
    expect(out.marked_sent).toBe(false)
    expect((await row(db, 501)).capi_sent_at).toBeNull()
  })

  it('RETRY on the deterministic event_id collapses onto ONE lineage row — no double-count', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const first = await recordDelivery(db)
    const second = await recordDelivery(db)
    expect(second.attempt_count).toBe(2)
    // First acceptance time is preserved across the retry.
    expect(second.accepted_at).toBe(first.accepted_at)

    const cnt = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM conversion_deliveries WHERE outcome_id = $1`, [outcomeUuid(501)],
    )
    expect(Number(cnt.rows[0].n)).toBe(1)
  })

  it('a failed attempt followed by a successful retry ends accepted, with attempts counted', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    const bad = await recordDelivery(db, { events_received: 0, error_state: 'no_events_received' })
    expect(bad.accepted).toBe(false)
    const good = await recordDelivery(db)
    expect(good.accepted).toBe(true)
    expect(good.attempt_count).toBe(2)
    expect((await row(db, 501)).capi_sent_at).not.toBeNull()
    expect((await row(db, 501)).capi_send_error).toBeNull()
  })

  it('persists value, currency, event_time and api_version for audit', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    await recordDelivery(db)
    const r = await db.query<{
      value_sent: string; currency_sent: string; api_version: string; event_time: string; event_id: string
    }>(`SELECT value_sent, currency_sent, api_version, event_time, event_id FROM conversion_deliveries WHERE outcome_id = $1`, [outcomeUuid(501)])
    expect(Number(r.rows[0].value_sent)).toBe(410)
    expect(r.rows[0].currency_sent).toBe('USD')
    expect(r.rows[0].api_version).toBe('v25.0')
    expect(r.rows[0].event_id).toBe('acuity-501')
  })

  it('rejects an invalid send_mode and a blank event_id', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    await expect(recordDelivery(db, { send_mode: 'production' })).rejects.toThrow(/send_mode must be live or test/)
    await expect(recordDelivery(db, { event_id: '  ' })).rejects.toThrow(/event_id is required/)
  })

  it('rolls back BOTH the lineage row and capi_sent_at when the transaction aborts', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 501, price: 410, source: 'webhook' })
    await db.exec('BEGIN')
    await recordDelivery(db)
    await db.exec('ROLLBACK')
    const cnt = await db.query<{ n: string }>(`SELECT count(*) AS n FROM conversion_deliveries`)
    expect(Number(cnt.rows[0].n)).toBe(0)
    expect((await row(db, 501)).capi_sent_at).toBeNull()
  })
})
