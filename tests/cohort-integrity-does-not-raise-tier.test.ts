import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { resolvePaidCohortActionEvidence } from '@/lib/authority/paid-cohort-direction'

const modelledFixture = {
  recent: {
    windowStart: '2026-08-05', windowEnd: '2026-08-18',
    source: 'daily_insights' as const, observedDays: 14, expectedDays: 14,
    earliestSyncedAt: '2026-08-19T10:30:00.000Z', latestSyncedAt: '2026-08-19T10:30:00.000Z',
    spend: 480, modelledBookings: 8, modelledCpa: 60,
    peakDailyFrequency: 1.4, windowFrequency: 2.0,
  },
  prior: {
    windowStart: '2026-07-22', windowEnd: '2026-08-04',
    source: 'daily_insights' as const, observedDays: 14, expectedDays: 14,
    earliestSyncedAt: '2026-08-05T10:30:00.000Z', latestSyncedAt: '2026-08-05T10:30:00.000Z',
    spend: 460, modelledBookings: 7, modelledCpa: 65.71,
    peakDailyFrequency: 1.3, windowFrequency: 1.9,
  },
  sourceGeneration: {
    id: 'sync-generation-1', status: 'success', dateRangeStart: '2026-07-22',
    dateRangeEnd: '2026-08-18', startedAt: '2026-08-05T10:00:00.000Z',
    completedAt: '2026-08-19T10:30:00.000Z',
  },
  targetCpa: 60, watchCpa: 100, linkageCoverage: 0.2, blendedRoas: 2.1,
}

/** No cohorts at all — the exact shape an empty Map produces downstream. */
const directionInput = () => ({
  cohorts: null,
  objective: 'bookings' as const,
  structuralContinuity: true,
  targetCpa: 60,
  maxCpa: 100,
  targetPolicyStatus: 'governed' as const,
})

// THE INTERACTION THAT REVIEW CAUGHT, and that a passing test suite did not.
//
// Two changes that shipped together:
//   (a) the meta-modelled fallback stopped being gated on `analysis.evidence`
//   (b) the paid-cohort read started degrading to an empty Map on any error
//
// Separately defensible; together they inverted a safety direction. `modelledEvidence` is built from
// `readModelledPerformance`, which never consults the cohort rows — so with (b) swallowing a Zod
// rejection, `analysis.evidence` is null, (a) fires, and a CORRUPTED stored row promotes money actions
// from the calendar-period basis (diagnostic_only) up to the modelled plane (owner_review).
//
// A data-integrity failure must never raise the tier. Availability may degrade quietly; corruption
// must additionally suppress the estimate that the corrupt plane existed to check.
describe('a corrupt cohort plane must not upgrade money actions to the modelled plane', () => {
  const source = fs.readFileSync('src/lib/recommendations/generate.ts', 'utf8')

  // The BEHAVIOURAL half. `resolvePaidCohortActionEvidence` is what decides the plane, so this asserts
  // the actual consequence rather than the shape of the guard: with no cohorts, supplying `modelled`
  // reaches the owner_review-capable modelled plane, and withholding it does not. The suppression in
  // generate.ts is therefore load-bearing — it is the only thing standing between a corrupt stored row
  // and a tier increase.
  it('a modelled input with no cohorts DOES reach the modelled plane', () => {
    expect(resolvePaidCohortActionEvidence({
      ...directionInput(), modelled: modelledFixture, kind: 'budget_scale', fallbackPlane: 'meta_modelled',
    }).basis).toBe('meta_modelled_association')
  })

  it('withholding the modelled input keeps it on the calendar-period basis', () => {
    expect(resolvePaidCohortActionEvidence({
      ...directionInput(), modelled: null, kind: 'budget_scale', fallbackPlane: 'meta_modelled',
    }).basis).toBe('calendar_period_signal')
  })

  // The WIRING half. The behavioural tests above prove the two outcomes exist; these prove generate.ts
  // selects between them on integrity rather than on any failure. They read source text because the
  // decision lives inside a catch block around a network read, and mocking that would test the mock.
  it('distinguishes an integrity failure from an availability failure', () => {
    const isIntegrity = source.match(
      /const integrity = err instanceof PaidCohortStoreError\s*\n\s*&&\s*\(err\.code === '([A-Z_]+)'\s*\|\|\s*err\.code === '([A-Z_]+)'\)/,
    )
    expect(isIntegrity, 'integrity/availability split not found in the cohort read').not.toBeNull()
    expect([isIntegrity![1], isIntegrity![2]].sort())
      .toEqual(['SOURCE_DATA_INVALID', 'SOURCE_PAGE_LIMIT_EXCEEDED'])
  })

  it('suppresses the modelled fallback when the cohort plane is corrupt', () => {
    // The guard must sit on the construction of modelledEvidence itself: suppressing it anywhere
    // later would still let the resolver see a modelled object and pick the meta_modelled plane.
    expect(source).toMatch(/const modelledEvidence = mediaBuyerRecommendationsEnabled && !cohortEvidenceCorrupt/)
  })

  it('does NOT suppress it for a plain availability failure', () => {
    // A source that simply could not be read leaves the modelled path intact — the estimate is
    // independent of it, and refusing to speak at all would be the over-correction.
    expect(source).toMatch(/cohortEvidenceCorrupt = integrity/)
    expect(source).not.toMatch(/cohortEvidenceCorrupt = true\b/)
  })
})
