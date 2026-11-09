import { describe, expect, it } from 'vitest'
import { parseOutcomeWebhookPayload } from '@/lib/outcomes/adapters/webhook/payload'

const VALID = {
  external_id: 'order-1001',
  outcome_type: 'sale',
  outcome_label: 'Gift card',
  status: 'confirmed',
  currency: 'EUR',
  gross_value: '120.50',
  collected_value: '0',
  occurred_at: '2026-11-08T11:58:00Z',
  fulfilment_at: '2026-11-15T09:00:00+01:00',
  fulfilment_status: 'scheduled',
  origin: 'website',
  attribution: { fbclid: 'IwAR-fixture', fbc: 'fb.1.1762600000000.IwAR-fixture', utm_source: 'facebook' },
  customer: { email: 'buyer@example.test', first_name: 'Ada' },
}

const without = (o: Record<string, unknown>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))
const parse = (body: unknown) => parseOutcomeWebhookPayload(JSON.stringify(body))
const fieldsOf = (body: unknown) => {
  const result = parse(body)
  return result.ok ? null : result.fields
}

describe('generic outcome webhook payload', () => {
  it('normalizes a complete payload (good control)', () => {
    const result = parse(VALID)
    expect(result).toEqual({
      ok: true,
      outcome: {
        externalId: 'order-1001', outcomeType: 'sale', outcomeLabel: 'Gift card', status: 'confirmed',
        currency: 'EUR', grossValue: '120.50', collectedValue: '0',
        occurredAt: '2026-11-08T11:58:00Z', fulfilmentAt: '2026-11-15T09:00:00+01:00', fulfilmentStatus: 'scheduled',
        origin: 'website',
        attribution: {
          fbclid: 'IwAR-fixture', fbc: 'fb.1.1762600000000.IwAR-fixture', fbp: null, gclid: null,
          utmSource: 'facebook', utmMedium: null, utmCampaign: null, utmContent: null, utmTerm: null,
          landingPage: null, referrer: null,
        },
        customer: { email: 'buyer@example.test', phone: null, firstName: 'Ada', lastName: null },
        // optional sender event id and ordering time, null when the payload omits them.
        conversionEventId: null, sourceUpdatedAt: null,
      },
      // the optional paid-touch token travels beside the outcome, null when absent.
      paidTouchToken: null,
    })
  })

  it('keeps an absent value as null and an observed zero as "0" (NULL is not 0)', () => {
    const absent = parse(without(VALID, 'gross_value', 'collected_value'))
    expect(absent.ok && [absent.outcome.grossValue, absent.outcome.collectedValue]).toEqual([null, null])
    const zero = parse({ ...VALID, gross_value: '0', collected_value: '0.00' })
    expect(zero.ok && [zero.outcome.grossValue, zero.outcome.collectedValue]).toEqual(['0', '0.00'])
  })

  it('accepts the minimal required fields', () => {
    const minimal = {
      external_id: 'lead-1', outcome_type: 'lead', status: 'pending', currency: 'USD',
      occurred_at: '2026-11-08T11:58:00.123Z', origin: 'unknown',
    }
    expect(parse(minimal).ok).toBe(true)
  })

  it.each([
    ['a money value sent as a JSON number (exactness cannot be guaranteed)', { gross_value: 120.5 }, 'gross_value'],
    ['a negative value', { gross_value: '-1.00' }, 'gross_value'],
    ['a value with a thousands separator', { collected_value: '1,200.00' }, 'collected_value'],
    ['an exponent', { gross_value: '1e3' }, 'gross_value'],
    ['more than six decimals', { gross_value: '1.0000001' }, 'gross_value'],
    ['a lower-case currency', { currency: 'eur' }, 'currency'],
    ['a currency that is not ISO 4217', { currency: 'ABC' }, 'currency'],
    ['an unknown outcome type', { outcome_type: 'donation' }, 'outcome_type'],
    ['an unknown status', { status: 'shipped' }, 'status'],
    ['an unknown origin', { origin: 'pos' }, 'origin'],
    ['a timestamp without an offset', { occurred_at: '2026-11-08T11:58:00' }, 'occurred_at'],
    ['a date with no time', { occurred_at: '2026-11-08' }, 'occurred_at'],
    ['an empty external id', { external_id: '' }, 'external_id'],
    ['a whitespace-padded external id', { external_id: ' order-1 ' }, 'external_id'],
    ['an external id over 256 characters', { external_id: 'x'.repeat(257) }, 'external_id'],
    ['an unknown fulfilment status', { fulfilment_status: 'done' }, 'fulfilment_status'],
    ['an unknown top-level key', { amount: '1.00' }, ''],
    ['an unknown attribution key', { attribution: { campaign_id: '1' } }, 'attribution'],
    ['an unknown customer key', { customer: { ssn: '1' } }, 'customer'],
  ])('rejects %s', (_label, change, field) => {
    const fields = fieldsOf({ ...VALID, ...change })
    expect(fields).not.toBeNull()
    expect(fields).toContain(field)
  })

  it.each(['external_id', 'outcome_type', 'status', 'currency', 'occurred_at', 'origin'])('requires %s', (key) => {
    expect(fieldsOf(without(VALID, key))).toContain(key)
  })

  it.each([
    ['not JSON', '{"external_id":'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['null', 'null'],
  ])('rejects a body that is %s', (_label, raw) => {
    expect(parseOutcomeWebhookPayload(raw).ok).toBe(false)
  })

  it('never echoes submitted values in the rejection', () => {
    const result = parse({ ...VALID, currency: 'leaked-value' })
    expect(JSON.stringify(result)).not.toContain('leaked-value')
  })
})
