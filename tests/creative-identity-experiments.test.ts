import { describe, it, expect } from 'vitest'
import {
  buildCreativeIdentity, analyzeCreativeDiversity, computeContentHash, aspectRatioOf, placementFit,
  type CreativeMetadata,
} from '@/lib/creative/identity'
import {
  decideRecommendation, buildTestBrief, resolveOptimizationUnit,
  type DecisionInputs,
} from '@/lib/recommendations/decision-policy'
import { resolveAudience } from '@/lib/audience/resolver'
import { conversionActionability } from '@/lib/trust/conversion-actionability'

const NOW = Date.parse('2026-07-26T12:00:00Z')

const meta = (over: Partial<CreativeMetadata> = {}): CreativeMetadata => ({
  adId: 'ad1', adsetId: 'set1', creativeId: 'cr1',
  mediaId: 'vid_100', mediaKind: 'video', mediaBytes: 5_000_000, mediaChecksum: null,
  durationSeconds: 90, width: 1080, height: 1920, placements: ['instagram_reels'],
  conceptId: null, creatorId: null, hookStyle: null,
  offerTags: [], proofTags: [], ctaTags: [], safeZoneOk: null,
  ...over,
})

describe('creative identity — one asset is one asset', () => {
  it('a byte-identical video in Cold and Warm is ONE asset, not two tests', () => {
    const r = analyzeCreativeDiversity([
      meta({ adId: 'adCold', adsetId: 'cold', mediaId: 'vid_100', mediaBytes: 5_000_000 }),
      meta({ adId: 'adWarm', adsetId: 'warm', mediaId: 'vid_100', mediaBytes: 5_000_000 }),
    ])
    expect(r.totalAds).toBe(2)
    expect(r.distinctAssets).toBe(1)
    expect(r.duplicates).toHaveLength(1)
    expect(r.duplicates[0].spansMultipleAdsets).toBe(true)
    expect(r.notes.join(' ')).toMatch(/same asset tested twice, not two independent creative tests/)
  })

  it('different assets are counted separately', () => {
    const r = analyzeCreativeDiversity([
      meta({ adId: 'a', mediaId: 'vid_100' }),
      meta({ adId: 'b', mediaId: 'vid_200' }),
    ])
    expect(r.distinctAssets).toBe(2)
    expect(r.duplicates).toHaveLength(0)
  })

  it('a checksum is the strongest identity basis; ids alone are flagged weak', () => {
    expect(computeContentHash(meta({ mediaChecksum: 'abc123' })).basis).toBe('checksum')
    expect(computeContentHash(meta({ mediaBytes: 100 })).basis).toBe('media_id_and_size')
    expect(computeContentHash(meta({ mediaBytes: null })).basis).toBe('media_id_only')
    expect(computeContentHash(meta({ mediaId: null, mediaBytes: null })).basis).toBe('insufficient')
  })

  it('ads with no asset identity never collide into a false duplicate', () => {
    const r = analyzeCreativeDiversity([
      meta({ adId: 'x', mediaId: null, mediaBytes: null }),
      meta({ adId: 'y', mediaId: null, mediaBytes: null }),
    ])
    expect(r.distinctAssets).toBe(2)
    expect(r.duplicates).toHaveLength(0)
    expect(r.weakIdentityAds).toEqual(['x', 'y'])
  })

  it('records duration, aspect ratio, format and placement fit', () => {
    const id = buildCreativeIdentity(meta({ width: 1080, height: 1920, durationSeconds: 125 }))
    expect(id.aspectRatio).toBe('9:16')
    expect(id.durationSeconds).toBe(125)
    expect(id.mediaKind).toBe('video')
  })

  it('flags a geometry/placement mismatch deterministically', () => {
    expect(placementFit('16:9', ['instagram_reels']).join(' ')).toMatch(/expects a vertical asset/)
    expect(placementFit('9:16', ['instream_video']).join(' ')).toMatch(/favours horizontal\/square/)
    expect(placementFit('9:16', ['instagram_reels'])).toEqual([])
    expect(placementFit(null, ['instagram_reels'])).toEqual([]) // silent when undeterminable
  })

  it('aspectRatioOf reduces properly and returns null on bad input', () => {
    expect(aspectRatioOf(1080, 1920)).toBe('9:16')
    expect(aspectRatioOf(1920, 1080)).toBe('16:9')
    expect(aspectRatioOf(1080, 1080)).toBe('1:1')
    expect(aspectRatioOf(null, 1080)).toBeNull()
    expect(aspectRatioOf(0, 0)).toBeNull()
  })

  it('lists MISSING metadata rather than inventing it', () => {
    const id = buildCreativeIdentity(meta({ conceptId: null, creatorId: null, hookStyle: null, safeZoneOk: null }))
    expect(id.missingMetadata).toEqual(expect.arrayContaining(['conceptId', 'creatorId', 'hookStyle', 'safeZone']))
    expect(id.conceptId).toBeNull()
  })

  it('concept/creator/hook diversity is NULL when nothing was supplied — never inferred', () => {
    const r = analyzeCreativeDiversity([meta({ adId: 'a' }), meta({ adId: 'b', mediaId: 'v2' })])
    expect(r.distinctConcepts).toBeNull()
    expect(r.distinctCreators).toBeNull()
    expect(r.distinctHookStyles).toBeNull()
    expect(r.notes.join(' ')).toMatch(/is NOT inferred/)
  })

  it('counts supplied concept/creator/hook tags when they ARE provided', () => {
    const r = analyzeCreativeDiversity([
      meta({ adId: 'a', mediaId: 'v1', conceptId: 'tour', creatorId: 'c1', hookStyle: 'question' }),
      meta({ adId: 'b', mediaId: 'v2', conceptId: 'proof', creatorId: 'c1', hookStyle: 'question' }),
    ])
    expect(r.distinctConcepts).toBe(2)
    expect(r.distinctCreators).toBe(1)
    expect(r.distinctHookStyles).toBe(1)
  })

  it('safe-zone status stays null when not measurable', () => {
    expect(buildCreativeIdentity(meta({ safeZoneOk: null })).safeZoneOk).toBeNull()
    expect(buildCreativeIdentity(meta({ safeZoneOk: true })).safeZoneOk).toBe(true)
  })
})

// ── decision policy ────────────────────────────────────────────────────────────────────────────

const freshTargeting = (over: Record<string, unknown> = {}) =>
  resolveAudience({
    adsetName: 'Warm Engagers | Retargeting',
    targeting: { custom_audiences: [{ id: 'A' }], targeting_automation: { advantage_audience: 0 }, ...over },
    targetingSyncedAt: '2026-07-26T11:00:00Z',
    accountId: 'self',
    audiencesById: {
      A: { id: 'A', name: 'site visitors', subtype: 'WEBSITE', accountId: 'self', operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: '2026-07-26T11:00:00Z' },
    },
  }, NOW)

const mixedTargeting = () =>
  resolveAudience({
    adsetName: 'Warm Engagers | Retargeting',
    targeting: { custom_audiences: [{ id: 'A' }, { id: 'B' }], targeting_automation: { advantage_audience: 1 } },
    targetingSyncedAt: '2026-07-26T11:00:00Z',
    accountId: 'self',
    audiencesById: {
      A: { id: 'A', name: 'site visitors', subtype: 'WEBSITE', accountId: 'self', operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: '2026-07-26T11:00:00Z' },
      B: { id: 'B', name: 'lal 1%', subtype: 'LOOKALIKE', accountId: 'self', operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: '2026-07-26T11:00:00Z' },
    },
  }, NOW)

const strongConversions = conversionActionability({
  metaConversions: 60, viewThroughConversions: 5, firstPartyBookings: 55, ga4PaidConfirmationEvents: 50,
  firstPartyClickCoverage: 0.9, inLearning: false, audienceComposition: 'retargeting_only',
  hasCausalEvidence: true,
})

const weakConversions = conversionActionability({
  metaConversions: 10, viewThroughConversions: 9, firstPartyBookings: 40, ga4PaidConfirmationEvents: 1,
  firstPartyClickCoverage: 0.2, inLearning: true, audienceComposition: 'mixed',
  hasCausalEvidence: false,
})

const inputs = (over: Partial<DecisionInputs> = {}): DecisionInputs => ({
  kind: 'budget',
  budgetStructure: 'abo',
  entityLevel: 'adset',
  audience: freshTargeting(),
  conversions: strongConversions,
  firstPartyOutcomes: { value: 55, scope: 'adset', provenance: 'test' },
  webAttributedOutcomes: { value: 50, scope: 'adset', provenance: 'test' },
  deliveryMeasured: true,
  inLearning: false,
  diversity: null,
  conflictingExperiments: [],
  windowDays: 30,
  currentBudget: 22,
  proposedBudget: 34,
  hasCausalEvidence: true,
  ...over,
})

describe('recommendation decision policy', () => {
  it('identifies the correct optimization unit', () => {
    expect(resolveOptimizationUnit('cbo', 'adset')).toBe('campaign')
    expect(resolveOptimizationUnit('abo', 'ad')).toBe('adset')
    expect(resolveOptimizationUnit('abo', 'adset')).toBe('adset')
    expect(resolveOptimizationUnit('unknown', 'adset')).toBe('unknown')
  })

  it('an unknown budget structure escalates to OWNER REVIEW, never a direct action', () => {
    const d = decideRecommendation(inputs({ budgetStructure: 'unknown' }))
    expect(d.verdict).toBe('owner_review')
    expect(d.blockedBy).toContain('optimization_unit_identified')
    expect(d.gates.find((g) => g.name === 'optimization_unit_identified')!.detail)
      .toMatch(/CBO campaign must not be judged at ad-set level/)
  })

  it('STALE targeting FREEZES the decision', () => {
    const stale = resolveAudience({
      adsetName: 'Warm', targeting: { custom_audiences: [] }, targetingSyncedAt: null, accountId: 'self',
    }, NOW)
    const d = decideRecommendation(inputs({ audience: stale }))
    expect(d.verdict).toBe('freeze')
  })

  it('records a resolved MIXED audience and weak modelled evidence without letting either decide commercial authority', () => {
    const d = decideRecommendation(inputs({
      audience: mixedTargeting(), conversions: weakConversions, inLearning: true,
      hasCausalEvidence: false, windowDays: 7,
    }))
    expect(d.verdict).toBe('ready_for_authority')
    expect(d.testBriefRequired).toBe(false)
    expect(d.blockedBy).toEqual([])
    expect(d.gates.find((g) => g.name === 'audience_composition_established')).toMatchObject({ passed: true })
    expect(d.gates.find((g) => g.name === 'modelled_conversion_context_recorded')).toMatchObject({ passed: true })
    expect(d.summary).toMatch(/grants no commercial authority/i)
  })

  it('a fixed calendar-window floor cannot veto a mature governed contribution result', () => {
    const d = decideRecommendation(inputs({ windowDays: 7 }))
    expect(d.verdict).toBe('ready_for_authority')
    expect(d.gates.find((g) => g.name === 'calendar_window_context_recorded')).toMatchObject({ passed: true })
    expect(d.decisionThreshold).toMatch(/governed contribution authority/i)
  })

  it('a conflicting running experiment yields MONITOR', () => {
    const d = decideRecommendation(inputs({ conflictingExperiments: ['exp-daily_budget'] }))
    expect(d.verdict).toBe('monitor')
    expect(d.gates.find((g) => g.name === 'no_experiment_conflict')!.detail).toMatch(/contaminate the result/)
  })

  it('legacy experiment metadata cannot substitute for or veto final contribution authority', () => {
    const d = decideRecommendation(inputs({ kind: 'scale', hasCausalEvidence: false }))
    expect(d.verdict).toBe('ready_for_authority')
    expect(d.gates.find((g) => g.name === 'commercial_authority_deferred')).toMatchObject({ passed: true })
    expect(d.gates.find((g) => g.name === 'commercial_authority_deferred')!.detail)
      .toMatch(/causal incremental contribution/i)
  })

  it('never treats modelled-attribution context as a commercial authority gate', () => {
    const d = decideRecommendation(inputs({ conversions: weakConversions }))
    expect(d.verdict).toBe('ready_for_authority')
    expect(d.gates.find((g) => g.name === 'modelled_conversion_context_recorded')).toMatchObject({ passed: true })
    expect(d.gates.find((g) => g.name === 'modelled_conversion_context_recorded')!.detail)
      .toMatch(/diagnostic only/i)
  })

  it('shows every evidence plane SEPARATELY and never blends them', () => {
    const d = decideRecommendation(inputs({ conversions: weakConversions, audience: mixedTargeting() }))
    expect(d.evidence.businessTruth).toMatch(/first-party outcomes/)
    expect(d.evidence.webAttributed).toMatch(/web-attributed \(GA4\)/)
    expect(d.evidence.metaModeled).toMatch(/Meta modelled attribution/)
    expect(d.evidence.delivery).toMatch(/delivery facts/)
    expect(d.evidence.viewClickMix).toMatch(/view-through/)
    expect(d.evidence.sampleAdequacy).toMatch(/window/)
    expect(d.evidence.learningState).toBeTruthy()
  })

  it('write mode is never enabled by any verdict', () => {
    for (const over of [{}, { windowDays: 7 }, { budgetStructure: 'unknown' as const }, { conversions: weakConversions }]) {
      expect(decideRecommendation(inputs(over)).writeModeEnabled).toBe(false)
    }
  })

  it('a refresh recommendation surfaces cross-ad-set creative reuse', () => {
    const diversity = analyzeCreativeDiversity([
      meta({ adId: 'adCold', adsetId: 'cold', mediaId: 'vid_100' }),
      meta({ adId: 'adWarm', adsetId: 'warm', mediaId: 'vid_100' }),
    ])
    const d = decideRecommendation(inputs({ kind: 'refresh', diversity }))
    expect(d.blockedBy).toContain('creative_diversity_understood')
    expect(d.gates.find((g) => g.name === 'creative_diversity_understood')!.detail)
      .toMatch(/overstates real diversity/)
  })
})

describe('legacy test brief generation', () => {
  it('fails closed instead of manufacturing booking/CPA goals and arbitrary spend floors', () => {
    expect(() => buildTestBrief(
      inputs(),
      decideRecommendation(inputs()),
      { entityLevel: 'adset', entityRef: 'adset-x' },
    )).toThrow(/CampaignPlan grader/i)
  })
})
