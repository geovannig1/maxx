import { describe, it, expect } from 'vitest'
import {
  resolveAudience, readNameHint, readExpansion, gateBudgetMove, TARGETING_STALE_HOURS,
  type TargetingEvidence, type AudienceRef,
} from '@/lib/audience/resolver'
import {
  conversionActionability, deliveryFactActionability, resolveOptimizationEventEvidence,
  type ConversionEvidence, type SignalReading,
} from '@/lib/trust/conversion-actionability'
import { computeForwardCoverage, renderForwardCoverage, type CoverageBooking } from '@/lib/tracking/forward-coverage'

const NOW = Date.parse('2026-07-26T12:00:00Z')
const FRESH = '2026-07-26T11:00:00Z'
const ACCOUNT = 'act_self'

const ev = (over: Partial<TargetingEvidence> = {}): TargetingEvidence => ({
  adsetName: 'Warm Engagers | Retargeting',
  targeting: { geo_locations: { cities: [{ name: 'Springfield', radius: 20 }] }, age_min: 25, age_max: 55 },
  targetingSyncedAt: FRESH,
  accountId: ACCOUNT,
  ...over,
})

const aud = (id: string, subtype: string | null, accountId: string | null = ACCOUNT): AudienceRef =>
  ({
    id,
    name: `audience-${id}`,
    subtype,
    accountId,
    operationStatus: { code: 200 },
    deliveryStatus: { code: 200 },
    lastSyncedAt: FRESH,
  })

describe('audience resolver — names can never override targeting', () => {
  it('a set NAMED "Warm/Retargeting" that mixes retargeting + lookalike + expansion resolves to MIXED', () => {
    // The live case this work package exists for.
    const r = resolveAudience(ev({
      targeting: {
        custom_audiences: [{ id: 'A' }, { id: 'B' }],
        targeting_automation: { advantage_audience: 1 },
        geo_locations: { cities: [{ name: 'Springfield', radius: 20 }] },
      },
      audiencesById: { A: aud('A', 'WEBSITE'), B: aud('B', 'LOOKALIKE') },
    }), NOW)

    expect(r.composition).toBe('mixed')
    expect(r.nameSuggests).toBe('warm')
    expect(r.nameConflictsWithTargeting).toBe(true)
    expect(r.evidence.join(' ')).toMatch(/DISPLAY ONLY — cannot override targeting/)
    expect(r.evidence.join(' ')).toMatch(/MIXED inventory, not pure warm/)
    expect(r.includedLookalikes).toHaveLength(1)
    expect(r.expansion).toBe('enabled')
  })

  it('retargeting + expansion alone (no lookalike) is still MIXED', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 1 } },
      audiencesById: { A: aud('A', 'WEBSITE') },
    }), NOW)
    expect(r.composition).toBe('mixed')
  })

  it('pure retargeting requires no lookalikes AND expansion explicitly disabled', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { A: aud('A', 'WEBSITE') },
    }), NOW)
    expect(r.composition).toBe('retargeting_only')
    expect(r.nameConflictsWithTargeting).toBe(false)
  })

  it('a set NAMED "Cold" whose targeting is pure retargeting reports the conflict', () => {
    const r = resolveAudience(ev({
      adsetName: 'Cold Broad | Advantage+',
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { A: aud('A', 'WEBSITE') },
    }), NOW)
    expect(r.composition).toBe('retargeting_only')
    expect(r.nameConflictsWithTargeting).toBe(true)
    expect(r.evidence.join(' ')).toMatch(/Targeting wins/)
  })

  it('no inclusion lists resolves to broad_advantage regardless of the name', () => {
    const r = resolveAudience(ev({ adsetName: 'Warm Retargeting', targeting: { geo_locations: {} } }), NOW)
    expect(r.composition).toBe('broad_advantage')
  })

  it('lookalike-only resolves to lookalike and keeps the source audience when supplied', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'L' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { L: { ...aud('L', 'LOOKALIKE'), sourceAudienceId: 'S', sourceAudienceName: 'purchasers' } },
    }), NOW)
    expect(r.composition).toBe('lookalike')
    expect(r.includedLookalikes[0].sourceAudienceName).toBe('purchasers')
  })

  it('readNameHint is display-only and never returns a composition', () => {
    expect(readNameHint('Warm Engagers | Retargeting')).toBe('warm')
    expect(readNameHint('Cold Prospecting')).toBe('cold')
    expect(readNameHint('Ad Set 1')).toBe('none')
    expect(readNameHint(null)).toBe('none')
  })
})

describe('audience resolver — freezes rather than guesses', () => {
  it('MISSING targeting freezes conclusions', () => {
    const r = resolveAudience(ev({ targeting: null }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.frozen).toBe(true)
    expect(r.confidence).toBe(0)
    expect(r.unknownReason).toMatch(/targeting configuration unavailable/)
  })

  it('STALE targeting freezes conclusions', () => {
    const stale = new Date(NOW - (TARGETING_STALE_HOURS + 1) * 3_600_000).toISOString()
    const r = resolveAudience(ev({ targetingSyncedAt: stale }), NOW)
    expect(r.frozen).toBe(true)
    expect(r.unknownReason).toMatch(/stale/)
  })

  it('an UNKNOWN targeting age is treated as stale, never as fresh', () => {
    const r = resolveAudience(ev({ targetingSyncedAt: null }), NOW)
    expect(r.frozen).toBe(true)
    expect(r.unknownReason).toMatch(/age unknown/)
  })

  it('an unknown expansion state makes a retargeting set UNKNOWN, not pure', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }] },
      audiencesById: { A: aud('A', 'WEBSITE') },
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.unknownReason).toMatch(/expansion state is unknown/)
    expect(r.confidence).toBeLessThanOrEqual(0.3)
  })

  // A cross-account inclusion used to be REMOVED from the list, which emptied the
  // inclusion count and resolved the set to 'broad_advantage' — turning a fail-closed rejection into
  // a confident (and wrong) classification. A referenced audience still delivers whether or not we
  // may use it as evidence, so its presence must FREEZE.
  it('a CROSS-ACCOUNT included audience FREEZES — it is never converted into "broad"', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'X' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { X: aud('X', 'WEBSITE', 'act_other') },
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.composition).not.toBe('broad_advantage')
    expect(r.frozen).toBe(true)
    expect(r.rejectedIncludedAudienceIds).toEqual(['X'])
    expect(r.includedCustomAudiences).toHaveLength(0)
    expect(r.evidence.join(' ')).toMatch(/owned by a DIFFERENT account/i)
    expect(r.unknownReason).toMatch(/owned by another account/)
  })

  // "We did not record who owns this" is not "we own this".
  it('UNKNOWN ownership FREEZES even when the subtype is resolved', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      // Subtype known, owning account NOT recorded.
      audiencesById: { A: { id: 'A', name: 'v', subtype: 'WEBSITE', accountId: null } },
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.composition).not.toBe('retargeting_only')
    expect(r.frozen).toBe(true)
    expect(r.confidence).toBe(0)
    expect(r.unresolvedIncludedAudienceIds).toEqual(['A'])
    expect(r.evidence.join(' ')).toMatch(/ownership is UNCONFIRMED/)
  })

  it('an included audience with NO metadata FREEZES — missing subtype is not "retargeting"', () => {
    // Without a custom_audiences fetcher this is the production case. It must not resolve.
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      // no audiencesById at all
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.frozen).toBe(true)
    expect(r.unresolvedIncludedAudienceIds).toEqual(['A'])
    expect(r.confidence).toBe(0)
  })

  it('a PARTIALLY resolved inclusion list still freezes — one unknown poisons the composition', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { A: aud('A', 'WEBSITE') }, // B unresolved
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.unresolvedIncludedAudienceIds).toEqual(['B'])
  })

  it('BROAD targeting with NO referenced custom audiences still resolves normally', () => {
    // The freeze must be scoped to sets that actually reference audiences.
    const r = resolveAudience(ev({
      adsetName: 'Cold Prospecting',
      targeting: { geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 1 } },
    }), NOW)
    expect(r.composition).toBe('broad_advantage')
    expect(r.frozen).toBe(false)
    expect(r.referencedIncludedAudienceCount).toBe(0)
    expect(r.evidence.join(' ')).toMatch(/references no custom audiences or lookalikes at all/)
  })

  it('an unresolved EXCLUSION freezes because segment purity depends on exclusions', () => {
    const r = resolveAudience(ev({
      targeting: {
        custom_audiences: [{ id: 'A' }],
        excluded_custom_audiences: [{ id: 'Z' }], // no metadata for Z
        targeting_automation: { advantage_audience: 0 },
      },
      audiencesById: { A: aud('A', 'WEBSITE') },
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.frozen).toBe(true)
    expect(r.unresolvedExcludedAudienceIds).toEqual(['Z'])
    expect(r.excludedAudiences.map((a) => a.id)).toEqual(['Z'])
  })

  // READINESS IS NOT IDENTITY. A lookalike Meta failed to build (operation_status 433) still has a
  // known subtype, so composition stays knowable; the failure is reported as a health finding.
  // Previously this froze, and the freeze reason claimed the audience had "no resolved subtype" —
  // which was false, and could silence an account's best ad set for weeks while investigations
  // chased a non-existent sync bug.
  it('a selected audience with a failed Meta operation status is classified and reported, not frozen', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'L' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: {
        L: { ...aud('L', 'LOOKALIKE'), operationStatus: { code: 433 } },
      },
    }), NOW)
    expect(r.composition).toBe('lookalike')
    expect(r.frozen).toBe(false)
    expect(r.unresolvedIncludedAudienceIds).toEqual([])
    expect(r.unhealthyIncludedAudienceIds).toEqual(['L'])
    expect(r.audienceHealthFindings.join(' ')).toMatch(/operation status 433/i)
    expect(r.evidence.join(' ')).toMatch(/operation status 433/i)
    expect(r.audienceReadinessFindings).toEqual([{
      audienceId: 'L', role: 'included', state: 'unhealthy', failureStatus: 'operation',
      operationStatusCode: 433, deliveryStatusCode: 200, observedAt: FRESH,
    }])
    // The uncertainty it does create is priced as confidence, not as a verdict.
    expect(r.confidence).toBeLessThan(1)
  })

  it('an ABSENT status still freezes — unknown readiness is not proven readiness', () => {
    // The distinction CI caught me collapsing. `unhealthy` means Meta TOLD us the audience is not
    // ready (an explicit non-200 such as 433). A MISSING status says only that readiness was never
    // synced. `operationCode !== 200` is true for null too, so an audience with no status at all was
    // reported to the owner as one Meta "could not build" — a statement about Meta that Meta never
    // made — and a campaign that used to freeze on unproven member context stopped freezing.
    // `evidence-gate.ts` rolls composition up, so it reached the whole campaign, not one ad set.
    const absent = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      // Built from the real helper and then stripped, so the audience is otherwise VALID — my first
      // attempt hand-rolled the object, omitted `accountId`, and was rejected as cross-account before
      // the status check was ever reached. The test then passed on the wrong branch.
      audiencesById: { A: { ...aud('A', 'WEBSITE'), operationStatus: null } },
    }), NOW)
    expect(absent.frozen).toBe(true)
    expect(absent.unhealthyIncludedAudienceIds).toEqual([])
    expect(absent.evidence.join(' ')).toMatch(/readiness was never synced/i)
    expect(absent.audienceReadinessFindings).toEqual([{
      audienceId: 'A', role: 'included', state: 'unknown', failureStatus: null,
      operationStatusCode: null, deliveryStatusCode: 200, observedAt: FRESH,
    }])
    // ...and it must NOT claim Meta failed to build it.
    expect(absent.evidence.join(' ')).not.toMatch(/Meta could not build it/i)

    // ANTI-VACUITY: an EXPLICIT failure still classifies as unhealthy and still does not freeze,
    // which is the common case (a lookalike that failed to build carries operation_status 433).
    const explicit = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { A: { ...aud('A', 'LOOKALIKE'), operationStatus: { code: 433 } } },
    }), NOW)
    expect(explicit.frozen).toBe(false)
    expect(explicit.unhealthyIncludedAudienceIds).toEqual(['A'])
    expect(explicit.evidence.join(' ')).toMatch(/Meta could not build it/i)
  })

  it('an explicit delivery failure is not hidden by an absent operation status', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: {
        A: { ...aud('A', 'LOOKALIKE'), operationStatus: null, deliveryStatus: { code: 300 } },
      },
    }), NOW)
    expect(r.frozen).toBe(false)
    expect(r.composition).toBe('lookalike')
    expect(r.unresolvedIncludedAudienceIds).toEqual([])
    expect(r.unhealthyIncludedAudienceIds).toEqual(['A'])
    expect(r.evidence.join(' ')).toMatch(/delivery status 300/i)
    expect(r.evidence.join(' ')).toMatch(/is not delivering/i)
    expect(r.audienceReadinessFindings).toEqual([{
      audienceId: 'A', role: 'included', state: 'unhealthy', failureStatus: 'delivery',
      operationStatusCode: null, deliveryStatusCode: 300, observedAt: FRESH,
    }])
  })

  it.each([
    ['absent', 'absent', true, 'unknown', 0, 1],
    ['absent', 'ready', true, 'unknown', 0, 1],
    ['absent', 'failed', false, 'lookalike', 1, 0],
    ['ready', 'absent', true, 'unknown', 0, 1],
    ['ready', 'ready', false, 'lookalike', 0, 0],
    ['ready', 'failed', false, 'lookalike', 1, 0],
    ['failed', 'absent', false, 'lookalike', 1, 0],
    ['failed', 'ready', false, 'lookalike', 1, 0],
    ['failed', 'failed', false, 'lookalike', 1, 0],
  ] as const)(
    'resolves operation %s / delivery %s with explicit failure taking precedence over absence',
    (operation, delivery, frozen, composition, unhealthyCount, unresolvedCount) => {
      const readiness = (state: 'absent' | 'ready' | 'failed') =>
        state === 'absent' ? null : { code: state === 'ready' ? 200 : 300 }
      const r = resolveAudience(ev({
        targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
        audiencesById: {
          A: {
            ...aud('A', 'LOOKALIKE'),
            operationStatus: readiness(operation),
            deliveryStatus: readiness(delivery),
          },
        },
      }), NOW)

      expect(r.frozen).toBe(frozen)
      expect(r.composition).toBe(composition)
      expect(r.unhealthyIncludedAudienceIds).toHaveLength(unhealthyCount)
      expect(r.unresolvedIncludedAudienceIds).toHaveLength(unresolvedCount)
    },
  )

  it('treats a status object with no numeric code as absent, not as an explicit failure', () => {
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: {
        A: { ...aud('A', 'WEBSITE'), operationStatus: { code: null } },
      },
    }), NOW)

    expect(r.frozen).toBe(true)
    expect(r.unhealthyIncludedAudienceIds).toEqual([])
    expect(r.unresolvedIncludedAudienceIds).toEqual(['A'])
    expect(r.evidence.join(' ')).toMatch(/readiness was never synced/i)
  })

  it('a failed EXCLUSION is surfaced as not suppressing anyone, and does not freeze', () => {
    const r = resolveAudience(ev({
      targeting: {
        custom_audiences: [{ id: 'A' }],
        excluded_custom_audiences: [{ id: 'X' }],
        targeting_automation: { advantage_audience: 0 },
      },
      audiencesById: {
        A: aud('A', 'WEBSITE'),
        X: { ...aud('X', 'WEBSITE'), deliveryStatus: { code: 300 } },
      },
    }), NOW)
    expect(r.frozen).toBe(false)
    expect(r.composition).toBe('retargeting_only')
    expect(r.unhealthyExcludedAudienceIds).toEqual(['X'])
    expect(r.audienceHealthFindings.join(' ')).toMatch(/NOT suppressing anyone/i)
    expect(r.audienceReadinessFindings).toEqual([{
      audienceId: 'X', role: 'excluded', state: 'unhealthy', failureStatus: 'delivery',
      operationStatusCode: 200, deliveryStatusCode: 300, observedAt: FRESH,
    }])
    // ...and it must reach the OWNER, not just the return value. `audienceHealthFindings` is read by
    // nothing outside this module; `evidence` is the rendered channel. `refFor` already puts each
    // audience's status line there, but it cannot know which SIDE of the targeting the audience sits
    // on -- and that is the whole finding. An unbuilt inclusion contributes nobody; an unbuilt
    // exclusion suppresses nobody, which means the ad set is reaching people it was told to exclude.
    // Those are opposite consequences and only one of them is a spend problem.
    expect(r.evidence.join(' ')).toMatch(/reaching people it was configured to exclude/i)
  })

  it('a selected audience with stale inventory metadata freezes composition', () => {
    const stale = new Date(NOW - (TARGETING_STALE_HOURS + 1) * 3_600_000).toISOString()
    const r = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
      audiencesById: { A: { ...aud('A', 'WEBSITE'), lastSyncedAt: stale } },
    }), NOW)
    expect(r.composition).toBe('unknown')
    expect(r.frozen).toBe(true)
    expect(r.evidence.join(' ')).toMatch(/metadata is stale/i)
  })

  it('unresolved audience subtypes now FREEZE rather than merely lowering confidence', () => {
    const withMeta = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 1 } },
      audiencesById: { A: aud('A', 'WEBSITE'), B: aud('B', 'LOOKALIKE') },
    }), NOW)
    const withoutMeta = resolveAudience(ev({
      targeting: { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 1 } },
    }), NOW)
    expect(withMeta.composition).toBe('mixed')
    expect(withMeta.frozen).toBe(false)
    // Partial metadata is not a confidence discount — it is an unestablished composition.
    expect(withoutMeta.composition).toBe('unknown')
    expect(withoutMeta.frozen).toBe(true)
    expect(withoutMeta.confidence).toBeLessThan(withMeta.confidence)
  })

  it('captures location and age boundaries', () => {
    const r = resolveAudience(ev({
      targeting: {
        geo_locations: { countries: ['US'], cities: [{ name: 'Springfield', radius: 20 }] },
        age_min: 25, age_max: 55, targeting_automation: { advantage_audience: 0 },
      },
    }), NOW)
    expect(r.locations.countries).toEqual(['US'])
    expect(r.locations.cities).toEqual(['Springfield'])
    expect(r.locations.radiusMiles).toBe(20)
    expect(r.ageMin).toBe(25)
    expect(r.ageMax).toBe(55)
  })

  it('readExpansion handles the documented spellings', () => {
    expect(readExpansion({ targeting_automation: { advantage_audience: 1 } })).toBe('enabled')
    expect(readExpansion({ targeting_automation: { advantage_audience: 0 } })).toBe('disabled')
    expect(readExpansion({ advantage_audience: true })).toBe('enabled')
    expect(readExpansion({})).toBe('unknown')
  })
})

describe('budget-move gate', () => {
  const mixed = resolveAudience(ev({
    targeting: { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 1 } },
    audiencesById: { A: aud('A', 'WEBSITE'), B: aud('B', 'LOOKALIKE') },
  }), NOW)
  const pure = resolveAudience(ev({
    targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 } },
    audiencesById: { A: aud('A', 'WEBSITE') },
  }), NOW)

  it('BLOCKS a large move into MIXED inventory and proposes a test instead', () => {
    const g = gateBudgetMove(mixed, { currentBudget: 22, proposedBudget: 34 })
    expect(g.allowed).toBe(false)
    expect(g.fallback).toBe('test')
    expect(g.reason).toMatch(/MIXED/)
  })

  it('BLOCKS a move when composition is unresolved and routes to owner review', () => {
    const unknown = resolveAudience(ev({ targeting: null }), NOW)
    const g = gateBudgetMove(unknown, { currentBudget: 22, proposedBudget: 34 })
    expect(g.allowed).toBe(false)
    expect(g.fallback).toBe('freeze')
  })

  it('ALLOWS a move into resolved pure inventory', () => {
    expect(gateBudgetMove(pure, { currentBudget: 22, proposedBudget: 34 }).allowed).toBe(true)
  })

  it('a below-threshold change is not blocked', () => {
    expect(gateBudgetMove(mixed, { currentBudget: 22, proposedBudget: 23 }).allowed).toBe(true)
  })

  it('an unknown baseline budget is treated as material', () => {
    expect(gateBudgetMove(mixed, { currentBudget: null, proposedBudget: 34 }).allowed).toBe(false)
  })
})

describe('source-specific trust', () => {
  const base: ConversionEvidence = {
    metaConversions: 10, viewThroughConversions: 1, firstPartyBookings: 12, ga4PaidConfirmationEvents: 5,
    firstPartyClickCoverage: 0.8, inLearning: false, audienceComposition: 'broad_advantage',
    hasCausalEvidence: true,
  }

  it('DELIVERY facts stay trustworthy when the fetch succeeded — a conversion problem cannot drag them down', () => {
    const d = deliveryFactActionability(true, 2)
    expect(d.level).toBe('actionable')
    expect(d.evidenceClass).toBe('measurement')
    expect(d.score).toBe(100)
  })

  it('Meta-attributed bookings are never promoted into exact paid business truth by volume', () => {
    const a = conversionActionability({ ...base, metaConversions: 3, viewThroughConversions: 0 })
    expect(a.level).not.toBe('actionable')
    expect(a.caps.map((c) => c.reason).join(' ')).toMatch(/not an exact paid business-outcome cohort/)
    expect(a.statement).toMatch(/Do not present them as verified business outcomes/)
  })

  it('view-through-heavy conversions cap actionability and are not incrementality', () => {
    const a = conversionActionability({ ...base, metaConversions: 10, viewThroughConversions: 9 })
    expect(a.viewThroughShare).toBeCloseTo(0.9, 6)
    expect(a.caps.map((c) => c.reason).join(' ')).toMatch(/not evidence of incremental impact/)
    expect(a.score).toBeLessThanOrEqual(35)
  })

  it('an UNKNOWN view/click breakdown is not treated as click-driven', () => {
    const a = conversionActionability({ ...base, viewThroughConversions: null })
    expect(a.viewThroughShare).toBeNull()
    expect(a.caps.map((c) => c.reason).join(' ')).toMatch(/breakdown is UNKNOWN/)
  })

  it('caps for modelled attribution, plane conflict, low click coverage, mixed audience, and no causal evidence', () => {
    expect(conversionActionability({ ...base, metaConversions: 4 }).caps.some((c) => /modelled attribution/.test(c.reason))).toBe(true)
    expect(conversionActionability({ ...base, ga4PaidConfirmationEvents: 0 }).caps.some((c) => /disagree/.test(c.reason))).toBe(true)
    expect(conversionActionability({ ...base, firstPartyClickCoverage: 0.1 }).caps.some((c) => /click attribution/.test(c.reason))).toBe(true)
    expect(conversionActionability({ ...base, inLearning: true }).caps.some((c) => /learning phase/.test(c.reason))).toBe(false)
    expect(conversionActionability({ ...base, audienceComposition: 'mixed' }).caps.some((c) => /MIXED/.test(c.reason))).toBe(true)
    expect(conversionActionability({ ...base, hasCausalEvidence: false }).caps.some((c) => /incrementality/.test(c.reason))).toBe(true)
  })

  it('displays the REASONS for a cap, not just the score', () => {
    const a = conversionActionability({ ...base, metaConversions: 3, viewThroughConversions: 3, inLearning: true })
    expect(a.caps.length).toBeGreaterThanOrEqual(3)
    for (const c of a.caps) expect(c.reason.length).toBeGreaterThan(20)
  })

  it('even a clean Meta-modelled set stays directional without exact paid evidence', () => {
    // ga4PaidConfirmationEvents must be within the plane-conflict ratio of the modelled count — 40 vs the
    // default 5 is an 8x disagreement and correctly caps.
    // Every plane must AGREE within the conflict ratio: modelled 40, GA4 35, first-party 45.
    const a = conversionActionability({
      ...base, metaConversions: 40, viewThroughConversions: 4, ga4PaidConfirmationEvents: 35, firstPartyBookings: 45,
    })
    expect(a.level).toBe('directional')
    expect(a.caps).toEqual([expect.objectContaining({ ceiling: 60 })])
  })

  // firstPartyBookings used to enter the function and influence NOTHING.
  it('BUSINESS TRUTH now caps the modelled claim when the planes diverge', () => {
    const diverged = conversionActionability({
      ...base, metaConversions: 40, viewThroughConversions: 4, ga4PaidConfirmationEvents: 35, firstPartyBookings: 5,
    })
    expect(diverged.level).not.toBe('actionable')
    expect(diverged.caps.some((c) => /first-party business truth/.test(c.reason))).toBe(true)
  })

  it('modelled conversions in a window with ZERO first-party bookings are near-unusable', () => {
    const a = conversionActionability({
      ...base, metaConversions: 12, viewThroughConversions: 1, ga4PaidConfirmationEvents: 10, firstPartyBookings: 0,
    })
    expect(a.level).toBe('insufficient')
    expect(a.caps.some((c) => /claims outcomes business truth does not record/.test(c.reason))).toBe(true)
  })

  it('UNAVAILABLE business truth is itself a cap — the modelled count cannot be checked', () => {
    const a = conversionActionability({
      ...base, metaConversions: 40, viewThroughConversions: 4, ga4PaidConfirmationEvents: 35, firstPartyBookings: null,
    })
    expect(a.caps.some((c) => /cannot be checked against business truth/.test(c.reason))).toBe(true)
  })

  it('a factor-of-N plane disagreement is a conflict even when neither side is zero', () => {
    // GA4 reporting 1 where Meta reports 10 is exactly as unresolved as 0 vs 10.
    const a = conversionActionability({ ...base, metaConversions: 10, ga4PaidConfirmationEvents: 1 })
    expect(a.caps.some((c) => /disagree by ~10\.0x/.test(c.reason))).toBe(true)
  })

  it('independent weaknesses COMPOUND — five caps score lower than one', () => {
    const one = conversionActionability({ ...base, metaConversions: 10, viewThroughConversions: 9, ga4PaidConfirmationEvents: 8 })
    const many = conversionActionability({
      ...base, metaConversions: 10, viewThroughConversions: 9, ga4PaidConfirmationEvents: 1,
      firstPartyClickCoverage: 0.05, inLearning: true, audienceComposition: 'mixed', hasCausalEvidence: false,
    })
    expect(many.caps.length).toBeGreaterThan(one.caps.length)
    expect(many.score).toBeLessThan(one.score)
    expect(many.level).toBe('insufficient')
  })
})

describe('optimization-event signal hierarchy', () => {
  const r = (tier: SignalReading['tier'], count: number | null, extra: Partial<SignalReading> = {}): SignalReading =>
    ({ tier, count, windowDays: 7, provenance: 'test', ...extra })

  it('prefers accepted server CAPI over GA4 and Meta modelled attribution', () => {
    const out = resolveOptimizationEventEvidence([
      r('meta_modeled_attribution', 3), r('ga4_web_observed', 1), r('accepted_server_capi', 12),
    ])
    expect(out.best!.tier).toBe('accepted_server_capi')
    expect(out.perWeek).toBeCloseTo(12, 6)
  })

  it('keeps exact paid outcomes separate from optimizer-event volume', () => {
    const out = resolveOptimizationEventEvidence([
      r('first_party_outcomes', 67, { provenance: 'acuity all-source business total' }),
      r('exact_paid_outcomes', 8, { provenance: 'exact appointment-id join, paid channels only' }),
      r('meta_modeled_attribution', 16),
    ])
    expect(out.best!.tier).toBe('first_party_outcomes')
    expect(out.best!.count).toBe(67)
    expect(out.readings).toContainEqual(expect.objectContaining({ tier: 'exact_paid_outcomes', count: 8 }))
    expect(out.notes.join(' ')).toMatch(/excluded from optimizer-event volume/i)
  })

  it('GA4 is labelled a WEB-OBSERVED lens, never the authoritative optimizer count', () => {
    const out = resolveOptimizationEventEvidence([r('ga4_web_observed', 1)])
    expect(out.notes.join(' ')).toMatch(/WEB-OBSERVED lens/)
    expect(out.notes.join(' ')).toMatch(/NOT the authoritative count of events Meta's optimizer received/)
    expect(out.notes.join(' ')).toMatch(/UNCERTAIN/)
  })

  it('REFUSES a combined browser+server reading without dedup evidence', () => {
    const out = resolveOptimizationEventEvidence([
      r('browser_server_coverage', 40, { dedupEvidence: 'none' }),
      r('ga4_web_observed', 1),
    ])
    expect(out.best!.tier).toBe('ga4_web_observed') // the un-deduped combination is excluded
    expect(out.notes.join(' ')).toMatch(/WITHOUT dedup evidence/)
    expect(out.notes.join(' ')).toMatch(/not summed/)
  })

  it('ACCEPTS a combined reading when dedup is verified', () => {
    const out = resolveOptimizationEventEvidence([
      r('browser_server_coverage', 40, { dedupEvidence: 'shared_event_id_verified' }),
      r('ga4_web_observed', 1),
    ])
    expect(out.best!.tier).toBe('browser_server_coverage')
  })

  it('reports the coverage window with the figure', () => {
    const out = resolveOptimizationEventEvidence([r('accepted_server_capi', 12, { windowDays: 14 })])
    expect(out.notes.join(' ')).toMatch(/coverage window: 14 day\(s\)/)
    expect(out.perWeek).toBeCloseTo(6, 6)
  })

  it('unresolved when nothing is available', () => {
    expect(resolveOptimizationEventEvidence([r('ga4_web_observed', null)]).unresolved).toBe(true)
  })
})

describe('forward attribution coverage', () => {
  const GO_LIVE = '2026-07-09T00:00:00Z'
  const boundary = { goLiveAt: GO_LIVE, provenance: 'tag container publish + CAPI_LIVE_MODE=true' }
  const b = (id: number, iso: string, over: Partial<CoverageBooking> = {}): CoverageBooking => ({
    appointmentId: id, createdAtMs: Date.parse(iso),
    hasFbclid: false, hasFbc: false, hasFbp: false, capiAccepted: false, capiFailed: false,
    hasUtmSource: false, hasUtmCampaign: false, unknownState: false, ...over,
  })

  it('EXCLUDES pre-instrumentation rows from the denominator', () => {
    // 400 historical rows + 4 forward rows. Dividing by 404 would report ~1% "coverage" and would
    // mostly be measuring how old the ledger is.
    const historical = Array.from({ length: 400 }, (_, i) => b(i, '2026-01-15T00:00:00Z'))
    const forward = [
      b(1001, '2026-07-12T00:00:00Z', { hasFbclid: true, capiAccepted: true, hasUtmSource: true }),
      b(1002, '2026-07-13T00:00:00Z', { hasFbclid: true, capiAccepted: true }),
      b(1003, '2026-07-14T00:00:00Z', { capiAccepted: true }),
      b(1004, '2026-07-15T00:00:00Z', {}),
    ]
    const r = computeForwardCoverage([...historical, ...forward], boundary, { endMs: NOW })

    expect(r.eligible).toBe(4)
    expect(r.excludedPreBoundary).toBe(400)
    expect(r.clickIdCoverage).toBeCloseTo(0.5, 6)   // 2/4, not 2/404
    expect(r.capiAcceptanceRate).toBeCloseTo(0.75, 6)
    expect(r.notes.join(' ')).toMatch(/EXCLUDED from the denominator/)
    expect(r.notes.join(' ')).toMatch(/not a capture failure/)
  })

  it('reports the cohort boundary, its provenance, and the window with every figure', () => {
    const r = computeForwardCoverage([b(1, '2026-07-12T00:00:00Z')], boundary, { endMs: NOW })
    expect(r.boundary.goLiveAt).toBe(GO_LIVE)
    expect(r.notes.join(' ')).toMatch(/cohort provenance: tag container publish/)
    expect(r.window.startIso).toBe(new Date(Date.parse(GO_LIVE)).toISOString())
    expect(r.window.endIso).toBe(new Date(NOW).toISOString())
  })

  it('an EMPTY cohort is unknown, not 0%', () => {
    const r = computeForwardCoverage([b(1, '2026-01-01T00:00:00Z')], boundary, { endMs: NOW })
    expect(r.eligible).toBe(0)
    expect(r.clickIdCoverage).toBeNull()
    expect(r.notes.join(' ')).toMatch(/EMPTY — coverage is unknown, not 0%/)
  })

  it('counts unknown capture state separately — never as captured or as missing', () => {
    const r = computeForwardCoverage([
      b(1, '2026-07-12T00:00:00Z', { hasFbclid: true }),
      b(2, '2026-07-12T00:00:00Z', { unknownState: true }),
    ], boundary, { endMs: NOW })
    expect(r.unknownState).toBe(1)
    expect(r.withFbclidOrFbc).toBe(1)
    expect(r.notes.join(' ')).toMatch(/UNKNOWN capture state/)
  })

  it('separates failed CAPI deliveries from accepted ones', () => {
    const r = computeForwardCoverage([
      b(1, '2026-07-12T00:00:00Z', { capiAccepted: true }),
      b(2, '2026-07-12T00:00:00Z', { capiFailed: true }),
    ], boundary, { endMs: NOW })
    expect(r.withAcceptedCapi).toBe(1)
    expect(r.withFailedCapi).toBe(1)
    expect(r.capiAcceptanceRate).toBeCloseTo(0.5, 6)
  })

  it('an INVALID boundary fails closed — the full ledger is never a substitute denominator', () => {
    const r = computeForwardCoverage(
      [b(1, '2026-07-12T00:00:00Z', { hasFbclid: true })],
      { goLiveAt: 'not-a-date', provenance: 'x' },
      { endMs: NOW },
    )
    expect(r.eligible).toBe(0)
    expect(r.clickIdCoverage).toBeNull()
    expect(r.notes.join(' ')).toMatch(/must NOT be used as a substitute denominator/)
  })

  it('an explicit window start narrows the cohort but never widens it past the boundary', () => {
    const rows = [b(1, '2026-07-12T00:00:00Z'), b(2, '2026-07-20T00:00:00Z')]
    const narrowed = computeForwardCoverage(rows, boundary, { startMs: Date.parse('2026-07-18T00:00:00Z'), endMs: NOW })
    expect(narrowed.eligible).toBe(1)
    const widened = computeForwardCoverage(rows, boundary, { startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: NOW })
    expect(widened.eligible).toBe(2) // clamped to the boundary, not 2026-01-01
    expect(widened.window.startIso).toBe(new Date(Date.parse(GO_LIVE)).toISOString())
  })

  it('the rendered block forbids claiming the historical ledger measures current capture', () => {
    const text = renderForwardCoverage(computeForwardCoverage([b(1, '2026-07-12T00:00:00Z')], boundary, { endMs: NOW })).join('\n')
    expect(text).toMatch(/FORWARD COHORT ONLY/)
    expect(text).toMatch(/never state that the full historical ledger measures the current capture implementation/)
  })
})
