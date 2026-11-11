import { describe, it, expect } from 'vitest'
import { evaluateTrackingHealth } from '@/lib/tracking/health-monitor'
import { effectiveUrlTags, validateUrlTags, computeCoverageStats, CANONICAL_UTM_STRING } from '@/lib/tracking/utm-validator'
import { resolveEffectiveUtms, queryStringOf } from '@/lib/tracking/effective-utms'
import { assessLaunchCohort, type CohortAdSet } from '@/lib/modes/launch-cohort'
import { buildLaunchVerdict } from '@/lib/modes/launch-verdict'
import type { AdUtmHealth } from '@/lib/tracking/utm-coverage'

function bindNamedForTest(
  adSets: Array<Omit<CohortAdSet, 'in_launch_cohort'>>,
  names: string[],
): CohortAdSet[] {
  const bound = new Set(names)
  return adSets.map((row) => ({ ...row, in_launch_cohort: bound.has(row.name) }))
}

function bindAllForTest(adSets: Array<Omit<CohortAdSet, 'in_launch_cohort'>>): CohortAdSet[] {
  return adSets.map((row) => ({ ...row, in_launch_cohort: true }))
}

// Audit follow-up: pixel-health dormancy false-positive, UTM creative-level coverage, and cohort-scoped
// launch verdict. All pure — no DB/Meta/GA4. These pin the corrected behaviour so it can't regress.

// ── Bug 1: dormant account is UNVERIFIED, not pixel-broken ─────────────────────────────────────────
describe('Bug 1 — pixel health does not cry "broken" on a dormant account', () => {
  it('no delivery + no conversions ⇒ unverified/dormant, NOT a broken verdict', () => {
    const r = evaluateTrackingHealth({ isFiring: false, outcomeEventsLast7: 0, outcomeEventsPrev7: 0, deliveryLast7: 0, volumeDropPct: null })
    expect(r.status).toBe('unverified')
    expect(r.dormant).toBe(true)
    expect(r.status).not.toBe('critical')
    expect(r.issues.join(' ')).toMatch(/unverified/i)
    expect(r.issues.join(' ')).toMatch(/not broken/i) // labels it explicitly as NOT broken
  })

  it('a dormant account never produces a pixel-broken (critical) verdict, even with prior events', () => {
    const r = evaluateTrackingHealth({ isFiring: false, outcomeEventsLast7: 0, outcomeEventsPrev7: 12, deliveryLast7: 0, volumeDropPct: -100 })
    expect(r.status).toBe('unverified')
    expect(r.dormant).toBe(true)
  })

  it('STILL catches a real break: delivery but zero conversions ⇒ critical (fix does not over-suppress)', () => {
    const r = evaluateTrackingHealth({ isFiring: true, outcomeEventsLast7: 0, outcomeEventsPrev7: 5, deliveryLast7: 240, volumeDropPct: -100 })
    expect(r.status).toBe('critical')
    expect(r.dormant).toBe(false)
    expect(r.issues.join(' ')).toMatch(/despite active ad delivery/i)
  })

  it('healthy when delivering and converting', () => {
    const r = evaluateTrackingHealth({ isFiring: true, outcomeEventsLast7: 6, outcomeEventsPrev7: 5, deliveryLast7: 300, volumeDropPct: 20 })
    expect(r.status).toBe('healthy')
    expect(r.dormant).toBe(false)
  })
})

// ── Bug 2: creative-level UTMs count toward coverage ──────────────────────────────────────────────
describe('Bug 2 — UTM coverage reads the EFFECTIVE tags (ad-level wins, creative-level fallback)', () => {
  it('creative-level canonical UTMs count as correct when the ad-level field is empty', () => {
    const eff = effectiveUrlTags(null, CANONICAL_UTM_STRING)
    expect(eff).toBe(CANONICAL_UTM_STRING)
    expect(validateUrlTags(eff).verdict).toBe('correct')
    // …and that "correct" ad lifts coverage to 100% (never a false 0%).
    expect(computeCoverageStats([validateUrlTags(eff).verdict]).coverage).toBe(1)
  })

  it('an EMPTY ad-level url_tags does not override valid creative-level tags', () => {
    expect(effectiveUrlTags('', CANONICAL_UTM_STRING)).toBe(CANONICAL_UTM_STRING) // empty string, not just null
    expect(effectiveUrlTags('   ', CANONICAL_UTM_STRING)).toBe(CANONICAL_UTM_STRING) // whitespace-only
  })

  it('a present ad-level value WINS over the creative (Meta delivery order)', () => {
    expect(effectiveUrlTags(CANONICAL_UTM_STRING, 'utm_source=wrong')).toBe(CANONICAL_UTM_STRING)
  })

  it('both empty ⇒ null ⇒ missing (genuinely untracked)', () => {
    expect(effectiveUrlTags(null, null)).toBeNull()
    expect(validateUrlTags(effectiveUrlTags('', '')).verdict).toBe('missing')
  })
})

// ── Cohort-scoped launch verdict ──────────────────────────────────────────────────────────────────
describe('Launch-readiness verdict scopes to the launch cohort, not the whole account', () => {
  // Mixed historical shape. Without an approved plan, a synced optimization goal is an observation,
  // not proof that the goal is right or wrong for the intended outcome.
  const account = [
    { name: 'Cold Broad | Advantage+ | $40 (7-day)', status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', created: '2026-06-22' },
    { name: 'Warm Engagers | Retargeting | $45 (7-day)', status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', created: '2026-06-22' },
    { name: 'Interest Stack', status: 'PAUSED', optimization_goal: 'LANDING_PAGE_VIEWS', created: '2026-04-20' },
    { name: 'Auto Expand', status: 'PAUSED', optimization_goal: 'LANDING_PAGE_VIEWS', created: '2026-04-20' },
  ]

  it('scopes checks to the selected launch cohort (the 7-day ad sets)', () => {
    const v = assessLaunchCohort(bindNamedForTest(account, [account[0].name, account[1].name]))
    expect(v.launch_cohort.sort()).toEqual([
      'Cold Broad | Advantage+ | $40 (7-day)',
      'Warm Engagers | Retargeting | $45 (7-day)',
    ])
    expect(v.blockers).toHaveLength(0)
  })

  it('old paused/replaced LPV ad sets are HISTORICAL CLEANUP, never launch blockers', () => {
    const v = assessLaunchCohort(bindNamedForTest(account, [account[0].name, account[1].name]))
    expect(v.blockers.join(' ')).not.toMatch(/Interest Stack|Auto Expand/)
  })

  it('does not call an upper-funnel goal wrong without the approved plan outcome', () => {
    const bad = [{ name: 'Cold Launch | Wrong Objective (7-day)', status: 'PAUSED', optimization_goal: 'LANDING_PAGE_VIEWS', created: '2026-06-22' }]
    const v = assessLaunchCohort(bindAllForTest(bad))
    expect(v.ready).toBeNull()
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).toMatch(/LANDING_PAGE_VIEWS.*CampaignPlan/i)
  })

  it('does not condemn an active out-of-cohort goal without plan lineage', () => {
    const withActive = [
      ...bindNamedForTest(account, [account[0].name, account[1].name]),
      { name: 'Old LPV still ON', status: 'ACTIVE', optimization_goal: 'LANDING_PAGE_VIEWS', created: '2026-04-20', in_launch_cohort: false },
    ]
    const v = assessLaunchCohort(withActive)
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).not.toMatch(/Old LPV still ON/)
  })

  // The exact root-cause fix: a null/unsynced optimization goal on a launch ad set is UNVERIFIED, not a
  // confident "wrong event" blocker — and that makes the cohort verdict `ready: null`, not false.
  it('an UNSYNCED optimization goal on a launch ad set ⇒ unverified, NOT a blocker (ready: null)', () => {
    const v = assessLaunchCohort(bindAllForTest(
      [{ name: 'Cold Launch | goal not synced (7-day)', status: 'PAUSED', optimization_goal: null, created: '2026-06-22' }],
    ))
    expect(v.ready).toBeNull() // can't confirm — not a pass, not a fail
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).toMatch(/optimization goal not synced/i)
  })
})

// ── Effective-UTM resolution: read the REAL destination, incl. the video CTA link ──────────────────
describe('resolveEffectiveUtms reads UTMs from wherever Meta actually stores them', () => {
  const canonicalLink = `https://example-studio.test/book?${CANONICAL_UTM_STRING}`
  // A common launch shape: a VIDEO ad whose UTMs live in the CTA link, utm_campaign hardcoded.
  const hardcodedQuery = 'utm_source=meta&utm_medium=paid_social&utm_campaign=weekday_portrait_sessions&utm_content=clip_a&utm_term=broad_test'
  const videoOss = { video_data: { call_to_action: { type: 'BOOK_NOW', value: { link: `https://example-studio.test/book?${hardcodedQuery}` } } } }

  it('extracts the query string of the video CTA link (the case that kept reading as "no UTMs")', () => {
    const eff = resolveEffectiveUtms({ objectStorySpec: videoOss })
    expect(eff.captured).toBe(true)
    expect(eff.source).toBe('link')
    expect(eff.utms).toBe(hardcodedQuery)
    // …and it validates as MISCONFIGURED (hardcoded utm_campaign) — NOT missing, NOT correct.
    const val = validateUrlTags(eff.utms)
    expect(val.verdict).toBe('misconfigured')
    expect(val.defects.map((d) => d.code)).toContain('hardcoded_utm_campaign')
    // source/medium ARE correct, so paid attribution still works (only per-campaign granularity suffers).
    expect(val.defects.map((d) => d.code)).not.toContain('wrong_utm_source')
    expect(val.defects.map((d) => d.code)).not.toContain('wrong_utm_medium')
  })

  it('canonical UTMs in the CTA link ⇒ correct', () => {
    const eff = resolveEffectiveUtms({ objectStorySpec: { video_data: { call_to_action: { value: { link: canonicalLink } } } } })
    expect(eff.captured).toBe(true)
    expect(validateUrlTags(eff.utms).verdict).toBe('correct')
  })

  it('an explicit url_tags field WINS over the link query (delivery precedence)', () => {
    const eff = resolveEffectiveUtms({ adUrlTags: CANONICAL_UTM_STRING, objectStorySpec: videoOss })
    expect(eff.source).toBe('ad')
    expect(eff.utms).toBe(CANONICAL_UTM_STRING)
  })

  it('reads asset_feed_spec url_tags for Advantage+/dynamic creatives', () => {
    const eff = resolveEffectiveUtms({ assetFeedSpec: { link_urls: [{ website_url: 'https://example-studio.test/book', url_tags: CANONICAL_UTM_STRING }] } })
    expect(eff.source).toBe('asset_feed')
    expect(eff.utms).toBe(CANONICAL_UTM_STRING)
  })

  it('NOTHING synced (no url_tags, no link) ⇒ captured:false ⇒ the loader must say UNVERIFIED, not missing', () => {
    const eff = resolveEffectiveUtms({})
    expect(eff.captured).toBe(false)
    expect(eff.utms).toBeNull()
    expect(eff.source).toBe('none')
    // The loader maps !captured → 'unverified'; unverified is EXCLUDED from the coverage denominator
    // so an unreadable sync can never manufacture a false 0%.
    const stats = computeCoverageStats(['unverified'])
    expect(stats.adsUnverified).toBe(1)
    expect(stats.coverage).toBeNull()
  })

  it('a real destination link with NO query ⇒ captured:true but empty ⇒ genuinely MISSING', () => {
    const eff = resolveEffectiveUtms({ creativeLinkUrl: 'https://example-studio.test/book' })
    expect(eff.captured).toBe(true) // we DID sync a link to judge
    expect(eff.utms).toBeNull() // …it just has no UTMs
    expect(validateUrlTags(eff.utms).verdict).toBe('missing') // captured-but-empty is a real "missing", not "unverified"
    expect(queryStringOf('https://example-studio.test/book')).toBeNull()
  })
})

// ── The one structured verdict: honest about confirmed / unverified / blockers / cleanup ────────────
describe('buildLaunchVerdict synthesizes an honest, cohort-scoped verdict', () => {
  const hardcodedTags = 'utm_source=meta&utm_medium=paid_social&utm_campaign=weekday_portrait_sessions&utm_content=x&utm_term=y'

  function adHealth(id: string, tags: string | null, source: AdUtmHealth['tags_source'] = 'link'): AdUtmHealth {
    if (tags === null) {
      return { meta_ad_id: id, ad_name: id, campaign_name: 'Launch', effective_status: 'PAUSED', url_tags: null, tags_source: 'none', verdict: 'unverified', defects: [{ code: 'no_url_tags', detail: 'unverified' }], corrected: CANONICAL_UTM_STRING }
    }
    const v = validateUrlTags(tags)
    return { meta_ad_id: id, ad_name: id, campaign_name: 'Launch', effective_status: 'PAUSED', url_tags: tags, tags_source: source, verdict: v.verdict, defects: v.defects, corrected: v.corrected }
  }

  const okCohort = () => assessLaunchCohort(bindAllForTest(
    [
      { name: 'Cold Broad | Advantage+ | $40 (7-day)', status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', created: '2026-06-29' },
      { name: 'Warm Engagers | Retargeting | $45 (7-day)', status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', created: '2026-06-29' },
    ],
  ))

  it('a common launch shape: opt correct + hardcoded-campaign UTMs + dormant pixel ⇒ ready:null (unverified), NO blockers', () => {
    const v = buildLaunchVerdict({
      cohort: okCohort(),
      utmAds: [adHealth('a1', hardcodedTags), adHealth('a2', hardcodedTags)],
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'unverified', dormant: true, issues: ['dormant'] },
    })
    expect(v.ready).toBeNull() // the only thing unproven is the dormant pixel → unverified, not a fail
    expect(v.blockers).toHaveLength(0)
    expect(v.confirmed.join(' ')).not.toMatch(/Optimization event correct/i)
    // Source/medium tags prove only that paid-channel TELEMETRY can populate. They do not prove a
    // paid business outcome or causal attribution without the exact appointment-id join.
    expect(v.confirmed.join(' ')).toMatch(/paid-channel telemetry can populate/i)
    expect(v.confirmed.join(' ')).not.toMatch(/paid attribution works/i)
    expect(v.unverified.join(' ')).toMatch(/non-canonical/i)
    expect(v.before_launch.join(' ')).not.toMatch(/use utm_source|canonical UTM|string/i)
    expect(v.unverified.join(' ')).toMatch(/AppointmentConfirmed/i)
    expect(v.after_launch.join(' ')).toMatch(/Re-verify AppointmentConfirmed/i)
  })

  it('does not accept a caller-supplied manual pixel claim as durable launch evidence', () => {
    const input = {
      cohort: okCohort(),
      utmAds: [adHealth('a1', CANONICAL_UTM_STRING)],
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'unverified' as const, dormant: true, issues: ['dormant'] },
      manualPixelTestPassed: true,
    }
    const v = buildLaunchVerdict(input)
    expect(v.ready).toBeNull()
    expect(v.unverified.join(' ')).not.toMatch(/manual test confirms|owner.*confirms/i)
    expect(v.unverified.join(' ')).toMatch(/durable evidence/i)
  })

  it('legacy checks green but no approved page-aware CampaignPlan ⇒ ready:null', () => {
    const v = buildLaunchVerdict({
      cohort: okCohort(),
      utmAds: [adHealth('a1', CANONICAL_UTM_STRING), adHealth('a2', CANONICAL_UTM_STRING)],
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'healthy', dormant: false, issues: [] },
    })
    expect(v.ready).toBeNull()
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).toMatch(/approved CampaignPlan/i)
  })

  it('a caller cannot forge readiness with an unverified CampaignPlan-shaped object', () => {
    const v = buildLaunchVerdict({
      cohort: okCohort(),
      utmAds: [adHealth('a1', CANONICAL_UTM_STRING), adHealth('a2', CANONICAL_UTM_STRING)],
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'healthy', dormant: false, issues: [] },
      campaignPlan: {
        // Missing readinessContract on purpose: a shape-compatible object is not an approved plan.
        status: 'approved',
        planId: 'plan-1',
        contextVersionId: 'context-1',
        landingPageSnapshotId: 'page-1',
        confirmed: ['Objective, audience, page, offer, CTA, creative slots, and measurement are compatible.'],
        blockers: [],
        unverified: [],
      },
    } as Parameters<typeof buildLaunchVerdict>[0] & { campaignPlan: unknown })
    expect(v.ready).toBeNull()
    expect(v.unverified.join(' ')).toMatch(/approved CampaignPlan/i)
  })

  it('without a stored plan, missing legacy UTMs are observed but cannot prescribe the final tracking contract', () => {
    const v = buildLaunchVerdict({
      cohort: okCohort(),
      utmAds: [adHealth('a1', '')], // captured-but-empty ⇒ missing
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'healthy', dormant: false, issues: [] },
    })
    expect(v.ready).toBeNull()
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).toMatch(/no readable UTMs/i)
    expect(v.unverified.join(' ')).toMatch(/ID-inclusive tracking contract/i)
  })

  it('a synced LPV goal remains unverified without a plan even with perfect UTMs + healthy pixel', () => {
    const cohort = assessLaunchCohort(bindAllForTest(
      [{ name: 'Cold Launch | Wrong Objective (7-day)', status: 'PAUSED', optimization_goal: 'LANDING_PAGE_VIEWS', created: '2026-06-22' }],
    ))
    const v = buildLaunchVerdict({
      cohort,
      utmAds: [adHealth('a1', CANONICAL_UTM_STRING)],
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'healthy', dormant: false, issues: [] },
    })
    expect(v.ready).toBeNull()
    expect(v.blockers).toHaveLength(0)
    expect(v.unverified.join(' ')).toMatch(/LANDING_PAGE_VIEWS.*CampaignPlan/i)
  })

  it('unread launch UTMs are UNVERIFIED, never counted as a blocker', () => {
    const v = buildLaunchVerdict({
      cohort: okCohort(),
      utmAds: [adHealth('a1', null)], // verdict 'unverified'
      utmCoverageScope: 'launch_cohort',
      tracking: { status: 'healthy', dormant: false, issues: [] },
    })
    expect(v.blockers).toHaveLength(0)
    expect(v.ready).toBeNull()
    expect(v.unverified.join(' ')).toMatch(/could not be read/i)
  })
})
