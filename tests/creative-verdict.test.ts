import { describe, expect, it } from 'vitest'
import {
  getCreativeDiagnostic,
  type CreativeDiagnosticInput,
} from '@/lib/creative/verdict'

function input(overrides: Partial<CreativeDiagnosticInput> = {}): CreativeDiagnosticInput {
  return {
    ctr: 1.5,
    frequency: 1.8,
    earlyViewRate: 12,
    earlyViewSource: 'video_play_actions',
    thruplayRate: 8,
    retentionP25Rate: 42,
    retentionDenominator: 'video_starts',
    videoStartCoverage: 'complete',
    derivedMetricWarningCount: 0,
    impressions: 5_000,
    windowDays: 7,
    ...overrides,
  }
}

describe('creative diagnostics have no decision authority', () => {
  it('returns an explicit diagnostic-only contract with no prescriptions', () => {
    const diagnostic = getCreativeDiagnostic(input())

    expect(diagnostic).toMatchObject({
      authority: 'diagnostic_only',
      state: 'evidence_available',
      prescriptions: [],
    })
    expect(diagnostic).not.toHaveProperty('action')
    expect(diagnostic).not.toHaveProperty('verdict')
    expect(diagnostic).not.toHaveProperty('confidence')
  })

  it('cannot change when caller-added Meta-modelled bookings/CPA flip from winner to loser', () => {
    const common = input({ ctr: 1.8, frequency: 1.4 })
    const modelledWinner = getCreativeDiagnostic({
      ...common,
      spend: 300,
      bookings: 20,
      cpa: 15,
      cpl: 10,
    } as CreativeDiagnosticInput)
    const modelledLoser = getCreativeDiagnostic({
      ...common,
      spend: 3_000,
      bookings: 0,
      cpa: null,
      cpl: 300,
    } as CreativeDiagnosticInput)

    expect(modelledWinner).toEqual(modelledLoser)
    expect(JSON.stringify(modelledWinner)).not.toMatch(/cost \/ booking|cost \/ lead|CPA|CPL/i)
  })

  it('keeps concerning delivery observations diagnostic instead of creating an instruction', () => {
    const diagnostic = getCreativeDiagnostic(input({
      ctr: 0.2,
      frequency: 6,
      earlyViewRate: 1,
      retentionP25Rate: 4,
    }))
    const serialized = JSON.stringify(diagnostic)

    expect(diagnostic.authority).toBe('diagnostic_only')
    expect(diagnostic.prescriptions).toEqual([])
    expect(serialized).not.toMatch(/\b(kill|scale|pause|refresh|retire|push (?:more )?budget|increase budget|decrease budget)\b/i)
  })

  it('states when no delivery evidence is available rather than manufacturing a result', () => {
    const diagnostic = getCreativeDiagnostic(input({
      ctr: null,
      frequency: null,
      earlyViewRate: null,
      earlyViewSource: 'unavailable',
      thruplayRate: null,
      retentionP25Rate: null,
      videoStartCoverage: 'unavailable',
      impressions: 0,
      windowDays: 0,
    }))

    expect(diagnostic).toMatchObject({
      authority: 'diagnostic_only',
      state: 'insufficient_data',
      prescriptions: [],
    })
  })

  it('does not attribute a supplied rate to a source Meta marked unavailable', () => {
    const diagnostic = getCreativeDiagnostic(input({
      earlyViewRate: 15,
      earlyViewSource: 'unavailable',
    }))
    const signal = diagnostic.signals.find((candidate) => candidate.label === 'Early-view rate')

    expect(signal).toMatchObject({ state: 'unavailable' })
    expect(signal?.detail).not.toMatch(/from .* divided by impressions/i)
  })
})
