import { describe, it, expect } from 'vitest'
import {
  reconcileAppointment, summarizeReconciliation, renderReconciliationBlock,
  type AppointmentReconciliationInput, type ObservationEvidence,
} from '@/lib/outcomes/adapters/acuity/value-reconciliation'

// The evidence gate behind "expected value-timing delta". Only a change recorded AFTER Meta accepted
// the event earns that label; everything else is unexplained or not directly reconcilable.

const T0 = Date.parse('2026-07-20T14:00:00Z')
const ACCEPTED = Date.parse('2026-07-20T14:00:30Z')
const AFTER = Date.parse('2026-07-20T18:00:00Z')
const BEFORE = Date.parse('2026-07-20T14:00:10Z')

const obs = (over: Partial<ObservationEvidence> = {}): ObservationEvidence => ({
  changeKind: 'price_change', observedAtMs: AFTER,
  oldPrice: 410, newPrice: 500, oldCanceled: null, newCanceled: null, ...over,
})

const input = (over: Partial<AppointmentReconciliationInput> = {}): AppointmentReconciliationInput => ({
  appointmentId: 1,
  initialProvenance: 'observed',
  observations: [{ changeKind: 'first_observation', observedAtMs: T0, oldPrice: null, newPrice: 410, oldCanceled: null, newCanceled: false }],
  capiAcceptedAtMs: ACCEPTED,
  capiAttempted: true,
  modeledDiffers: false,
  ...over,
})

describe('reconcileAppointment — proven post-send change', () => {
  it('a price change AFTER acceptance is the one case that proves a timing delta', () => {
    const r = reconcileAppointment(input({ observations: [obs()] }))
    expect(r.state).toBe('proven_post_send_change')
    expect(r.provenDelta).toBe(90)
    expect(r.reason).toMatch(/after Meta accepted/)
  })

  it('sums multiple post-send price moves, including downward ones', () => {
    const r = reconcileAppointment(input({
      observations: [obs({ oldPrice: 410, newPrice: 500 }), obs({ oldPrice: 500, newPrice: 450, observedAtMs: AFTER + 1000 })],
    }))
    expect(r.provenDelta).toBe(40)
  })

  it('a post-send CANCELLATION is proven too (the other direction)', () => {
    const r = reconcileAppointment(input({
      observations: [obs({ changeKind: 'status_change', oldCanceled: false, newCanceled: true, oldPrice: null, newPrice: null })],
    }))
    expect(r.state).toBe('proven_post_send_change')
    expect(r.reason).toMatch(/cancellation/)
    expect(r.provenDelta).toBeNull()
  })

  it('a change BEFORE acceptance does NOT prove a post-send delta', () => {
    const r = reconcileAppointment(input({ observations: [obs({ observedAtMs: BEFORE })] }))
    expect(r.state).not.toBe('proven_post_send_change')
    expect(r.state).toBe('no_observed_change')
  })

  it('a change exactly AT the acceptance instant is not counted as after it', () => {
    const r = reconcileAppointment(input({ observations: [obs({ observedAtMs: ACCEPTED })] }))
    expect(r.state).toBe('no_observed_change')
  })
})

describe('reconcileAppointment — states that must NOT be called expected', () => {
  it('no accepted delivery => capi_delivery_missing, checked BEFORE any value reasoning', () => {
    // Even with a textbook post-send upsell present, an undelivered event explains the difference on
    // its own and must never be dressed up as a timing delta.
    const r = reconcileAppointment(input({ capiAcceptedAtMs: null, observations: [obs()] }))
    expect(r.state).toBe('capi_delivery_missing')
    expect(r.provenDelta).toBeNull()
  })

  it('distinguishes an attempted-but-rejected send from one never attempted', () => {
    expect(reconcileAppointment(input({ capiAcceptedAtMs: null, capiAttempted: true })).reason)
      .toMatch(/attempted but never accepted/)
    expect(reconcileAppointment(input({ capiAcceptedAtMs: null, capiAttempted: false })).reason)
      .toMatch(/no server CAPI delivery was recorded/)
  })

  it('a migration_snapshot row is UNKNOWN, never proven — a backfilled value is not booking-time value', () => {
    const r = reconcileAppointment(input({ initialProvenance: 'migration_snapshot', observations: [obs()] }))
    expect(r.state).toBe('unknown_no_lineage')
    expect(r.provenDelta).toBeNull()
    expect(r.reason).toMatch(/cannot be proven or ruled out/)
  })

  it('a null provenance is UNKNOWN too (fails closed)', () => {
    expect(reconcileAppointment(input({ initialProvenance: null })).state).toBe('unknown_no_lineage')
  })

  it('no observations at all => unknown_no_lineage', () => {
    expect(reconcileAppointment(input({ observations: [] })).state).toBe('unknown_no_lineage')
  })

  it('delivered + unchanged + planes still differ => modeled_attribution_disagreement', () => {
    const r = reconcileAppointment(input({ modeledDiffers: true }))
    expect(r.state).toBe('modeled_attribution_disagreement')
    expect(r.reason).toMatch(/not a value-timing effect/)
  })

  it('delivered + unchanged + planes agree => no_observed_change', () => {
    expect(reconcileAppointment(input()).state).toBe('no_observed_change')
  })

  it('a first_observation alone never counts as a material change', () => {
    const r = reconcileAppointment(input({
      observations: [{ changeKind: 'first_observation', observedAtMs: AFTER, oldPrice: null, newPrice: 410, oldCanceled: null, newCanceled: false }],
    }))
    expect(r.state).toBe('no_observed_change')
  })
})

describe('summarizeReconciliation', () => {
  const rows = [
    reconcileAppointment(input({ appointmentId: 1, observations: [obs()] })),                              // proven +90
    reconcileAppointment(input({ appointmentId: 2 })),                                                     // no change
    reconcileAppointment(input({ appointmentId: 3, initialProvenance: 'migration_snapshot' })),            // unknown
    reconcileAppointment(input({ appointmentId: 4, capiAcceptedAtMs: null })),                             // delivery missing
    reconcileAppointment(input({ appointmentId: 5, modeledDiffers: true })),                               // modelled
  ]

  it('counts every state and sums ONLY the proven delta', () => {
    const s = summarizeReconciliation(rows)
    expect(s.total).toBe(5)
    expect(s.byState).toEqual({
      proven_post_send_change: 1,
      no_observed_change: 1,
      unknown_no_lineage: 1,
      capi_delivery_missing: 1,
      modeled_attribution_disagreement: 1,
    })
    expect(s.provenTimingDelta).toBe(90)
    expect(s.unexplainedCount).toBe(4) // everything that is not proven
    expect(s.noProvenEvidence).toBe(false)
  })

  it('flags noProvenEvidence when nothing is proven', () => {
    const s = summarizeReconciliation(rows.filter((r) => r.state !== 'proven_post_send_change'))
    expect(s.noProvenEvidence).toBe(true)
    expect(s.provenTimingDelta).toBe(0)
    expect(s.unexplainedCount).toBe(4)
  })
})

describe('renderReconciliationBlock — the prose the report is allowed to use', () => {
  it('restricts "expected value-timing delta" to the proven subset', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([
      reconcileAppointment(input({ appointmentId: 1, observations: [obs()] })),
      reconcileAppointment(input({ appointmentId: 2 })),
    ])).join('\n')
    expect(text).toMatch(/ONLY this subset, is an expected value-timing delta/)
    expect(text).toMatch(/UNEXPLAINED by value timing/)
  })

  it('with ZERO proven changes it forbids the expected-timing explanation outright', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([
      reconcileAppointment(input({ appointmentId: 1 })),
      reconcileAppointment(input({ appointmentId: 2, capiAcceptedAtMs: null })),
    ])).join('\n')
    expect(text).toMatch(/nothing is proven, so NO part of the difference may be called an expected timing delta/)
    expect(text).toMatch(/state the difference as UNEXPLAINED/)
    expect(text).not.toMatch(/ONLY this subset, is an expected value-timing delta/)
  })

  it('labels snapshot rows unknown-not-benign and delivery gaps as delivery, not timing', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([
      reconcileAppointment(input({ appointmentId: 1, initialProvenance: 'migration_snapshot' })),
      reconcileAppointment(input({ appointmentId: 2, capiAcceptedAtMs: null })),
    ])).join('\n')
    expect(text).toMatch(/NOT directly reconcilable; unknown, not benign/)
    expect(text).toMatch(/a DELIVERY gap, not a timing effect/)
  })

  it('uses neutral wording — modelled attribution can under- OR over-attribute', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([reconcileAppointment(input())])).join('\n')
    expect(text).toMatch(/under- OR over-attribute/)
    expect(text).not.toMatch(/under-count/i)
  })

  it('carries no customer PII — ids and scalars only', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([
      reconcileAppointment(input({ appointmentId: 1, observations: [obs()] })),
    ])).join('\n')
    expect(text).not.toMatch(/@/)              // no emails
    expect(text).not.toMatch(/\bname\b/i)      // no name fields
  })

  it('handles an empty range without asserting anything', () => {
    const text = renderReconciliationBlock(summarizeReconciliation([])).join('\n')
    expect(text).toMatch(/No bookings in range/)
    expect(text).not.toMatch(/expected/i)
  })
})
