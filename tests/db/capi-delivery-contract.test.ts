import { describe, it, expect } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshOutcomeDb, insertAppt, outcomeUuid } from './acuity-harness'

const U601 = outcomeUuid(601)

// Adversarial proofs for the rebuilt CAPI delivery contract (`conversion_deliveries`).
//
// An earlier delivery contract overwrote event_time / value / mode / events_received / error_state on EVERY retry,
// so an accepted event followed by a transient failure produced a row that said BOTH "accepted at T"
// and "0 events received, errored". The audit record for a real Meta acceptance was destroyed by a
// retry that Meta itself had already deduplicated.

async function record(
  db: PGlite,
  over: Partial<{
    appointmentId: number; eventId: string; eventTime: string; value: number | null
    currency: string | null; mode: string; eventsReceived: number | null
    errorState: string | null; errorClass: string | null; apiVersion: string
  }> = {},
) {
  const p = {
    appointmentId: 601, eventTime: '2026-07-20T14:00:00Z', value: 410, currency: 'USD',
    mode: 'live', eventsReceived: 1 as number | null,
    errorState: null as string | null, errorClass: null as string | null, apiVersion: 'v25.0',
    ...over,
  }
  const eventId = over.eventId ?? `acuity-${p.appointmentId}`
  const r = await db.query<{ record_conversion_delivery: Record<string, unknown> }>(
    `SELECT record_conversion_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [outcomeUuid(p.appointmentId), eventId, p.eventTime, p.value, p.currency, p.mode,
     p.eventsReceived, p.errorState, p.errorClass, p.apiVersion],
  )
  return r.rows[0].record_conversion_delivery as Record<string, unknown>
}

async function row(db: PGlite, appointmentId = 601) {
  const r = await db.query<Record<string, unknown>>(
    `SELECT * FROM conversion_deliveries WHERE outcome_id = $1`, [outcomeUuid(appointmentId)],
  )
  return r.rows[0]
}

async function parent(db: PGlite, id = 601) {
  const r = await db.query<{ capi_sent_at: unknown }>(
    `SELECT conversion_sent_at AS capi_sent_at FROM outcomes WHERE id = $1`, [outcomeUuid(id)],
  )
  return r.rows[0]
}

describe('derived event_id', () => {
  it('rejects an event_id that does not match its appointment', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await expect(record(db, { eventId: 'acuity-999' }))
      .rejects.toThrow(new RegExp(`does not match outcome ${U601}`))
  })

  it('rejects a free-form event_id', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await expect(record(db, { eventId: 'whatever' })).rejects.toThrow(/does not match outcome/)
  })

  it('CROSS-APPOINTMENT reuse is impossible — the constraint blocks it structurally', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await insertAppt(db, { id: 602, price: 250, source: 'webhook' })
    await record(db, { appointmentId: 601 })
    // Appointment 602 trying to claim 601's event_id.
    await expect(record(db, { appointmentId: 602, eventId: 'acuity-601' }))
      .rejects.toThrow(new RegExp(`does not match outcome ${outcomeUuid(602)}`))
    // A direct write bypassing the RPC is also rejected, by the conversion_delivery_event_id_derived trigger (was a CHECK).
    await expect(
      db.query(
        `INSERT INTO conversion_deliveries (outcome_id, event_id, event_time, send_mode)
         VALUES ($1, 'acuity-601', now(), 'live')`, [outcomeUuid(602)],
      ),
    ).rejects.toThrow(/conversion_delivery_event_id_derived/)
    // 601's row still belongs to 601 and is untouched.
    expect((await row(db, 601)).outcome_id).toBe(U601)
  })
})

describe('acceptance requires all three conditions', () => {
  it('an error_class alone blocks acceptance (050 ignored it)', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    const out = await record(db, { eventsReceived: 1, errorState: null, errorClass: 'meta_error' })
    expect(out.accepted).toBe(false)
    expect(out.marked_sent).toBe(false)
    expect((await parent(db)).capi_sent_at).toBeNull()
  })

  it('error_state, wrong count and null count each block acceptance', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    expect((await record(db, { errorState: 'http_error' })).accepted).toBe(false)
    expect((await record(db, { eventsReceived: 0 })).accepted).toBe(false)
    expect((await record(db, { eventsReceived: 2 })).accepted).toBe(false)
    expect((await record(db, { eventsReceived: null })).accepted).toBe(false)
    expect((await parent(db)).capi_sent_at).toBeNull()
  })

  it('all three satisfied accepts and stamps the parent', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    const out = await record(db)
    expect(out.accepted).toBe(true)
    expect(out.marked_sent).toBe(true)
    expect((await parent(db)).capi_sent_at).not.toBeNull()
  })
})

describe('an acceptance can never be overwritten', () => {
  it('ACCEPTED -> FAILED retry preserves every accepted fact', async () => {
    // The exact 050 corruption.
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    const first = await record(db)
    expect(first.accepted).toBe(true)

    const retry = await record(db, { eventsReceived: 0, errorState: 'no_events_received', errorClass: 'no_events_received', value: 999, eventTime: '2026-07-25T00:00:00Z', mode: 'test' })
    expect(retry.accepted).toBe(false)            // THIS attempt failed...
    expect(retry.ever_live_accepted).toBe(true)   // ...but the LIVE acceptance still stands
    expect(retry.was_already_accepted).toBe(true)

    const r = await row(db)
    // Accepted facts unchanged.
    expect(Number(r.accepted_value)).toBe(410)
    expect(r.accepted_currency).toBe('USD')
    expect(r.accepted_send_mode).toBe('live')
    expect(Number(r.accepted_events_received)).toBe(1)
    expect(r.accepted_at).not.toBeNull()
    expect(r.delivered_at).not.toBeNull()
    // Last-attempt facts record the failure separately.
    expect(Number(r.last_attempt_value)).toBe(999)
    expect(r.last_attempt_error_state).toBe('no_events_received')
    expect(Number(r.last_attempt_events_received)).toBe(0)
    // Attempts are counted separately.
    expect(Number(r.accepted_attempt_count)).toBe(1)
    expect(Number(r.failed_attempt_count)).toBe(1)
    expect(Number(r.attempt_count)).toBe(2)
    // The legacy mirror columns are FROZEN at the accepted values — no self-contradiction.
    expect(Number(r.events_received)).toBe(1)
    expect(r.error_state).toBeNull()
    // The parent stays delivered.
    expect((await parent(db)).capi_sent_at).not.toBeNull()
  })

  it('a MUTATED retry value cannot restate the accepted value', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await record(db)
    await record(db, { value: 5000, currency: 'EUR', eventTime: '2030-01-01T00:00:00Z' })
    const r = await row(db)
    expect(Number(r.accepted_value)).toBe(410)
    expect(r.accepted_currency).toBe('USD')
    expect(new Date(r.accepted_event_time as string).toISOString()).toBe('2026-07-20T14:00:00.000Z')
  })

  it('FAILED -> ACCEPTED retry accepts cleanly and stamps the parent', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    const bad = await record(db, { eventsReceived: 0, errorState: 'no_events_received', errorClass: 'no_events_received' })
    expect(bad.accepted).toBe(false)
    expect((await parent(db)).capi_sent_at).toBeNull()

    const good = await record(db)
    expect(good.accepted).toBe(true)
    expect(good.marked_sent).toBe(true)
    const r = await row(db)
    expect(Number(r.accepted_events_received)).toBe(1)
    expect(Number(r.failed_attempt_count)).toBe(1)
    expect(Number(r.accepted_attempt_count)).toBe(1)
    expect((await parent(db)).capi_sent_at).not.toBeNull()
  })

  it('a DIRECT update of accepted facts is rejected by the immutability trigger', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await record(db)
    for (const sql of [
      `UPDATE conversion_deliveries SET accepted_value = 1 WHERE outcome_id = '${U601}'`,
      `UPDATE conversion_deliveries SET accepted_at = now() WHERE outcome_id = '${U601}'`,
      `UPDATE conversion_deliveries SET accepted_events_received = 5 WHERE outcome_id = '${U601}'`,
      `UPDATE conversion_deliveries SET event_id = 'acuity-602' WHERE outcome_id = '${U601}'`,
    ]) {
      await expect(db.query(sql)).rejects.toThrow(/accepted delivery facts are immutable|conversion_delivery_event_id_derived/)
    }
  })

  it('mixed-result retries in ANY order converge on the same accepted record', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await record(db, { eventsReceived: 0, errorState: 'http_error', errorClass: 'http_error' })
    await record(db)                                                     // accept
    await record(db, { eventsReceived: 2, errorState: 'unexpected_events_received', errorClass: 'unexpected_events_received' })
    await record(db, { errorClass: 'meta_error', errorState: 'meta_error' })
    await record(db)                                                     // accept again (Meta dedups)

    const r = await row(db)
    expect(Number(r.accepted_value)).toBe(410)
    expect(Number(r.accepted_events_received)).toBe(1)
    expect(Number(r.accepted_attempt_count)).toBe(2)  // two accepted sends of the SAME event_id
    expect(Number(r.failed_attempt_count)).toBe(3)
    expect(Number(r.attempt_count)).toBe(5)
    expect((await parent(db)).capi_sent_at).not.toBeNull()
  })

  // An earlier revision froze the FIRST acceptance whatever its mode, so a test-mode
  // rehearsal permanently occupied the accepted slot and a later GENUINE live acceptance could never
  // be recorded. Test and live acceptances are now tracked separately.
  it('a TEST acceptance never marks delivery and never blocks a later LIVE acceptance', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })

    const t = await record(db, { mode: 'test' })
    expect(t.accepted).toBe(true)
    expect(t.test_accepted).toBe(true)
    expect(t.live_accepted).toBe(false)
    expect(t.marked_sent).toBe(false)
    expect((await parent(db)).capi_sent_at).toBeNull()
    expect((await row(db)).live_accepted_at).toBeNull()
    expect((await row(db)).test_accepted_at).not.toBeNull()

    // The later LIVE acceptance lands and IS the delivery.
    const l = await record(db, { mode: 'live' })
    expect(l.live_accepted).toBe(true)
    expect(l.marked_sent).toBe(true)
    const r = await row(db)
    expect(r.live_accepted_at).not.toBeNull()
    expect(r.accepted_send_mode).toBe('live')
    expect(Number(r.test_accepted_count)).toBe(1)
    expect((await parent(db)).capi_sent_at).not.toBeNull()
  })

  it('repeated TEST acceptances never accumulate into delivery evidence', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    for (let i = 0; i < 3; i++) await record(db, { mode: 'test' })
    const r = await row(db)
    expect(Number(r.test_accepted_count)).toBe(3)
    expect(r.live_accepted_at).toBeNull()
    expect(Number(r.accepted_attempt_count)).toBe(0)
    expect((await parent(db)).capi_sent_at).toBeNull()
  })

  it('the accepted API VERSION is immutable — 053 left it unprotected', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await record(db, { apiVersion: 'v25.0' })
    await expect(db.query(`UPDATE conversion_deliveries SET accepted_api_version = 'v99.0' WHERE outcome_id = '${U601}'`))
      .rejects.toThrow(/accepted delivery facts are immutable/)
    // ...and a later retry on a bumped version cannot rewrite it either.
    await record(db, { apiVersion: 'v26.0' })
    expect((await row(db)).accepted_api_version).toBe('v25.0')
    expect((await row(db)).last_attempt_api_version).toBe('v26.0')
  })

  it('there is exactly ONE canonical live delivery per appointment', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await record(db, { mode: 'test' })
    await record(db, { mode: 'live' })
    await record(db, { mode: 'live' })
    await record(db, { mode: 'test' })
    const n = await db.query<{ n: string }>(`SELECT count(*) n FROM conversion_deliveries WHERE outcome_id = '${U601}'`)
    expect(Number(n.rows[0].n)).toBe(1)
    const live = await db.query<{ n: string }>(`SELECT count(*) n FROM conversion_deliveries WHERE outcome_id = '${U601}' AND live_accepted_at IS NOT NULL`)
    expect(Number(live.rows[0].n)).toBe(1)
  })
})

describe('parent identity', () => {
  it('stamps the parent named by the PERSISTED row', async () => {
    const db = await freshOutcomeDb()
    await insertAppt(db, { id: 601, price: 410, source: 'webhook' })
    await insertAppt(db, { id: 602, price: 250, source: 'webhook' })
    await record(db, { appointmentId: 601 })
    expect((await parent(db, 601)).capi_sent_at).not.toBeNull()
    expect((await parent(db, 602)).capi_sent_at).toBeNull() // the other appointment is untouched
  })

  it('raises when no appointment matches, rather than silently marking nothing', async () => {
    const db = await freshOutcomeDb()
    await expect(record(db, { appointmentId: 60123 })).rejects.toThrow()
  })

  it('rolls back the delivery row when the parent stamp fails', async () => {
    const db = await freshOutcomeDb()
    await expect(record(db, { appointmentId: 60124 })).rejects.toThrow()
    const n = await db.query<{ n: string }>(`SELECT count(*) n FROM conversion_deliveries`)
    expect(Number(n.rows[0].n)).toBe(0)
  })
})
