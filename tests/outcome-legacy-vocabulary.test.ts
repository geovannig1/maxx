import { describe, expect, it } from 'vitest'
import { upgradeLegacyToken, upgradeLegacyVocabulary, type LegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'

// documents stored before the v1 release named the reference adapter in shared vocabulary. The read-time upgrade
// for fingerprinted documents (reporting snapshots, saved reports) must apply exactly the migration's
// token rules (tests/db/outcome-vocabulary-json-db.test.ts pins the SQL side against the same fixture).

const reference = getOutcomeAdapter('acuity')!.legacyVocabulary!

describe('legacy vocabulary upgrade', () => {
  it('maps whole tokens, prefixes, qualified codes and camelCase identifiers', () => {
    const cases: Array<[string, string]> = [
      ['acuity', 'outcomes'],
      ['acuity_business', 'outcome_business'],
      ['acuity_ledger_window_not_covered:2026-08-01..2026-08-31', 'outcome_ledger_window_not_covered:2026-08-01..2026-08-31'],
      ['acuity.booked_value', 'outcomes.booked_value'],
      ['acuity-type:10', 'outcome-type:10'],
      ['acuity-name:Studio hour', 'outcome-label:Studio hour'],
      ['acuity:acuity_reader_missing', 'outcomes:outcome_reader_missing'],
      ['acuityRecordedRevenue', 'recordedOutcomeValue'],
      ['acuityWeeks', 'outcomeWeeks'],
      ['snapshotAcuityAvailable', 'snapshotOutcomeAvailable'],
    ]
    for (const [from, to] of cases) expect(upgradeLegacyToken(from, reference), from).toBe(to)
  })

  it('leaves free text, other systems and already-neutral tokens unchanged (controls)', () => {
    for (const token of ['Acuity ledger reconciled', 'meta', 'meta_delivery', 'outcomes', 'outcome_business', 'AcuityPascal', 'acuityscheduling.com'])
      expect(upgradeLegacyToken(token, reference), token).toBe(token)
  })

  it('upgrades keys and string values recursively without mutating its input, and is idempotent', () => {
    const doc = { acuity: { acuityRecordedAmountPaid: 3, notes: ['Acuity ledger'] }, claims: [{ source: { system: 'acuity' } }], n: 1, ok: true, none: null }
    const frozen = JSON.stringify(doc)
    const upgraded = upgradeLegacyVocabulary(doc)
    expect(upgraded).toEqual({ outcomes: { observedCollectedValue: 3, notes: ['Acuity ledger'] }, claims: [{ source: { system: 'outcomes' } }], n: 1, ok: true, none: null })
    expect(JSON.stringify(doc)).toBe(frozen)
    expect(upgradeLegacyVocabulary(upgraded)).toEqual(upgraded)
  })

  it('applies no rule when no adapter declares a vocabulary (control)', () => {
    const empty: LegacyVocabulary[] = []
    expect(upgradeLegacyVocabulary({ acuity: 'acuity_business' }, empty)).toEqual({ acuity: 'acuity_business' })
  })
})
