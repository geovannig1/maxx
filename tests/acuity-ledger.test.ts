import { describe, it, expect, vi } from 'vitest'
import {
  parseMoney, parsePaid, extractAttribution, toLedgerRow, toOutcomeRow, upsertAppointments,
} from '@/lib/outcomes/adapters/acuity/ledger'

const outcomeSource = vi.hoisted(() => ({ ensure: vi.fn() }))
vi.mock('@/lib/outcomes/adapters/acuity/outcome-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outcomes/adapters/acuity/outcome-source')>()),
  ensureAcuitySource: outcomeSource.ensure,
}))
import type { AcuityAppointmentRaw, AcuityForm } from '@/lib/outcomes/adapters/acuity/client'

// Fixtures mirror the REAL Acuity payload shape (as documented by Acuity): price vs priceSold vs
// amountPaid, a `forms` array of {id,name,values:[{fieldID,name,value}]}, and datetimeCreated carrying
// its own offset (distinct from the appointment datetime).

const tcOnlyForms: AcuityForm[] = [
  { id: 999301, name: 'Terms & Conditions', values: [{ fieldID: 99930101, name: 'I have read and agree to the terms above', value: '' }] },
]

const attributionForms: AcuityForm[] = [
  {
    id: 9999,
    name: 'Attribution',
    values: [
      { fieldID: 1, name: 'utm_source', value: 'fb' },
      { fieldID: 2, name: 'UTM Medium', value: 'paid_social' },
      { fieldID: 3, name: 'utm_campaign', value: 'summer_studio' },
      { fieldID: 4, name: 'utm_content', value: '' }, // empty → ignored
      { fieldID: 5, name: 'fbclid', value: 'IwAR123abc' },
      { fieldID: 6, name: 'Landing Page', value: 'https://example-studio.test/book/?utm_source=fb' },
    ],
  },
]

describe('parseMoney', () => {
  it('parses Acuity money strings and guards', () => {
    expect(parseMoney('95.00')).toBe(95)
    expect(parseMoney('0.00')).toBe(0)
    expect(parseMoney(220)).toBe(220)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney(null)).toBeNull()
    expect(parseMoney(undefined)).toBeNull()
    expect(parseMoney('-5')).toBeNull() // negatives dropped
    expect(parseMoney('abc')).toBeNull()
  })
})

describe('parsePaid', () => {
  it('maps the yes/no string, null when absent', () => {
    expect(parsePaid('yes')).toBe(true)
    expect(parsePaid('YES')).toBe(true)
    expect(parsePaid('no')).toBe(false)
    expect(parsePaid('')).toBeNull()
    expect(parsePaid(null)).toBeNull()
  })
})

describe('extractAttribution', () => {
  it('pulls utm/fbclid/landing from intake fields, case/spacing-insensitive; ignores empties', () => {
    const a = extractAttribution(attributionForms)
    expect(a.utm_source).toBe('fb')
    expect(a.utm_medium).toBe('paid_social')
    expect(a.utm_campaign).toBe('summer_studio')
    expect(a.utm_content).toBeNull() // empty value ignored
    expect(a.fbclid).toBe('IwAR123abc')
    expect(a.landing_page).toBe('https://example-studio.test/book/?utm_source=fb')
    expect(a.gclid).toBeNull()
    expect(a.referrer).toBeNull()
  })

  it('returns all-null for the Terms-only form and for missing forms', () => {
    expect(extractAttribution(tcOnlyForms)).toEqual({
      utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null,
      fbclid: null, gclid: null, landing_page: null, referrer: null,
    })
    expect(extractAttribution(null).utm_source).toBeNull()
    expect(extractAttribution(undefined).fbclid).toBeNull()
  })
})

describe('toLedgerRow', () => {
  const comp: AcuityAppointmentRaw = {
    id: 777000101,
    firstName: 'Taylor', lastName: 'E', email: 'Customer.Fixture@Example.com', phone: '(555) 555-5835',
    type: 'Full-Day Studio Booking', appointmentTypeID: 99900011, category: 'Weekend Booking', calendarID: 7770001,
    datetime: '2026-11-14T10:00:00-0500', datetimeCreated: '2026-06-10T23:40:12-0500', endTime: '2026-11-14T17:00:00-0500',
    price: '0.00', priceSold: '640.00', amountPaid: '0.00', paid: 'yes',
    canceled: false, forms: tcOnlyForms,
  }

  it('maps money fields distinctly (comp: price 0 but priceSold 640)', () => {
    const r = toLedgerRow(comp, 'acct-1')
    expect(r.id).toBe(777000101)
    expect(r.ad_account_id).toBe('acct-1')
    expect(r.price).toBe(0)
    expect(r.price_sold).toBe(640)
    expect(r.amount_paid).toBe(0)
    expect(r.paid).toBe(true)
    expect(r.canceled).toBe(false)
    expect(r.no_show).toBeNull() // noShow absent → null (not false)
    expect(r.appointment_type_id).toBe(99900011)
    expect(r.email).toBe('Customer.Fixture@Example.com') // stored as-is; hashing/lowercasing happens only at CAPI send
  })

  it('computes booking_date_et from the offset-aware datetimeCreated (rolls to ET day)', () => {
    // 23:40 -0500 == 04:40Z next day == 00:40 EDT → ET booking date is the 11th, not the 10th.
    expect(toLedgerRow(comp).booking_date_et).toBe('2026-06-11')
    // A winter timestamp with -0600 offset, well inside the ET day.
    expect(toLedgerRow({ ...comp, datetimeCreated: '2026-02-11T00:37:44-0600' }).booking_date_et).toBe('2026-02-11')
    // Missing creation time → null, never a guess.
    expect(toLedgerRow({ ...comp, datetimeCreated: null }).booking_date_et).toBeNull()
  })

  it('carries attribution when the intake form has it, and retains raw', () => {
    const r = toLedgerRow({ ...comp, forms: attributionForms })
    expect(r.utm_source).toBe('fb')
    expect(r.utm_campaign).toBe('summer_studio')
    expect(r.raw).toMatchObject({ id: 777000101, priceSold: '640.00' })
  })

  it('flags canceled and preserves an explicit noShow', () => {
    const r = toLedgerRow({ ...comp, canceled: true, noShow: false })
    expect(r.canceled).toBe(true)
    expect(r.no_show).toBe(false)
  })
})

// ── ORIGIN PROVENANCE (`origin_observed_at`) — the write side of the durable fact ─────────────
//
// An earlier version gated the origin write on `'scheduledBy' in appt` — the SHAPE of the payload. That
// silently delegates a durable business fact to an external API's response shape: if Acuity's LIST
// endpoint returns a scheduledBy key (even null), a sweep manufactures an origin observation it never
// made, promoting an origin-UNKNOWN booking to CAPI-eligible and stamping the SWEEP's clock as the
// observation time. The column's own comment says a list/sweep payload never writes it.
//
// The rule is about the WRITER'S ROLE, so that is where it is enforced. Only a source that fetched
// ONE appointment BY ID may establish origin. Verified by-id paths: 'webhook' (getAppointment(id)).
// 'sweep' (reconcileAcuityLedger) and 'backfill' (scripts/backfill-acuity.ts) both read the LIST
// endpoint. Unknown/new sources fail CLOSED — no origin fact, so the booking reads origin_unknown,
// which is conservative and honest rather than a guess.
describe('toLedgerRow — origin provenance is written only by a by-id observation', () => {
  // Self-contained, PII-free fixture: only the fields this contract depends on.
  const base: AcuityAppointmentRaw = {
    id: 991001, datetimeCreated: '2026-06-10T23:40:12-0500', price: '95.00', canceled: false,
  } as AcuityAppointmentRaw
  const withKey = { ...base, scheduledBy: null } as AcuityAppointmentRaw

  it('a webhook (by-id) payload carrying scheduledBy ESTABLISHES the origin', () => {
    const r = toLedgerRow(withKey, null, 'webhook')
    expect(r.scheduled_by).toBeNull()
    expect(r.origin_observed_source).toBe('webhook')
    expect(typeof r.origin_observed_at).toBe('string')
  })

  it('a SWEEP payload carrying scheduledBy must NOT manufacture an origin observation', () => {
    const r = toLedgerRow(withKey, null, 'sweep')
    expect(r.origin_observed_source).toBeUndefined()
    expect(r.origin_observed_at).toBeUndefined()
  })

  it('a BACKFILL payload must NOT either — the backfill script reads the LIST endpoint', () => {
    const r = toLedgerRow(withKey, null, 'backfill')
    expect(r.origin_observed_source).toBeUndefined()
    expect(r.origin_observed_at).toBeUndefined()
  })

  it('scheduled_by itself still rides the payload shape, so a sweep cannot clear a stored origin', () => {
    // The column is OMITTED (not null) on a list-shaped payload, so ON CONFLICT DO UPDATE leaves the
    // stored value untouched. That half of the 059 contract was already correct and must stay so.
    const listShaped = toLedgerRow(base, null, 'sweep')
    expect('scheduled_by' in listShaped).toBe(false)
    expect('origin_observed_at' in listShaped).toBe(false)
  })

  it('a by-id payload WITHOUT the key establishes nothing — presence of the key is still required', () => {
    const r = toLedgerRow(base, null, 'webhook')
    expect('scheduled_by' in r).toBe(false)
    expect(r.origin_observed_source).toBeUndefined()
  })
})

// ── GENERIC OUTCOMES WRITE (ADR-058) — the Acuity ledger row is mapped to an `outcomes` row ──────────
describe('toOutcomeRow — Acuity ledger row → outcomes row', () => {
  const SOURCE = '00000000-0000-4000-8000-000000000901'
  const appt: AcuityAppointmentRaw = {
    id: 777000101, type: 'Full-Day Studio Booking', appointmentTypeID: 99900011, category: 'Weekend',
    calendarID: 7770001, datetime: '2026-11-14T10:00:00-0500', datetimeCreated: '2026-06-10T23:40:12-0500',
    price: '95.00', priceSold: '640.00', amountPaid: '0.00', paid: 'yes', canceled: false, forms: attributionForms,
  }

  it('renames the columns, keys the row by (source, external id) and drops Acuity-only columns', () => {
    const ledger = toLedgerRow(appt, 'acct-1', 'sweep')
    const r = toOutcomeRow(ledger, SOURCE, 'USD')
    expect(r).toMatchObject({
      external_id: '777000101', ad_account_id: 'acct-1', source_id: SOURCE, outcome_type: 'booking',
      currency: 'USD', observation_source: 'sweep', outcome_label: 'Full-Day Studio Booking',
      fulfilment_at: '2026-11-14T10:00:00-0500', occurred_at: '2026-06-10T23:40:12-0500',
      business_date: '2026-06-11', gross_value: 95, collected_value: 0, status: 'confirmed',
      fulfilment_status: null, utm_source: 'fb', fbclid: 'IwAR123abc',
    })
    expect(r.raw).toMatchObject({ priceSold: '640.00', paid: 'yes', appointmentTypeID: 99900011 })
    for (const dropped of ['id', 'appointment_type_id', 'category', 'calendar_id', 'price_sold', 'paid',
      'canceled', 'no_show', 'scheduled_by', 'price', 'amount_paid', 'datetime', 'datetime_created',
      'booking_date_et', 'appointment_type']) {
      expect(dropped in r).toBe(false)
    }
  })

  it('maps canceled to status and noShow to fulfilment_status, never inventing a value', () => {
    expect(toOutcomeRow(toLedgerRow({ ...appt, canceled: true }), SOURCE, 'USD').status).toBe('cancelled')
    expect(toOutcomeRow(toLedgerRow({ ...appt, noShow: true }), SOURCE, 'USD').fulfilment_status).toBe('no_show')
    expect(toOutcomeRow(toLedgerRow({ ...appt, noShow: false }), SOURCE, 'USD').fulfilment_status).toBe('fulfilled')
    expect(toOutcomeRow(toLedgerRow({ ...appt, amountPaid: null }), SOURCE, 'USD').collected_value).toBeNull()
  })

  it('writes origin only when the payload carried scheduledBy, by the same rule as scheduled_by', () => {
    expect('origin' in toOutcomeRow(toLedgerRow(appt, 'acct-1', 'webhook'), SOURCE, 'USD')).toBe(false)
    const client = toOutcomeRow(toLedgerRow({ ...appt, scheduledBy: null }, 'acct-1', 'webhook'), SOURCE, 'USD')
    expect(client.origin).toBe('website')
    expect(client.origin_observed_source).toBe('webhook')
    expect(typeof client.origin_observed_at).toBe('string')
    expect(toOutcomeRow(toLedgerRow({ ...appt, scheduledBy: '  ' }, 'acct-1', 'webhook'), SOURCE, 'USD').origin).toBe('website')
    expect(toOutcomeRow(toLedgerRow({ ...appt, scheduledBy: 'Owner' }, 'acct-1', 'webhook'), SOURCE, 'USD').origin).toBe('staff_or_manual')
    const sweep = toOutcomeRow(toLedgerRow({ ...appt, scheduledBy: null }, 'acct-1', 'sweep'), SOURCE, 'USD')
    expect(sweep.origin).toBe('website')
    expect('origin_observed_at' in sweep).toBe(false)
    expect('origin_observed_source' in sweep).toBe(false)
  })
})

describe('upsertAppointments — outcomes write', () => {
  const SOURCE = '00000000-0000-4000-8000-000000000902'
  const appt = { id: 501, datetimeCreated: '2026-06-10T23:40:12-0500', price: '95.00', canceled: false } as AcuityAppointmentRaw

  function fakeDb() {
    const select = vi.fn(async () => ({ data: [{ id: 'x' }], error: null }))
    const upsert = vi.fn(() => ({ select }))
    const from = vi.fn(() => ({ upsert }))
    return { db: { from } as never, from, upsert }
  }

  it('upserts on (account, source, external id) under the account Acuity source and returns rows written', async () => {
    outcomeSource.ensure.mockReset().mockResolvedValue({ sourceId: SOURCE, currency: 'USD' })
    const { db, from, upsert } = fakeDb()
    const written = await upsertAppointments([toLedgerRow(appt, 'acct-1', 'sweep')], db)
    expect(written).toBe(1)
    expect(outcomeSource.ensure).toHaveBeenCalledWith(db, 'acct-1')
    expect(from).toHaveBeenCalledWith('outcomes')
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ external_id: '501', source_id: SOURCE, currency: 'USD', ad_account_id: 'acct-1' })],
      { onConflict: 'ad_account_id,source_id,external_id', ignoreDuplicates: false },
    )
  })

  it('throws, writing nothing, when a row has no ad account (outcomes.ad_account_id is NOT NULL)', async () => {
    outcomeSource.ensure.mockReset()
    const { db, from } = fakeDb()
    await expect(upsertAppointments([toLedgerRow(appt, null, 'sweep')], db)).rejects.toThrow(/no ad account/)
    expect(from).not.toHaveBeenCalled()
    expect(outcomeSource.ensure).not.toHaveBeenCalled()
  })
})
