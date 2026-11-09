import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { getConfirmationFacts } from '@/lib/outcomes/confirmation-facts'
import { getBusinessFacts } from '@/lib/outcomes/business-facts-reader'
import { etDateOf } from '@/lib/utils/date-utils'
import { purgePaidMeasurement } from './paid-measurement-purge'
import { insertOutcomeOutcome, removeAccountOutcomes } from './outcome-fixture'

/**
 * REAL PostgREST proof for the CONFIRMATION/DELIVERY contract.
 *
 * The tracking reader and the business reader must disagree, on purpose:
 *   • a canceled website booking still fired its confirmation tag, so tracking counts it
 *   • that same booking is not revenue, so business excludes it
 *
 * It also pins the premise the whole contract rests on. A review asserted that `booking_date_et` is
 * a business/service-date column; it is not. The baseline view defines it as `datetime_created` projected
 * onto the America/New_York calendar, i.e. the CONFIRMATION-CREATION date — which is exactly the axis
 * a tracking reader needs. (In the generic ledger these are outcomes.business_date and occurred_at.)
 * `outcomes.fulfilment_at` (formerly `datetime`) is the SERVICE date and is never read here.
 * Rather than trusting either the column's name or the comment, the DST test below proves the
 * equivalence against Postgres itself.
 */

const DB = process.env.SB_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const hostOf = (u: string) => { try { return new URL(u).hostname } catch { return '' } }

const ACCT = '00000000-0000-4000-8000-0000000000f1'
const OTHER = '00000000-0000-4000-8000-0000000000f2'
// PK ranges are partitioned per integration file so concurrent suites cannot collide:
//   990 acuity-lineage · 992 capi-concurrency · 993 reconciliation-scope
//   994 run-daily-sync-evidence · 995 booking-lifecycle · 996 ga4-ledger-join · 997 THIS FILE
const BASE = 997000000
const IDS = {
  createdIn: BASE + 1, createdOut: BASE + 2, canceledWebsite: BASE + 3,
  unknownOrigin: BASE + 4, staff: BASE + 5, delivered: BASE + 6, foreign: BASE + 7,
  dstEdge: BASE + 8, testAccepted: BASE + 9, liveAccepted: BASE + 10,
}

const WINDOW = { start: '2026-05-01', end: '2026-05-31' }
const EXTERNAL_IDS = Object.values(IDS).map(String)
/** Acuity id -> the outcome uuid seeded for it. */
const OUTCOME: Record<number, string> = {}

let c: pg.Client

/**
 * `createdAt` is the CONFIRMATION instant and `serviceAt` the appointment itself — deliberately
 * different, so a reader keying off the wrong one is caught.
 * business_date (formerly booking_date_et) is written exactly as production writes it: etDateOf(occurred_at).
 */
const seed = async (opts: {
  id: number; acct?: string; price?: number; canceled?: boolean
  createdAt: string; serviceAt: string
  origin?: 'website' | 'staff' | 'unknown'
  capiSentAt?: string | null
}) => {
  const { id, acct = ACCT, price = 100, canceled = false, createdAt, serviceAt,
          origin = 'website', capiSentAt = null } = opts
  // scheduled_by -> origin: a staff value is staff_or_manual; an observed client booking is website;
  // an origin never observed keeps the column default ('unknown'). price_sold is no longer a column.
  OUTCOME[id] = await insertOutcomeOutcome(c, acct, id, {
    gross_value: price, status: canceled ? 'cancelled' : 'confirmed', fulfilment_at: serviceAt,
    occurred_at: createdAt, business_date: etDateOf(createdAt), observation_source: 'webhook',
    origin_observed_at: origin === 'website' ? createdAt : null,
    origin_observed_source: origin === 'website' ? 'webhook' : null,
    ...(origin === 'website' ? { origin: 'website' } : origin === 'staff' ? { origin: 'staff_or_manual' } : {}),
    conversion_sent_at: capiSentAt,
  })
}

beforeAll(async () => {
  for (const u of [process.env.NEXT_PUBLIC_SUPABASE_URL || '', DB]) {
    if (!LOOPBACK.has(hostOf(u))) throw new Error(`refusing to run against non-loopback host: ${u}`)
  }
  c = new pg.Client({ connectionString: DB }); await c.connect()
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role`)
  await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
    SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
  // PK ranges are partitioned per file, but ACCOUNT ids are not: run-daily-sync.test.ts drives the real
  // orchestrator against this same ACCT and commits paid-cohort rows that ADR-056 RESTRICTs. That suite
  // now purges its own, and this clears any residue from a crashed run so ordering cannot matter here.
  await purgePaidMeasurement(c, [ACCT, OTHER])
  await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
  await removeAccountOutcomes(c, [ACCT, OTHER])
  await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT, OTHER]])
  await c.query(`INSERT INTO ad_accounts (id, account_id) VALUES ($1,'act_f1'),($2,'act_f2')`, [ACCT, OTHER])
  await c.query(
    `INSERT INTO app_settings (ad_account_id, key, value, setting_type)
     VALUES ($1, 'acuity_ledger_health', $2, 'json')`,
    [ACCT, JSON.stringify({
      last_reconciled_at: new Date().toISOString(),
      window_basis: 'booking_date_et',
      window_start_date: '2026-01-01',
      window_end_date: '2026-12-31',
      truncated: false,
    })],
  )

  // 1. CREATED inside the window, SERVICE far outside it => must be INCLUDED.
  await seed({ id: IDS.createdIn, createdAt: '2026-05-10T15:00:00Z', serviceAt: '2026-09-20T15:00:00Z' })
  // 2. SERVICE inside the window, CREATED before it => must be EXCLUDED.
  await seed({ id: IDS.createdOut, createdAt: '2026-03-02T15:00:00Z', serviceAt: '2026-05-12T15:00:00Z' })
  // 3. Website confirmation LATER CANCELED: the tag fired; the revenue did not survive.
  await seed({ id: IDS.canceledWebsite, createdAt: '2026-05-11T15:00:00Z', serviceAt: '2026-05-30T15:00:00Z',
               canceled: true, price: 250 })
  // 4. Origin never established.
  await seed({ id: IDS.unknownOrigin, createdAt: '2026-05-12T15:00:00Z', serviceAt: '2026-05-29T15:00:00Z',
               origin: 'unknown' })
  // 5. Staff-created: no browser session, so no browser/CAPI coverage is expected of it.
  await seed({ id: IDS.staff, createdAt: '2026-05-13T15:00:00Z', serviceAt: '2026-05-28T15:00:00Z',
               origin: 'staff' })
  // 6. LEGACY parent stamp, NO lineage row. This is what production can hold from the legacy
  //    HTTP-2xx path. Applying the schema does not retroactively upgrade it, so it must NOT count as
  //    accepted. The earlier version of this test inserted exactly this shape and asserted it DID
  //    count — enshrining the defect it was meant to guard.
  await seed({ id: IDS.delivered, createdAt: '2026-05-14T15:00:00Z', serviceAt: '2026-05-27T15:00:00Z',
               capiSentAt: '2026-05-14T15:00:09Z' })
  // 8. TEST acceptance only: a lineage row whose acceptance was in test mode. Never accepted-live.
  await seed({ id: IDS.testAccepted, createdAt: '2026-05-16T15:00:00Z', serviceAt: '2026-05-25T15:00:00Z',
               capiSentAt: null })
  await c.query(
    `INSERT INTO conversion_deliveries
       (outcome_id, event_id, event_time, value_sent, currency_sent, send_mode, events_received,
        test_accepted_at, test_accepted_count)
     VALUES ($1,$3,$2,100,'USD','test',1,$2,1)`,
    [OUTCOME[IDS.testAccepted], '2026-05-16T15:00:09Z', `acuity-${IDS.testAccepted}`])
  // 9. LIVE acceptance: the only shape that counts.
  await seed({ id: IDS.liveAccepted, createdAt: '2026-05-17T15:00:00Z', serviceAt: '2026-05-24T15:00:00Z',
               capiSentAt: '2026-05-17T15:00:09Z' })
  await c.query(
    `INSERT INTO conversion_deliveries
       (outcome_id, event_id, event_time, value_sent, currency_sent, send_mode, events_received,
        accepted_at, live_accepted_at)
     VALUES ($1,$3,$2,100,'USD','live',1,$2,$2)`,
    [OUTCOME[IDS.liveAccepted], '2026-05-17T15:00:09Z', `acuity-${IDS.liveAccepted}`])
  // 7. Another account entirely — must never leak in.
  await seed({ id: IDS.foreign, acct: OTHER, createdAt: '2026-05-15T15:00:00Z', serviceAt: '2026-05-26T15:00:00Z' })
}, 60000)

afterAll(async () => {
  if (c) {
    await c.query(`DELETE FROM conversion_deliveries WHERE outcome_id IN (
      SELECT id FROM outcomes WHERE external_id = ANY($1::text[]))`, [EXTERNAL_IDS])
    await purgePaidMeasurement(c, [ACCT, OTHER])
    await c.query(`DELETE FROM outcomes WHERE external_id = ANY($1::text[])`, [EXTERNAL_IDS])
    await removeAccountOutcomes(c, [ACCT, OTHER])
    await c.query(`DELETE FROM ad_accounts WHERE id = ANY($1::uuid[])`, [[ACCT, OTHER]])
    await c.end()
  }
})

describe('confirmation-cohort tracking reader (real PostgREST)', () => {
  it('1+2: selects on CONFIRMATION-CREATION date, not the service date', async () => {
    const f = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    expect(f).not.toBeNull()
    // createdIn, canceledWebsite, unknownOrigin, staff, delivered = 5. createdOut is excluded even
    // though its APPOINTMENT falls inside the window; foreign belongs to another account.
    expect(f!.totalConfirmations).toBe(7)

    // Prove the two rows are actually distinguishable on the service axis, so the assertion above
    // cannot pass by coincidence.
    // to_char, because node-postgres hands back `date` as a JS Date in the LOCAL zone.
    const { rows } = await c.query(
      `SELECT external_id, to_char(fulfilment_at, 'YYYY-MM-DD') AS svc, to_char(business_date, 'YYYY-MM-DD') AS booking_date_et
         FROM outcomes WHERE id = ANY($1::uuid[]) ORDER BY external_id::bigint`,
      [[OUTCOME[IDS.createdIn], OUTCOME[IDS.createdOut]]])
    expect(String(rows[0].booking_date_et)).toContain('2026-05')      // created in window
    expect(String(rows[0].svc)).toContain('2026-09')                  // serviced outside it
    expect(String(rows[1].booking_date_et)).toContain('2026-03')      // created outside window
    expect(String(rows[1].svc)).toContain('2026-05')                  // serviced inside it
  })

  it('3: a canceled website confirmation IS tracking coverage but is NOT business revenue', async () => {
    const conf = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    const { facts: biz } = await getBusinessFacts(ACCT, WINDOW.start, WINDOW.end)

    // Tracking counts it: the confirmation tag fired when the booking was created.
    expect(conf!.websiteLaterCanceled).toBe(1)
    expect(conf!.websiteConfirmations).toBe(5)          // createdIn, canceledWebsite, delivered, testAccepted, liveAccepted

    // Business excludes it, and its $250 never reaches booked value.
    expect(biz.canceledAppointments).toBe(1)
    // Every ACTIVE row is value-bearing at $100: createdIn, unknownOrigin, staff, delivered.
    // The canceled $250 is the one that does NOT reach booked value.
    expect(biz.bookedValue).toBe(600)
    // The exact defect: the business population is SMALLER, so using it for tracking under-counts
    // real telemetry and manufactures a phantom tag failure.
    expect(conf!.websiteConfirmations).toBeGreaterThan(
      biz.websiteOriginAppointments)
  })

  it('4: unknown origin is reported separately and never collapsed to "no website confirmations"', async () => {
    const f = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    expect(f!.originUnknownConfirmations).toBe(1)
    // It is in neither the website nor the staff bucket — it is its own answer.
    expect(f!.websiteConfirmations + f!.staffOrManualConfirmations + f!.originUnknownConfirmations)
      .toBe(f!.totalConfirmations)
  })

  it('5: staff/manual is excluded from expected website coverage', async () => {
    const f = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    expect(f!.staffOrManualConfirmations).toBe(1)
    expect(f!.websiteConfirmations).toBe(5)             // the staff row is not among them
  })

  // ── 047→064 LEGACY-UPGRADE PROOF ─────────────────────────────────
  it('a LEGACY parent stamp with NO lineage row is NOT accepted', async () => {
    const f = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    // IDS.delivered carries conversion_sent_at (formerly capi_sent_at) from the legacy HTTP-2xx path and no lineage row.
    expect(f!.websiteLegacyStampUnverified).toBeGreaterThanOrEqual(1)
    // ...and it is excluded from the accepted count.
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM conversion_deliveries WHERE outcome_id = $1`, [OUTCOME[IDS.delivered]])
    expect(rows[0].n).toBe(0)
  })

  it('a TEST acceptance is NOT accepted-live', async () => {
    const { rows } = await c.query(
      `SELECT live_accepted_at, test_accepted_at FROM conversion_deliveries WHERE outcome_id = $1`,
      [OUTCOME[IDS.testAccepted]])
    expect(rows[0].live_accepted_at).toBeNull()
    expect(rows[0].test_accepted_at).not.toBeNull()
  })

  it('only LIVE lineage acceptance counts, and the legacy history stays visible', async () => {
    const f = await getConfirmationFacts(ACCT, WINDOW.start, WINDOW.end)
    // Website rows: createdIn, canceledWebsite, delivered(legacy), testAccepted, liveAccepted = 5.
    expect(f!.websiteConfirmations).toBe(5)
    // Exactly ONE has live lineage acceptance.
    expect(f!.websiteWithAcceptedCapi).toBe(1)
    // The legacy stamp is still COUNTED and visible — not deleted, just not promoted to evidence.
    expect(f!.websiteLegacyStampUnverified).toBe(1)
    // So the partial-delivery detector sees a 4-event shortfall, not 2.
    expect(f!.websiteConfirmations - f!.websiteWithAcceptedCapi).toBe(4)
  })

  it('is account-scoped', async () => {
    const other = await getConfirmationFacts(OTHER, WINDOW.start, WINDOW.end)
    expect(other!.totalConfirmations).toBe(1)
  })

  it('6: the ET boundary is DST-correct, proven against Postgres', async () => {
    // 2026-03-08 is the US spring-forward date. 03:30Z on that day is 22:30 ET on 03-07 — a UTC-date
    // reader would file it under the 8th. Both the app projection and Postgres must say the 7th.
    const instant = '2026-03-08T03:30:00Z'
    await seed({ id: IDS.dstEdge, createdAt: instant, serviceAt: '2026-06-01T15:00:00Z' })

    const { rows } = await c.query(
      `SELECT to_char(($1::timestamptz AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS pg_et,
              to_char(($1::timestamptz AT TIME ZONE 'UTC')::date,             'YYYY-MM-DD') AS pg_utc`,
      [instant])
    expect(String(rows[0].pg_et)).toContain('2026-03-07')
    expect(String(rows[0].pg_utc)).toContain('2026-03-08')     // the trap a naive reader falls into
    // The app's projection agrees with Postgres' zone conversion — this is the equivalence the whole
    // contract rests on, and it is now proven rather than assumed from the column's name.
    expect(etDateOf(instant)).toBe('2026-03-07')

    // And the reader selects it into the March 7 window, not March 8.
    const on7 = await getConfirmationFacts(ACCT, '2026-03-07', '2026-03-07')
    const on8 = await getConfirmationFacts(ACCT, '2026-03-08', '2026-03-08')
    expect(on7!.totalConfirmations).toBe(1)
    expect(on8!.totalConfirmations).toBe(0)
  })
})
