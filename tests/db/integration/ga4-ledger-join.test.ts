import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { buildGa4ReconciliationBlock, reconcileGa4Bookings, renderGa4ReconciliationBlock } from '@/lib/ga4/booking-reconciliation'
import { ledgerRowFromBusinessOutcome } from '@/lib/outcomes/business-facts'
import type { BusinessOutcomeLedgerRow, LedgerAppointmentLite } from '@/lib/outcomes/business-facts'
import type { Ga4IdentifiedBookingEvent } from '@/lib/ga4/client'
import { getAdminClient } from '@/lib/supabase/admin'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome, removeAccountOutcomes } from './outcome-fixture'

// REAL Supabase/PostgREST proof for the GA/ledger join. The unit tests exercise the pure reconciler;
// this proves the PRODUCTION read: account scoping, the date window, and — the point of the round —
// that business bookings and revenue come from the ledger even when GA is entirely unavailable.
//
// GA4 is NOT configured in this environment, so getGa4IdentifiedBookingEvents returns
// available:false. That is exactly the state the acceptance criteria care about: a GA configuration
// failure must NOT become a zero-bookings claim.

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT_A = '00000000-0000-4000-8000-0000000000e1'
const ACCT_B = '00000000-0000-4000-8000-0000000000e2'
// PK ranges are partitioned per integration file so concurrently-running suites cannot collide:
//   990 acuity-lineage · 992 capi-concurrency · 993 reconciliation-scope · 994 run-daily-sync-evidence
//   995 booking-lifecycle · 996 THIS FILE
// (994 was originally used here too, which collided with run-daily-sync-evidence's seeded 994000001/2
//  and made that suite fail on a duplicate primary key.)
const BASE = 996000000
const IDS = { paid: BASE + 1, comp: BASE + 2, canceled: BASE + 3, other: BASE + 4, sameMinuteA: BASE + 5, sameMinuteB: BASE + 6 }
const SINCE = '2026-05-01', UNTIL = '2026-05-31'
const CREATED = '2026-05-10T12:34:00Z'   // sameMinuteA and sameMinuteB share this exact minute
const EXTERNAL_IDS = Object.values(IDS).map(String)

let c: pg.Client

// `origin` decides whether an absent GA event is a real gap or expected. 'website' means a by-id
// payload actually observed a client booking; 'staff' means it was created by staff, so it never had a
// website session. Leaving both null would make the row origin_unknown, which BLOCKS exactness.
// price_sold is no longer a ledger column; like the writer, the fixture keeps it only in raw.
const seed = (
  id: number, acct: string, price: number, priceSold: number, canceled: boolean,
  origin: 'website' | 'staff' = 'website',
) =>
  insertOutcomeOutcome(c, acct, id, {
    gross_value: price, collected_value: price, status: canceled ? 'cancelled' : 'confirmed',
    occurred_at: CREATED, business_date: '2026-05-10', observation_source: 'webhook',
    origin_observed_at: CREATED, origin_observed_source: 'webhook',
    origin: origin === 'staff' ? 'staff_or_manual' : 'website',
    raw: JSON.stringify({ id, priceSold: String(priceSold) }),
  })

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
  await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_e1'),($2,'act_e2')`, [ACCT_A, ACCT_B])
  const health = JSON.stringify({
    last_reconciled_at: new Date().toISOString(),
    window_basis: 'booking_date_et',
    window_start_date: '2026-01-01',
    window_end_date: '2026-12-31',
    truncated: false,
  })
  await c.query(
    `INSERT INTO app_settings (ad_account_id, key, value, setting_type)
     VALUES ($1, 'acuity_ledger_health', $3, 'json'),
            ($2, 'acuity_ledger_health', $3, 'json')`,
    [ACCT_A, ACCT_B, health],
  )

  await seed(IDS.paid, ACCT_A, 220, 220, false)        // a real $220 booking
  await seed(IDS.comp, ACCT_A, 0, 125, false)          // active comp: nominal 125, charged 0
  await seed(IDS.canceled, ACCT_A, 0, 125, true)       // the motivating case: canceled comp, GA said $125
  await seed(IDS.other, ACCT_B, 500, 500, false)       // another account — must not leak in
  await seed(IDS.sameMinuteA, ACCT_A, 300, 300, false) // two bookings, same minute...
  // STAFF origin: it never had a website session, so its absence from GA is expected and must not
  // block exactness. That distinction is the point of web_origin_state.
  await seed(IDS.sameMinuteB, ACCT_A, 250, 250, false, 'staff')
}, 60000)

afterAll(async () => {
  if (c) {
    await purgePaidMeasurement(c, [ACCT_A, ACCT_B])
    await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
    await removeAccountOutcomes(c, [ACCT_A, ACCT_B])
    await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT_A, ACCT_B]])
    await c.end()
  }
})

describe('GA/ledger join through the real PostgREST read', () => {
  it('business totals are LEDGER facts and survive GA being entirely unavailable', async () => {
    const { reconciliation: r, lines } = await buildGa4ReconciliationBlock(ACCT_A, SINCE, UNTIL)

    // paid 220 + sameMinuteA 300 + sameMinuteB 250. The comp and the canceled comp are excluded on
    // LEDGER state; neither contributes the $125 GA reported for them.
    expect(r.business!.valueBearingBookings).toBe(3)
    expect(r.business!.bookedValue).toBe(770)
    expect(r.business!.confirmedAppointments).toBe(4)   // the active comp is a REAL appointment
    expect(r.business!.canceledAppointments).toBe(1)
    expect(r.business!.zeroValueAppointments).toBe(1)

    // GA unavailable is reported as pending/unavailable — never as zero bookings.
    expect(r.scope).toBe('pending_configuration')
    expect(r.business!.valueBearingBookings).toBeGreaterThan(0)
    expect(lines.join('\n')).toMatch(/Web attribution: UNAVAILABLE/)
    expect(r.warnings.join(' ')).toMatch(/NOT evidence of zero bookings/)
  }, 60000)

  it('two bookings created in the SAME minute stay two distinct bookings', async () => {
    // The old GA path bucketed by dateHourMinute; these two share one bucket exactly.
    const { reconciliation: r } = await buildGa4ReconciliationBlock(ACCT_A, SINCE, UNTIL)
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM v_business_outcomes
        WHERE ad_account_id=$1 AND occurred_at=$2 AND business_state='active_value_bearing'`, [ACCT_A, CREATED])
    expect(Number(rows[0].n)).toBe(3)   // paid + both same-minute rows share this timestamp
    expect(r.business!.valueBearingBookings).toBe(3)
  }, 60000)

  it('is account-scoped — another account\'s booking never enters these totals', async () => {
    const { reconciliation: b } = await buildGa4ReconciliationBlock(ACCT_B, SINCE, UNTIL)
    expect(b.business!.valueBearingBookings).toBe(1)
    expect(b.business!.bookedValue).toBe(500)
  }, 60000)

  // The test above proves the DB read with GA UNAVAILABLE. This one closes the missing seam —
  // REAL rows out of PostgREST joined against real-shaped GA events, so exact attribution, duplicate
  // diagnostics and channel ambiguity are exercised end to end rather than on hand-built ledger rows.
  it('joins REAL PostgREST rows to GA events: exact allocation, duplicates, and ambiguity', async () => {
    const db = getAdminClient()
    const { data, error } = await db
      .from('v_business_outcomes')
      .select('id, external_id, gross_value, collected_value, status, business_state, web_origin_state')
      .eq('ad_account_id', ACCT_A)
      .gte('business_date', SINCE).lte('business_date', UNTIL)
    expect(error).toBeNull()
    // The app's read boundary maps outcome rows back to the appointment vocabulary (id = Acuity id).
    const ledger: LedgerAppointmentLite[] = ((data ?? []) as BusinessOutcomeLedgerRow[]).map(ledgerRowFromBusinessOutcome)
    expect(ledger.length).toBe(5)

    const ev = (o: Partial<Ga4IdentifiedBookingEvent> & { appointmentId: number | null }): Ga4IdentifiedBookingEvent =>
      ({ channel: 'Paid Social', campaign: 'summer_studio', eventDate: '2026-05-10', value: 0, eventCount: 1, ...o })

    const r = reconcileGa4Bookings(ledger, {
      available: true,
      events: [
        ev({ appointmentId: IDS.paid, eventCount: 2 }),                       // duplicate emission
        ev({ appointmentId: IDS.sameMinuteA }),                               // clean exact join
        ev({ appointmentId: IDS.sameMinuteB, channel: 'Organic Search' }),    // ...
        ev({ appointmentId: IDS.sameMinuteB, channel: 'Paid Social' }),       // ...conflicting channel
        ev({ appointmentId: IDS.canceled, value: 125 }),                      // joins a CANCELED comp
        ev({ appointmentId: 123456789 }),                                     // no ledger row
        ev({ appointmentId: null, eventCount: 3 }),                           // legacy, unlinked
      ],
    }, { windowStart: SINCE, provenBoundary: '2026-04-01' })

    // Business facts are unchanged by any of that.
    expect(r.business!.valueBearingBookings).toBe(3)
    expect(r.business!.bookedValue).toBe(770)

    // This fixture deliberately contains a legacy (unidentified) event, so coverage is PARTIAL and no
    // money may be derived — but the diagnostics still work and are still reported.
    expect(r.scope).toBe('mixed_partial_coverage')
    expect(r.coverage.identifiedEvents).toBeLessThan(r.coverage.totalEvents)
    expect(r.byChannel).toEqual([])   // partial coverage is never allocated
    // sameMinuteB emitted TWO events (one per channel row), so it is BOTH duplicated and ambiguous.
    // GA aggregates by dimension, so two rows on different channels are two distinct emissions.
    expect(r.duplicateAppointments).toEqual([
      { appointmentId: IDS.paid, eventCount: 2 },
      { appointmentId: IDS.sameMinuteB, eventCount: 2 },
    ])
    expect(r.ambiguousAttribution.map((a) => a.appointmentId)).toEqual([IDS.sameMinuteB])
    expect(r.unmatchedGaEvents).toEqual([123456789])
    expect(r.legacyUnlinkedEvents).toBe(3)
    expect(r.exactJoinedCanceled).toBe(1)

    const text = renderGa4ReconciliationBlock(r).join('\n')
    expect(text).toMatch(/CONFLICTING channels/)
    expect(text).toMatch(/more than one GA confirmation event/)
    expect(text).toMatch(/Web attribution: UNAVAILABLE \(mixed_partial_coverage\)/)
  }, 60000)

  it('with FULL coverage over a proven window, allocation uses LEDGER value', async () => {
    const db = getAdminClient()
    const { data } = await db
      .from('v_business_outcomes')
      .select('id, external_id, gross_value, collected_value, status, business_state, web_origin_state')
      .eq('ad_account_id', ACCT_A)
      .gte('business_date', SINCE).lte('business_date', UNTIL)
    const ledger: LedgerAppointmentLite[] = ((data ?? []) as BusinessOutcomeLedgerRow[]).map(ledgerRowFromBusinessOutcome)

    const ev = (o: Partial<Ga4IdentifiedBookingEvent> & { appointmentId: number | null }): Ga4IdentifiedBookingEvent =>
      ({ channel: 'Paid Social', campaign: 'summer_studio', eventDate: '2026-05-10', value: 0, eventCount: 1, ...o })

    const r = reconcileGa4Bookings(ledger, {
      available: true,
      events: [
        ev({ appointmentId: IDS.paid, eventCount: 2 }),   // duplicate emission, still ONE booking
        ev({ appointmentId: IDS.sameMinuteA }),
        ev({ appointmentId: IDS.canceled, value: 125 }),  // joins a CANCELED comp at its nominal price
      ],
    }, { windowStart: SINCE, provenBoundary: '2026-04-01' })

    if (r.scope !== 'exact_appointment_join') {
      throw new Error(`expected exact, got ${r.scope}: ${r.scopeReason}`)
    }
    const paidChannel = r.byChannel.find((c) => c.channel === 'Paid Social')!
    expect(paidChannel.valueBearingBookings).toBe(2)     // IDS.paid + IDS.sameMinuteA, duplicate once
    expect(paidChannel.bookedValue).toBe(520)            // 220 + 300 LEDGER — never the canceled $125
    expect(r.exactJoinedCanceled).toBe(1)                // the join happened; it is not a booking
    expect(renderGa4ReconciliationBlock(r).join('\n')).toMatch(/collected at checkout after discounts/)
  }, 60000)

  it('the view and the app classifier agree row-for-row', async () => {
    // Two implementations of one rule drift. This pins them together against the real table.
    const { rows } = await c.query<{ id: string; st: string }>(
      `SELECT external_id AS id, business_state AS st FROM v_business_outcomes
        WHERE ad_account_id=$1 ORDER BY external_id::bigint`, [ACCT_A])
    const { reconciliation: r } = await buildGa4ReconciliationBlock(ACCT_A, SINCE, UNTIL)
    expect(rows.filter((x) => x.st === 'active_value_bearing').length).toBe(r.business!.valueBearingBookings)
    expect(rows.filter((x) => x.st === 'active_zero_value').length).toBe(r.business!.zeroValueAppointments)
    expect(rows.filter((x) => x.st === 'cancelled').length).toBe(r.business!.canceledAppointments)
  }, 60000)
})
