import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { buildAcuityCapiEvent, resolveSendMode } from '@/lib/capi/acuity-capi'
import type { AcuityAppointmentRaw } from '@/lib/outcomes/adapters/acuity/client'

// Server-side CAPI (owner-approved plan + corrections R1-R4). These tests pin the load-bearing rules:
// deterministic acuity-<id>, TRUE event_time (skip expired, never shift), origin gate on scheduledBy,
// fbp/fbc identifiers, fail-closed test gating.

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = new Date('2026-06-10T20:00:00Z').getTime()

// The fixture phone is a US national number; since the v1 release the default calling code is configuration.
const savedCallingCode = process.env.CONVERSIONS_PHONE_COUNTRY_CODE
beforeAll(() => { process.env.CONVERSIONS_PHONE_COUNTRY_CODE = '1' })
afterAll(() => {
  if (savedCallingCode === undefined) delete process.env.CONVERSIONS_PHONE_COUNTRY_CODE
  else process.env.CONVERSIONS_PHONE_COUNTRY_CODE = savedCallingCode
})

const clientBooking: AcuityAppointmentRaw = {
  id: 777000102,
  firstName: 'Taylor', lastName: 'Example', email: 'Customer.Fixture@Example.com', phone: '(555) 555-5835',
  datetimeCreated: '2026-06-10T14:12:30-0500', // ~48min before NOW
  price: '95.00',
  canceled: false,
  scheduledBy: null, // client-booked = website
  forms: [],
}

describe('resolveSendMode (R2/fail-closed)', () => {
  it("'true' → live; 'test'+code → test; 'test' without code → OFF (never silently live); else off", () => {
    expect(resolveSendMode({ ACUITY_CAPI_SEND: 'true' })).toBe('live')
    expect(resolveSendMode({ ACUITY_CAPI_SEND: 'test', META_TEST_EVENT_CODE: 'TEST1' })).toBe('test')
    expect(resolveSendMode({ ACUITY_CAPI_SEND: 'test' })).toBe('off')
    expect(resolveSendMode({ ACUITY_CAPI_SEND: 'off' })).toBe('off')
    expect(resolveSendMode({})).toBe('off')
  })
})

describe('buildAcuityCapiEvent — origin gate (R4)', () => {
  it('sends client-booked (scheduledBy === null) as a website event', () => {
    const r = buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW })
    expect(r.ok).toBe(true)
    expect(r.payload!.data[0].action_source).toBe('website')
  })
  it('skips staff-created (scheduledBy = staff email) — never mislabeled as website', () => {
    const r = buildAcuityCapiEvent({ ...clientBooking, scheduledBy: 'admin@example-studio.test' }, { currency: 'USD', nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(r.skip).toBe('staff_created')
  })
  it('skips when the origin key is ABSENT (list-shaped payload) — unknown is never assumed client', () => {
    const noKey = { ...clientBooking } as AcuityAppointmentRaw
    delete (noKey as Record<string, unknown>).scheduledBy
    const r = buildAcuityCapiEvent(noKey, { currency: 'USD', nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(r.skip).toBe('origin_unknown')
  })
})

describe('buildAcuityCapiEvent — TRUE event_time (R1)', () => {
  it('uses the exact booking time, never shifted', () => {
    const r = buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW })
    expect(r.payload!.data[0].event_time).toBe(Math.floor(new Date('2026-06-10T14:12:30-0500').getTime() / 1000))
  })
  it('caps FUTURE clock skew at now', () => {
    const r = buildAcuityCapiEvent({ ...clientBooking, datetimeCreated: '2026-06-10T21:30:00Z' }, { currency: 'USD', nowMs: NOW })
    expect(r.payload!.data[0].event_time).toBe(Math.floor(NOW / 1000))
  })
  it('skips (never falsifies) bookings older than the 7-day window, and unparseable times', () => {
    const old = buildAcuityCapiEvent({ ...clientBooking, datetimeCreated: '2026-06-02T10:00:00Z' }, { currency: 'USD', nowMs: NOW })
    expect(old.ok).toBe(false)
    expect(old.skip).toBe('expired')
    const bad = buildAcuityCapiEvent({ ...clientBooking, datetimeCreated: 'garbage' }, { currency: 'USD', nowMs: NOW })
    expect(bad.skip).toBe('expired')
  })
})

describe('buildAcuityCapiEvent — identity + dedup key', () => {
  it('event_id is the deterministic acuity-<appointmentId>; hashes em/ph/fn/ln; never leaks raw PII', () => {
    const r = buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW })
    const e = r.payload!.data[0]
    expect(e.event_name).toBe('AppointmentConfirmed')
    expect(e.event_id).toBe('acuity-777000102')
    expect(e.user_data.em?.[0]).toBe(sha('customer.fixture@example.com'))
    expect(e.user_data.ph?.[0]).toBe(sha('15555555835'))
    expect(e.user_data.fn?.[0]).toBe(sha('taylor'))
    expect(e.user_data.ln?.[0]).toBe(sha('example'))
    const raw = JSON.stringify(r.payload)
    expect(raw).not.toContain('Customer.Fixture@Example.com')
    expect(raw).not.toContain('5835')
  })
  it('sends external_id as the email hash — a person key stable across a client\'s bookings', () => {
    const e = buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW }).payload!.data[0]
    expect(e.user_data.external_id?.[0]).toBe(sha('customer.fixture@example.com'))
    // Stability is the whole point: the same client booking twice must yield the same key, so Meta
    // sees one returning renter rather than two strangers.
    const second = buildAcuityCapiEvent({ ...clientBooking, id: 999_000_111 }, { currency: 'USD', nowMs: NOW }).payload!.data[0]
    expect(second.user_data.external_id?.[0]).toBe(e.user_data.external_id?.[0])
    expect(second.event_id).not.toBe(e.event_id)
    // Negative control: no email must mean no external_id, never an empty or placeholder key.
    const noEmail = buildAcuityCapiEvent({ ...clientBooking, email: '' }, { currency: 'USD', nowMs: NOW }).payload!.data[0]
    expect(noEmail.user_data.external_id).toBeUndefined()
  })
  it('attaches fbp when captured and derives fbc only from the linked paid interaction time', () => {
    const withAttr: AcuityAppointmentRaw = {
      ...clientBooking,
      forms: [{ id: 1, name: 'Attribution', values: [{ fieldID: 9, name: 'fbclid', value: 'IwARxyz' }] }],
    }
    const interactionAt = '2026-06-09T18:30:00.000Z'
    const r = buildAcuityCapiEvent(withAttr, {
      fbp: 'fb.1.1700000000.999', currency: 'USD', nowMs: NOW,
      paidTouch: { fbclid: 'IwARlinked', observedAt: interactionAt },
    })
    const ud = r.payload!.data[0].user_data
    expect(ud.fbp).toBe('fb.1.1700000000.999')
    expect(ud.fbc).toBe(`fb.1.${new Date(interactionAt).getTime()}.IwARlinked`)
    // The legacy appointment intake fbclid is not enough: its click time is unknown, so using the
    // appointment timestamp would manufacture _fbc. No linked touch means no fbc.
    const bare = buildAcuityCapiEvent(withAttr, { currency: 'USD', nowMs: NOW })
    expect(bare.payload!.data[0].user_data.fbp).toBeUndefined()
    expect(bare.payload!.data[0].user_data.fbc).toBeUndefined()
    expect(JSON.stringify(bare.payload)).not.toContain('client_ip_address')
  })
  it('value/currency only for price>0; $0 comps send identity-only; test code rides only when given', () => {
    expect(buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW }).payload!.data[0].custom_data).toEqual({ value: 95, currency: 'USD' })
    expect(buildAcuityCapiEvent({ ...clientBooking, price: '0.00' }, { currency: 'USD', nowMs: NOW }).payload!.data[0].custom_data).toBeUndefined()
    // an implausible price above OUTCOME_MONEY_CEILING is never sent as the event value.
    expect(buildAcuityCapiEvent({ ...clientBooking, price: '2000000000.00' }, { currency: 'USD', nowMs: NOW }).payload!.data[0].custom_data).toBeUndefined()
    expect(buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW, testEventCode: 'T9' }).payload!.test_event_code).toBe('T9')
    expect(buildAcuityCapiEvent(clientBooking, { currency: 'USD', nowMs: NOW }).payload!.test_event_code).toBeUndefined()
  })
  it("sends the outcome's own currency, never a fixed one, with the value in its major units", () => {
    const value = (currency: string, price: string) =>
      buildAcuityCapiEvent({ ...clientBooking, price }, { currency, nowMs: NOW }).payload!.data[0].custom_data
    expect(value('EUR', '95.00')).toEqual({ value: 95, currency: 'EUR' })
    expect(value('EUR', '129.99')).toEqual({ value: 129.99, currency: 'EUR' })
    // JPY has no minor unit: the value Meta receives is a whole number of yen.
    expect(value('JPY', '1500')).toEqual({ value: 1500, currency: 'JPY' })
    expect(value('JPY', '1500.40')).toEqual({ value: 1500, currency: 'JPY' })
    expect(Number.isInteger(value('JPY', '1500.40')!.value)).toBe(true)
    // Control: USD keeps its cents.
    expect(value('USD', '129.99')).toEqual({ value: 129.99, currency: 'USD' })
  })
  it('refuses without an appointment id', () => {
    const r = buildAcuityCapiEvent({ ...clientBooking, id: '' }, { currency: 'USD', nowMs: NOW })
    expect(r.skip).toBe('no_id')
  })
})
