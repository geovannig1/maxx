import { describe, it, expect } from 'vitest'
import { normalizeEventName } from '@/lib/platforms/meta/fetch-dataset-stats'

// The same custom event can arrive as 'Quote Request_Click' AND 'Quote%20Request_Click' —
// URL-encoding fragments one event's volume across two rows, understating it.
describe('normalizeEventName', () => {
  it('collapses URL-encoded variants to one canonical name', () => {
    expect(normalizeEventName('Quote%20Request_Click')).toBe('Quote Request_Click')
    expect(normalizeEventName('Quote Request_Click')).toBe('Quote Request_Click')
  })
  it('keeps malformed %-sequences as-is (no throw)', () => {
    expect(normalizeEventName('bad%zzname')).toBe('bad%zzname')
  })
  it('trims whitespace', () => {
    expect(normalizeEventName(' AppointmentConfirmed ')).toBe('AppointmentConfirmed')
  })
})
