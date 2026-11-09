import { describe, expect, it } from 'vitest'
import { getOutcomeAdapter, listOutcomeAdapters } from '@/lib/outcomes/registry'
import { computeAcuitySignature } from '@/lib/outcomes/adapters/acuity/webhook'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'

const ACUITY_KEY = ['acuity', 'fixture'].join('-')

describe('outcome source adapter registry', () => {
  it('registers the Acuity example, the generic webhook and the CSV import by kind', () => {
    expect(listOutcomeAdapters().map((a) => a.kind).sort()).toEqual(['acuity', 'csv', 'webhook'])
    expect(getOutcomeAdapter('acuity')?.kind).toBe('acuity')
    expect(getOutcomeAdapter('webhook')?.kind).toBe('webhook')
    expect(getOutcomeAdapter('csv')?.kind).toBe('csv')
  })

  it('returns null for unknown kinds', () => {
    expect(getOutcomeAdapter('CSV')).toBeNull()
    expect(getOutcomeAdapter('constructor')).toBeNull()
    expect(getOutcomeAdapter('__proto__')).toBeNull()
  })

  it('declares the capabilities the conversions core relies on', () => {
    const acuity = getOutcomeAdapter('acuity')!.capabilities
    // Acuity's own integration already sends Purchase and Schedule; Maxx sends only its historical
    // AppointmentConfirmed, so the booking is never counted twice.
    expect(acuity.platformNativeEvents).toEqual(['Purchase', 'Schedule'])
    expect(acuity.conversionEventNames).toEqual({ booking: 'AppointmentConfirmed' })
    const webhook = getOutcomeAdapter('webhook')!.capabilities
    expect(webhook).toMatchObject({ push: true, pull: false, originKnown: true, platformNativeEvents: [] })
  })

  it('verifies each adapter push with its own signature scheme', () => {
    const body = '{"external_id":"x"}'
    const nowMs = Date.parse('2026-11-08T12:00:00Z')
    const t = Math.floor(nowMs / 1000)
    const webhook = getOutcomeAdapter('webhook')!
    const good = new Headers({ 'x-maxx-signature': signOutcomeWebhook('k'.repeat(64), t, body) })
    expect(webhook.verifyPush!({ rawBody: body, headers: good, url: new URL('http://x'), secret: 'k'.repeat(64), nowMs }).ok).toBe(true)
    expect(webhook.verifyPush!({ rawBody: body, headers: good, url: new URL('http://x'), secret: 'j'.repeat(64), nowMs }))
      .toEqual({ ok: false, reason: 'mismatch' })

    const acuity = getOutcomeAdapter('acuity')!
    const form = 'action=scheduled&id=1'
    const signed = new Headers({ 'x-acuity-signature': computeAcuitySignature(form, ACUITY_KEY) })
    expect(acuity.verifyPush!({ rawBody: form, headers: signed, url: new URL('http://x'), secret: ACUITY_KEY }).ok).toBe(true)
    expect(acuity.verifyPush!({ rawBody: `${form}&x=1`, headers: signed, url: new URL('http://x'), secret: ACUITY_KEY }).ok).toBe(false)
  })

  it('validates configuration without reading secrets out of the source config', () => {
    const acuity = getOutcomeAdapter('acuity')!
    expect(acuity.validateConfig({}, {})).toEqual({ ok: false, reason: 'ACUITY_USER_ID and ACUITY_API_KEY are required' })
    expect(acuity.validateConfig({ ACUITY_USER_ID: '1', ACUITY_API_KEY: 'k' }, {})).toEqual({ ok: true, value: undefined })
    const webhook = getOutcomeAdapter('webhook')!
    expect(webhook.validateConfig({}, {})).toEqual({ ok: true, value: undefined })
    expect(webhook.validateConfig({}, { platformNativeEvents: ['Purchase'] })).toEqual({ ok: true, value: undefined })
    expect(webhook.validateConfig({}, { platformNativeEvents: 'Purchase' }).ok).toBe(false)
    expect(webhook.validateConfig({}, { secret: 'x' }).ok).toBe(false)
  })

  it('parses a webhook push into one normalized outcome', () => {
    const parsed = getOutcomeAdapter('webhook')!.parsePush!(JSON.stringify({
      external_id: 'lead-1', outcome_type: 'lead', status: 'pending', currency: 'USD',
      occurred_at: '2026-11-08T11:58:00Z', origin: 'website',
    }))
    expect(parsed.ok && parsed.value.map((e) => e.outcome.externalId)).toEqual(['lead-1'])
    expect(getOutcomeAdapter('webhook')!.parsePush!('[]').ok).toBe(false)
  })
})
