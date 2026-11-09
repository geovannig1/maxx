import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const listenerSource = readFileSync(
  new URL('../docs/tracking/gtm-acuity-form-listener.js', import.meta.url),
  'utf8',
)

type DataLayerEvent = Record<string, unknown>

function createHarness() {
  const dataLayer: DataLayerEvent[] = []
  let onMessage: ((event: { origin: string; data: unknown }) => void) | undefined

  const window = {
    dataLayer,
    addEventListener(type: string, listener: typeof onMessage) {
      if (type === 'message') onMessage = listener
    },
  }

  vm.runInNewContext(listenerSource, { window })

  return {
    dataLayer,
    dispatch(origin: string, data: unknown) {
      if (!onMessage) throw new Error('message listener was not registered')
      onMessage({ origin, data })
    },
  }
}

function acuityPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: 'AcuityEvent',
    Type: 'appointment',
    ID: '777000104',
    AppointmentType: 'Headshot Session',
    Price: '$500.00',
    Email: 'must-not-enter-the-data-layer@example.com',
    ...overrides,
  })
}

describe('GTM Acuity confirmation listener', () => {
  it('accepts the conversion-frame origin observed in the live Acuity confirmation', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload())

    expect(harness.dataLayer).toHaveLength(1)
  })

  it('emits one canonical, PII-free photoshoot conversion', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload())

    expect(harness.dataLayer).toEqual([
      {
        event: 'scheduler_booking_confirmed',
        acuity_id: '777000104',
        appointment_id: '777000104',
        event_id: 'acuity-777000104',
        appointment_type_raw: 'Headshot Session',
        appointment_type_clean: 'Headshot Session',
        package_category: 'Photoshoot',
        value: 500,
        currency: 'USD',
      },
    ])
    expect(JSON.stringify(harness.dataLayer)).not.toContain('must-not-enter')
  })

  it('rejects untrusted origins, non-string messages, orders, and malformed IDs', () => {
    const harness = createHarness()

    harness.dispatch('https://evil.example', acuityPayload())
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', JSON.parse(acuityPayload()))
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ Type: 'order' }))
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: 'abc-123' }))

    expect(harness.dataLayer).toEqual([])
  })

  it.each([
    'http://conversion-tracking-sandbox.acuityinnovation.com',
    'https://conversion-tracking-sandbox.acuityinnovation.com.evil.example',
    'https://conversion-tracking-sandbox.acuityinnovation.com:443',
    'null',
  ])('rejects origin %s', (origin) => {
    const harness = createHarness()

    harness.dispatch(origin, acuityPayload())

    expect(harness.dataLayer).toEqual([])
  })

  it.each([
    { ID: '' },
    { ID: '0' },
    { ID: '-1' },
    { ID: '1.5' },
    { ID: '1e3' },
    { ID: ' 123 ' },
    { ID: '1234567890123456' },
  ])('rejects invalid appointment ID $ID', (override) => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload(override))

    expect(harness.dataLayer).toEqual([])
  })

  it('normalizes leading-zero IDs before deduplication', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: '000123' }))
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: '123' }))

    expect(harness.dataLayer).toHaveLength(1)
    expect(harness.dataLayer[0]?.appointment_id).toBe('123')
  })

  it('applies the SAME length limit to numeric and string IDs', () => {
    // A review finding. MAX_APPOINTMENT_ID_LENGTH is 15, but the numeric branch only checked
    // safe-integer/positive — so 1234567890123456 (16 digits, and a genuine safe integer) was accepted
    // as a number while the identical string was rejected. Representation must not change the verdict.
    expect(Number.isSafeInteger(1234567890123456)).toBe(true)   // the bypass was real, not theoretical

    for (const overlong of [1234567890123456, '1234567890123456']) {
      const harness = createHarness()
      harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: overlong }))
      expect(harness.dataLayer, `16-digit ${typeof overlong} must be rejected`).toEqual([])
    }

    // ...and a 15-digit ID is accepted in BOTH representations.
    for (const ok of [123456789012345, '123456789012345']) {
      const harness = createHarness()
      harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: ok }))
      expect(harness.dataLayer[0]?.appointment_id, `15-digit ${typeof ok} must be accepted`).toBe('123456789012345')
    }
  })

  it('leading zeros cannot buy extra digits past the limit', () => {
    // Stripping before the length check would let a padded 16-char string slip through as 15 digits.
    const harness = createHarness()
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: '1000000000000001' }))
    expect(harness.dataLayer).toEqual([])
  })

  it('rejects malformed JSON and invalid prices', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', '{bad json')
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ Price: '-1' }))
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ Price: '$100,001.00' }))

    expect(harness.dataLayer).toEqual([])
  })

  it.each([
    { Price: '' },
    { Price: null },
    { Price: 'free' },
    { Price: 'NaN' },
    { Price: 'Infinity' },
    { Price: '1e3' },
    { Price: '1.2.3' },
    { Price: 'abc100' },
    { Price: '$100000.01' },
  ])('rejects malformed price $Price', (override) => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload(override))

    expect(harness.dataLayer).toEqual([])
  })

  it.each([
    [299, 299],
    ['299.00', 299],
    ['$1,299.50', 1299.5],
    ['$100000.00', 100000],
  ])('normalizes valid price %s to %s', (price, expected) => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ Price: price }))

    expect(harness.dataLayer[0]?.value).toBe(expected)
  })

  it('emits at most once for the same appointment ID', () => {
    const harness = createHarness()
    const payload = acuityPayload()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', payload)
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', payload)

    expect(harness.dataLayer).toHaveLength(1)
  })

  it('keeps the first valid payload when a duplicate ID conflicts', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload())
    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({ AppointmentType: 'Half-Day Room Rental', Price: '$280.00' }),
    )

    expect(harness.dataLayer).toHaveLength(1)
    expect(harness.dataLayer[0]).toMatchObject({
      appointment_type_raw: 'Headshot Session',
      value: 500,
    })
  })

  it('allows a valid event after malformed and untrusted messages', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', '{bad json')
    harness.dispatch('https://evil.example', acuityPayload())
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload())

    expect(harness.dataLayer).toHaveLength(1)
  })

  it('emits once for each distinct valid appointment ID', () => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: '101' }))
    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload({ ID: '102' }))

    expect(harness.dataLayer.map((event) => event.appointment_id)).toEqual(['101', '102'])
  })

  it.each([
    { event: 'acuityevent' },
    { event: 'OtherEvent' },
    { event: '' },
    { Type: 'Appointment' },
  ])('rejects an incorrect event discriminator', (override) => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload(override))

    expect(harness.dataLayer).toEqual([])
  })

  it.each([
    ['Holiday Mini Photo Session', 'Photoshoot'],
    ['Two-Hour Room Rental', 'Rental'],
    ['Event Booking - Half Day', 'Event'],
    ['Creator Membership', 'Membership'],
    ['Unmapped Service', 'Unknown'],
  ])('classifies %s as %s', (appointmentType, category) => {
    const harness = createHarness()

    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({ AppointmentType: appointmentType }),
    )

    expect(harness.dataLayer[0]?.package_category).toBe(category)
  })

  it('gives photoshoot classification priority when category keywords collide', () => {
    const harness = createHarness()

    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({ AppointmentType: 'Mini Session in Room Rental' }),
    )

    expect(harness.dataLayer[0]?.package_category).toBe('Photoshoot')
  })

  it('normalizes whitespace and a compound add-on suffix without changing the raw type', () => {
    const harness = createHarness()

    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({ AppointmentType: '  Hourly Room Rental   + Backdrop Add-on ' }),
    )

    expect(harness.dataLayer[0]).toMatchObject({
      appointment_type_raw: 'Hourly Room Rental + Backdrop Add-on',
      appointment_type_clean: 'Hourly Room Rental',
      package_category: 'Rental',
    })
  })

  it.each([
    { AppointmentType: '' },
    { AppointmentType: '   ' },
    { AppointmentType: 'x'.repeat(301) },
  ])('rejects invalid appointment type', (override) => {
    const harness = createHarness()

    harness.dispatch('https://conversion-tracking-sandbox.acuityinnovation.com', acuityPayload(override))

    expect(harness.dataLayer).toEqual([])
  })

  it('emits only the canonical allowlisted fields even when the payload has PII', () => {
    const harness = createHarness()

    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({
        Email: 'private@example.com',
        full_name: 'Private Person',
        phone: '555-555-5555',
        nested: { email: 'also-private@example.com' },
      }),
    )

    expect(Object.keys(harness.dataLayer[0] ?? {}).sort()).toEqual([
      'acuity_id',
      'appointment_id',
      'appointment_type_clean',
      'appointment_type_raw',
      'currency',
      'event',
      'event_id',
      'package_category',
      'value',
    ])
  })

  it('accepts a zero-dollar controlled booking', () => {
    const harness = createHarness()

    harness.dispatch(
      'https://conversion-tracking-sandbox.acuityinnovation.com',
      acuityPayload({ Price: '$0.00' }),
    )

    expect(harness.dataLayer[0]?.value).toBe(0)
  })
})
