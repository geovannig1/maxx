import { describe, it, expect } from 'vitest'
import { resolveAudience } from '@/lib/audience/resolver'
import { conversionActionability, resolveOptimizationEventEvidence } from '@/lib/trust/conversion-actionability'
import { analyzeCreativeDiversity, type CreativeMetadata } from '@/lib/creative/identity'
import { decideRecommendation, buildTestBrief, type DecisionInputs } from '@/lib/recommendations/decision-policy'
import { retargetingShareOfSpend } from '@/lib/diagnostics/structure'
import { computeVideoMetrics } from '@/lib/creative/video-metrics'
import { computeForwardCoverage, type CoverageBooking } from '@/lib/tracking/forward-coverage'

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ACCOUNT-SHAPED REGRESSION FIXTURE
//
// These numbers are an invented 30-day observation shaped like a small local-service account. They
// are a REGRESSION FIXTURE, not policy: no threshold, campaign name, budget, or verdict here may become a permanent rule. The
// point is that the deterministic pipeline, fed this shape of evidence, reaches a CONSERVATIVE
// conclusion — business demand may exist, delivery is measurable, incremental paid contribution is
// UNRESOLVED — instead of a confident spend instruction.
//
// Deliberately NOT encoded anywhere: pausing a specific ad, activating a specific ad, or setting any
// budget to a specific number. Those would be account-specific hypotheses, never universal rules.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const NOW = Date.parse('2026-03-18T12:00:00Z')
const FRESH = '2026-03-18T11:00:00Z'
const ACCOUNT = 'act_fixture'
const READY = { operationStatus: { code: 200 }, deliveryStatus: { code: 200 }, lastSyncedAt: FRESH }

/** The invented 30-day observation. Synthetic ids and entity names. */
const OBSERVED = {
  spend: 742,
  impressions: 31_400,
  linkClicks: 388,
  landingPageViews: 196,
  metaBookings: 8,
  metaViewThroughBookings: 6,
  ga4PaidConfirmationEvents: 2,
  outcomeTotalBookings: 27,        // materially more total business bookings
  sevenDay: { metaViewThroughBookings: 2, ga4PaidConfirmationEvents: 0 },
  windowDays: 30,
} as const

// One ABO leads campaign, one Cold ad set, one ad set NAMED warm/retargeting.
const COLD = resolveAudience({
  adsetName: 'Cold Broad | Advantage+',
  targeting: { geo_locations: { cities: [{ name: 'Metro', radius: 20 }] }, targeting_automation: { advantage_audience: 1 } },
  targetingSyncedAt: FRESH,
  accountId: ACCOUNT,
}, NOW)

// The "Warm" set actually includes retargeting audiences, lookalikes AND Advantage expansion.
const NOMINAL_WARM = resolveAudience({
  adsetName: 'Warm Engagers | Retargeting',
  targeting: {
    custom_audiences: [{ id: 'CA1' }, { id: 'CA2' }, { id: 'LAL1' }],
    targeting_automation: { advantage_audience: 1 },
    geo_locations: { cities: [{ name: 'Metro', radius: 20 }] },
  },
  targetingSyncedAt: FRESH,
  accountId: ACCOUNT,
  audiencesById: {
    CA1: { id: 'CA1', name: 'site visitors 180d', subtype: 'WEBSITE', accountId: ACCOUNT, ...READY },
    CA2: { id: 'CA2', name: 'social engagers 300d', subtype: 'ENGAGEMENT', accountId: ACCOUNT, ...READY },
    LAL1: { id: 'LAL1', name: 'lookalike 1%', subtype: 'LOOKALIKE', accountId: ACCOUNT, ...READY },
  },
}, NOW)

// Several active 9:16 videos are 77-141 seconds; two ads reuse an identical media file.
const CREATIVES: CreativeMetadata[] = [
  { adId: 'ad_a', adsetId: 'cold', creativeId: 'cr_a', mediaId: 'vid_1', mediaKind: 'video', mediaBytes: 6_300_000, mediaChecksum: null, durationSeconds: 77, width: 1080, height: 1920, placements: ['instagram_reels'], conceptId: null, creatorId: null, hookStyle: null, offerTags: [], proofTags: [], ctaTags: [], safeZoneOk: null },
  { adId: 'ad_b', adsetId: 'cold', creativeId: 'cr_b', mediaId: 'vid_2', mediaKind: 'video', mediaBytes: 15_900_000, mediaChecksum: null, durationSeconds: 141, width: 1080, height: 1920, placements: ['instagram_reels'], conceptId: null, creatorId: null, hookStyle: null, offerTags: [], proofTags: [], ctaTags: [], safeZoneOk: null },
  // ad_c reuses ad_a's exact media file, in the OTHER ad set.
  { adId: 'ad_c', adsetId: 'warm', creativeId: 'cr_c', mediaId: 'vid_1', mediaKind: 'video', mediaBytes: 6_300_000, mediaChecksum: null, durationSeconds: 77, width: 1080, height: 1920, placements: ['instagram_reels'], conceptId: null, creatorId: null, hookStyle: null, offerTags: [], proofTags: [], ctaTags: [], safeZoneOk: null },
]

describe('Regression fixture — the nominal "Warm" audience is MIXED', () => {
  it('resolves to mixed despite the name, and reports the conflict', () => {
    expect(NOMINAL_WARM.composition).toBe('mixed')
    expect(NOMINAL_WARM.nameSuggests).toBe('warm')
    expect(NOMINAL_WARM.nameConflictsWithTargeting).toBe(true)
    expect(NOMINAL_WARM.includedLookalikes).toHaveLength(1)
    expect(NOMINAL_WARM.expansion).toBe('enabled')
  })

  it('a retargeting SPEND SHARE cannot be asserted while a set is mixed', () => {
    const r = retargetingShareOfSpend([
      { name: 'Cold Broad | Advantage+', audience_type: null, spend: 412, composition: COLD.composition },
      { name: 'Warm Engagers | Retargeting', audience_type: null, spend: 287, composition: NOMINAL_WARM.composition },
    ])
    expect(r.share).toBeNull()
    expect(r.detail).toMatch(/mixed or unresolved/)
  })
})

describe('Regression fixture — Meta conversions are view-through-heavy', () => {
  const actionability = conversionActionability({
    metaConversions: OBSERVED.metaBookings,
    viewThroughConversions: OBSERVED.metaViewThroughBookings,
    firstPartyBookings: OBSERVED.outcomeTotalBookings,
    ga4PaidConfirmationEvents: OBSERVED.ga4PaidConfirmationEvents,
    firstPartyClickCoverage: 0.05,
    inLearning: true,
    audienceComposition: NOMINAL_WARM.composition,
    hasCausalEvidence: false,
  })

  it('6 of 8 view-through conversions cap actionability and are not incrementality', () => {
    expect(actionability.viewThroughShare).toBeCloseTo(0.75, 6)
    expect(actionability.level).toBe('insufficient')
    expect(actionability.caps.map((c) => c.reason).join(' ')).toMatch(/not evidence of incremental impact/)
  })

  it('8 Meta bookings vs 2 GA4-paid bookings are recorded as a plane CONFLICT, not a winner', () => {
    expect(actionability.caps.some((c) => /disagree/.test(c.reason))).toBe(true)
  })

  it('the modelled numbers may not be presented as verified business outcomes', () => {
    expect(actionability.statement).toMatch(/Do not present them as verified business outcomes/)
  })

  it('the 7-day window (2 view-through Meta bookings, 0 GA4-paid) is weaker still', () => {
    const week = conversionActionability({
      metaConversions: OBSERVED.sevenDay.metaViewThroughBookings,
      viewThroughConversions: OBSERVED.sevenDay.metaViewThroughBookings,
      firstPartyBookings: 6,
      ga4PaidConfirmationEvents: OBSERVED.sevenDay.ga4PaidConfirmationEvents,
      firstPartyClickCoverage: 0.05,
      inLearning: true,
      audienceComposition: 'mixed',
      hasCausalEvidence: false,
    })
    expect(week.level).toBe('insufficient')
    expect(week.caps.some((c) => /not an exact paid business-outcome cohort/.test(c.reason))).toBe(true)
  })
})

describe('Regression fixture — business demand exists, delivery is measurable', () => {
  it('first-party bookings materially exceed both attributed views of them', () => {
    // Demand is real. What is unresolved is how much of it PAID caused.
    expect(OBSERVED.outcomeTotalBookings).toBeGreaterThan(OBSERVED.metaBookings)
    expect(OBSERVED.outcomeTotalBookings).toBeGreaterThan(OBSERVED.ga4PaidConfirmationEvents)
  })

  it('delivery facts are measured and stateable', () => {
    expect(OBSERVED.spend).toBeGreaterThan(0)
    expect(OBSERVED.impressions).toBeGreaterThan(0)
    expect(OBSERVED.linkClicks).toBeGreaterThan(OBSERVED.landingPageViews) // click-to-LPV drop is measurable
  })

  it('GA4 is NOT promoted to the authoritative optimizer-event count', () => {
    const ev = resolveOptimizationEventEvidence([
      { tier: 'ga4_web_observed', count: OBSERVED.ga4PaidConfirmationEvents, windowDays: 30, provenance: 'GA4 paid channel' },
      { tier: 'meta_modeled_attribution', count: OBSERVED.metaBookings, windowDays: 30, provenance: 'Meta insights' },
    ])
    expect(ev.best!.tier).toBe('ga4_web_observed')
    expect(ev.notes.join(' ')).toMatch(/WEB-OBSERVED lens/)
    expect(ev.notes.join(' ')).toMatch(/UNCERTAIN/)
  })
})

describe('Regression fixture — long videos and duplicated media', () => {
  it('77-141s creatives never produce a p25-derived hook rate', () => {
    const m = computeVideoMetrics({
      impressions: OBSERVED.impressions,
      videoPlays: null, continuous2sViews: null,
      p25: 3_100, p50: 980, p75: 410, p100: 150,
      thruplays: 1_900, avgWatchSeconds: 7, durationSeconds: 141,
    })
    expect(m.earlyViewSource).toBe('unavailable')
    expect(m.earlyView.value).toBeNull()
    // Weak milestone/completion performance is REPORTED as retention, not as a hook.
    expect(m.retentionP25.value).toBeCloseTo((3_100 / OBSERVED.impressions) * 100, 6)
    expect(m.completion.value).toBeCloseTo((150 / OBSERVED.impressions) * 100, 6)
  })

  it('the two ads sharing one media file are ONE asset, spanning both ad sets', () => {
    const d = analyzeCreativeDiversity(CREATIVES)
    expect(d.totalAds).toBe(3)
    expect(d.distinctAssets).toBe(2)          // NOT 3
    expect(d.duplicates).toHaveLength(1)
    expect(d.duplicates[0].spansMultipleAdsets).toBe(true)
    expect(d.notes.join(' ')).toMatch(/not two independent creative tests/)
  })

  it('creative diversification is warranted: only 2 distinct assets carry all delivery', () => {
    const d = analyzeCreativeDiversity(CREATIVES)
    expect(d.distinctAssets).toBeLessThan(d.totalAds)
    expect(d.distinctConcepts).toBeNull() // no concept ids supplied — not inferred
  })
})

describe('Regression fixture — attribution capture is recent relative to ledger history', () => {
  it('the historical ledger is NOT a fair denominator for recent instrumentation', () => {
    const boundary = { goLiveAt: '2026-02-24T00:00:00Z', provenance: 'tracking go-live (fixture)' }
    const historical: CoverageBooking[] = Array.from({ length: 233 }, (_, i) => ({
      appointmentId: i, createdAtMs: Date.parse('2025-11-10T00:00:00Z'),
      hasFbclid: false, hasFbc: false, hasFbp: false, capiAccepted: false, capiFailed: false,
      hasUtmSource: false, hasUtmCampaign: false, unknownState: false,
    }))
    const forward: CoverageBooking[] = Array.from({ length: 10 }, (_, i) => ({
      appointmentId: 1000 + i, createdAtMs: Date.parse('2026-03-02T00:00:00Z'),
      hasFbclid: i < 3, hasFbc: i < 3, hasFbp: false, capiAccepted: i < 7, capiFailed: false,
      hasUtmSource: i < 4, hasUtmCampaign: i < 4, unknownState: false,
    }))

    const r = computeForwardCoverage([...historical, ...forward], boundary, { endMs: NOW })
    expect(r.eligible).toBe(10)
    expect(r.excludedPreBoundary).toBe(233)
    expect(r.clickIdCoverage).toBeCloseTo(0.3, 6)   // 3/10 — NOT 3/243
    expect(r.notes.join(' ')).toMatch(/not a capture failure/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE DETERMINISTIC CONCLUSION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('Regression fixture — the required deterministic conclusion', () => {
  const weak = conversionActionability({
    metaConversions: OBSERVED.metaBookings,
    viewThroughConversions: OBSERVED.metaViewThroughBookings,
    firstPartyBookings: OBSERVED.outcomeTotalBookings,
    ga4PaidConfirmationEvents: OBSERVED.ga4PaidConfirmationEvents,
    firstPartyClickCoverage: 0.05,
    inLearning: true,
    audienceComposition: 'mixed',
    hasCausalEvidence: false,
  })

  const warmBudgetMove = (over: Partial<DecisionInputs> = {}): DecisionInputs => ({
    kind: 'budget',
    budgetStructure: 'abo',
    entityLevel: 'adset',
    audience: NOMINAL_WARM,
    conversions: weak,
    // ACCOUNT scope: the fixture's business truth is account-wide, which must NOT authorise a
    // unit-level money action.
    firstPartyOutcomes: { value: OBSERVED.outcomeTotalBookings, scope: 'account', provenance: 'acuity account total' },
    webAttributedOutcomes: { value: OBSERVED.ga4PaidConfirmationEvents, scope: 'account', provenance: 'ga4 account total' },
    deliveryMeasured: true,
    inLearning: true,
    diversity: analyzeCreativeDiversity(CREATIVES),
    conflictingExperiments: [],
    windowDays: 7,
    currentBudget: 22,
    proposedBudget: 34,
    hasCausalEvidence: false,
    ...over,
  })

  const decision = decideRecommendation(warmBudgetMove())

  it('a large Warm-first budget rebalance is NOT proven even though structural preflight clears', () => {
    // This layer now checks structure only. Account totals, MIXED composition, weak Meta evidence and
    // fixed window floors cannot decide commercial authority; final causal-contribution authority
    // still receives none from this fixture and therefore remains closed.
    expect(decision.verdict).toBe('ready_for_authority')
    expect(decision.blockedBy).toEqual([])
    expect(decision.gates.find((g) => g.name === 'attributed_outcome_scope_recorded')!.detail)
      .toMatch(/grants no commercial authority/)
    expect(decision.summary).toMatch(/grants no commercial authority/)
  })

  it('UNIT-SCOPED attributed outcomes remain context rather than a second commercial gate', () => {
    const d = decideRecommendation(warmBudgetMove({
      firstPartyOutcomes: { value: 9, scope: 'adset', provenance: 'unit-scoped fixture' },
      webAttributedOutcomes: { value: 2, scope: 'adset', provenance: 'unit-scoped fixture' },
    }))
    expect(d.verdict).toBe('ready_for_authority')
    expect(d.gates.find((g) => g.name === 'attributed_outcome_scope_recorded')!.detail)
      .toMatch(/remains association/)
  })

  it('incremental paid contribution is explicitly UNRESOLVED', () => {
    expect(decision.gates.find((g) => g.name === 'commercial_authority_deferred')!.detail)
      .toMatch(/cannot veto or authorize final causal incremental contribution authority/)
    expect(decision.decisionThreshold).toMatch(/settled-money lineage/)
  })

  it('does not invent a causal test from unit-scoped booking association', () => {
    const scoped = decideRecommendation(warmBudgetMove({
      firstPartyOutcomes: { value: 9, scope: 'adset', provenance: 'unit-scoped fixture' },
      webAttributedOutcomes: { value: 2, scope: 'adset', provenance: 'unit-scoped fixture' },
    }))
    expect(scoped.testBriefRequired).toBe(false)
  })

  it('structural preflight never enables writes or grants final money authority', () => {
    expect(decision.writeModeEnabled).toBe(false)
    for (const kind of ['pause', 'refresh', 'scale'] as const) {
      const d = decideRecommendation(warmBudgetMove({ kind }))
      expect(d.writeModeEnabled).toBe(false)
      expect(d.summary).not.toMatch(/execution-eligible/i)
    }
  })

  it('business demand and measurable delivery are still reported, not suppressed', () => {
    expect(decision.evidence.businessTruth).toMatch(new RegExp(String(OBSERVED.outcomeTotalBookings)))
    expect(decision.evidence.delivery).toMatch(/measured and may be stated directly/)
    expect(decision.evidence.webAttributed).toMatch(new RegExp(String(OBSERVED.ga4PaidConfirmationEvents)))
  })

  it('creative diversification is surfaced as evidence', () => {
    expect(decision.evidence.creativeDiversity).toMatch(/2 distinct asset\(s\) across 3 ad\(s\)/)
    expect(decision.evidence.creativeDiversity).toMatch(/1 duplicate group/)
  })

  // ── The guard that keeps this a FIXTURE and not policy ──
  it('encodes NO permanent recommendation about specific ads or budgets', () => {
    const sourceOfPolicy = JSON.stringify(decision)
    // No live-account hypothesis may leak into the deterministic output as a rule.
    expect(sourceOfPolicy).not.toMatch(/Open Space C/i)
    expect(sourceOfPolicy).not.toMatch(/Walkthrough D/i)
    expect(sourceOfPolicy).not.toMatch(/\$20\b/)
    expect(sourceOfPolicy).not.toMatch(/pause .*specific/i)
    expect(() => buildTestBrief(
      warmBudgetMove(), decision, { entityLevel: 'adset', entityRef: 'adset-fixture' },
    )).toThrow(/CampaignPlan grader/i)
  })
})
