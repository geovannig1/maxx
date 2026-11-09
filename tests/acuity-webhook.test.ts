import { describe, it, expect } from 'vitest'
import { createHmac } from 'crypto'
import { computeAcuitySignature, verifyAcuitySignature, parseWebhookBody, isAppointmentAction } from '@/lib/outcomes/adapters/acuity/webhook'

// Acuity signs each webhook HMAC-SHA256(base64) over the RAW body under the API key, in the
// x-acuity-signature header. These guard the one place an attacker could forge a booking event.

const API_KEY = ['abc123', 'SECRETkey'].join('')
const BODY = 'action=appointment.scheduled&id=777000101&calendarID=7770001&appointmentTypeID=99900011'
const validSig = createHmac('sha256', API_KEY).update(BODY, 'utf8').digest('base64')

describe('computeAcuitySignature', () => {
  it('is base64 HMAC-SHA256 of the raw body keyed by the API key (matches Acuity)', () => {
    expect(computeAcuitySignature(BODY, API_KEY)).toBe(validSig)
  })
})

describe('verifyAcuitySignature', () => {
  it('accepts the correct signature', () => {
    expect(verifyAcuitySignature(BODY, validSig, API_KEY)).toBe(true)
  })
  it('rejects a tampered body (replay/forgery)', () => {
    expect(verifyAcuitySignature(BODY + '&spoof=1', validSig, API_KEY)).toBe(false)
  })
  it('rejects a wrong key, a wrong signature, and a missing signature', () => {
    expect(verifyAcuitySignature(BODY, validSig, 'wrong-key')).toBe(false)
    expect(verifyAcuitySignature(BODY, 'bm90LXZhbGlk', API_KEY)).toBe(false) // "not-valid" b64, len-mismatch safe
    expect(verifyAcuitySignature(BODY, null, API_KEY)).toBe(false)
    expect(verifyAcuitySignature(BODY, '', API_KEY)).toBe(false)
  })
})

describe('parseWebhookBody', () => {
  it('parses the form-encoded webhook payload', () => {
    expect(parseWebhookBody(BODY)).toEqual({
      action: 'appointment.scheduled', id: '777000101', calendarID: '7770001', appointmentTypeID: '99900011',
    })
  })
  it('tolerates a missing id/action', () => {
    expect(parseWebhookBody('')).toEqual({ action: '', id: '', calendarID: undefined, appointmentTypeID: undefined })
  })
})

describe('isAppointmentAction', () => {
  it('matches lifecycle actions in bare and dotted forms', () => {
    for (const a of ['scheduled', 'rescheduled', 'canceled', 'changed', 'appointment.scheduled', 'appointment.canceled']) {
      expect(isAppointmentAction(a)).toBe(true)
    }
  })
  it('skips order.completed and unknown/empty actions', () => {
    expect(isAppointmentAction('order.completed')).toBe(false)
    expect(isAppointmentAction('')).toBe(false)
    expect(isAppointmentAction('subscription.renewed')).toBe(false)
  })
})
