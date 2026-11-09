import { describe, it, expect } from 'vitest'
import { classifyMetaObjective, unifyObjectives } from '@/lib/modes/objective'

// The pure mode function refuses to judge an awareness or lead campaign on booking CPA,
// but every production caller hardcoded `objective: 'bookings'`, so that branch could never run. The
// objective is synced onto campaigns.objective; these pin how it is read and unified.

describe('classifyMetaObjective', () => {
  it('maps Meta ODAX and legacy objectives', () => {
    expect(classifyMetaObjective('OUTCOME_SALES')).toBe('bookings')
    expect(classifyMetaObjective('CONVERSIONS')).toBe('bookings')
    expect(classifyMetaObjective('OUTCOME_LEADS')).toBe('leads')
    expect(classifyMetaObjective('LEAD_GENERATION')).toBe('leads')
    expect(classifyMetaObjective('OUTCOME_AWARENESS')).toBe('awareness')
    expect(classifyMetaObjective('OUTCOME_TRAFFIC')).toBe('awareness')
    expect(classifyMetaObjective('VIDEO_VIEWS')).toBe('awareness')
  })

  it('fails CLOSED on anything unrecognised — never assumes bookings', () => {
    // Assuming 'bookings' would apply booking-CPA cut rules to a campaign that never had that goal.
    expect(classifyMetaObjective(null)).toBe('unknown')
    expect(classifyMetaObjective('')).toBe('unknown')
    expect(classifyMetaObjective('SOME_FUTURE_OBJECTIVE')).toBe('unknown')
  })
})

describe('unifyObjectives — an account can hold several at once', () => {
  it('a single shared objective carries through', () => {
    expect(unifyObjectives(['bookings', 'bookings'])).toBe('bookings')
  })

  it('MIXED objectives resolve to unknown, which blocks booking-CPA rules', () => {
    // The reviewer's point: one account-level objective cannot safely authorise a unit action when
    // the account holds booking, lead and awareness campaigns simultaneously.
    expect(unifyObjectives(['bookings', 'awareness'])).toBe('unknown')
    expect(unifyObjectives(['bookings', 'leads'])).toBe('unknown')
  })

  it('any single unknown poisons the result', () => {
    expect(unifyObjectives(['bookings', 'unknown'])).toBe('unknown')
  })

  it('an empty set is unknown, not bookings', () => {
    expect(unifyObjectives([])).toBe('unknown')
  })
})
