import { describe, it, expect } from 'vitest'
import {
  CANONICAL_UTM_STRING,
  validateUrlTags,
  computeCoverageStats,
  assessBookingLinkage,
  BOOKING_LINKAGE_CHECKLIST,
} from '@/lib/tracking/utm-validator'
import { detectUtmCoverage } from '@/lib/monitoring/detectors'

// A synthetic misconfigured string combining the common hand-typed defects: a backwards source, a
// hardcoded campaign, a missing utm_term and a raw %3F.
const BROKEN_STRING =
  'utm_source={{campaign.name}}&utm_medium=paid_social&utm_campaign=spring_promo&utm_content={{ad.name}}&%3Futm_source=meta'

describe('validateUrlTags', () => {
  it('null / empty → missing, with the canonical corrected string', () => {
    for (const v of [null, undefined, '', '   ']) {
      const r = validateUrlTags(v)
      expect(r.verdict).toBe('missing')
      expect(r.defects.map((d) => d.code)).toEqual(['no_url_tags'])
      expect(r.corrected).toBe(CANONICAL_UTM_STRING)
    }
  })

  it('flags all four defects on a misconfigured string', () => {
    const r = validateUrlTags(BROKEN_STRING)
    expect(r.verdict).toBe('misconfigured')
    const codes = r.defects.map((d) => d.code)
    expect(codes).toContain('wrong_utm_source') // utm_source={{campaign.name}} — backwards
    expect(codes).toContain('hardcoded_utm_campaign') // utm_campaign=spring_promo
    expect(codes).toContain('encoded_question_mark') // &%3Futm_source=meta corruption
    expect(codes).toContain('missing_param') // utm_term absent
    expect(r.defects.find((d) => d.code === 'missing_param')?.param).toBe('utm_term')
    expect(r.corrected).toBe(CANONICAL_UTM_STRING)
  })

  it('accepts the canonical string with dynamic placeholders', () => {
    const r = validateUrlTags(CANONICAL_UTM_STRING)
    expect(r.verdict).toBe('correct')
    expect(r.defects).toEqual([])
  })

  it('accepts {{site_source_name}} as a blessed utm_source alternative', () => {
    const r = validateUrlTags(CANONICAL_UTM_STRING.replace('utm_source=meta', 'utm_source={{site_source_name}}'))
    expect(r.verdict).toBe('correct')
  })

  it('accepts facebook/instagram sources but rejects arbitrary values', () => {
    expect(validateUrlTags(CANONICAL_UTM_STRING.replace('utm_source=meta', 'utm_source=facebook')).verdict).toBe('correct')
    const bad = validateUrlTags(CANONICAL_UTM_STRING.replace('utm_source=meta', 'utm_source=newsletter'))
    expect(bad.verdict).toBe('misconfigured')
    expect(bad.defects.map((d) => d.code)).toContain('wrong_utm_source')
  })

  it('flags a leading "?" (Meta appends its own — this is how %3F was born)', () => {
    const r = validateUrlTags(`?${CANONICAL_UTM_STRING}`)
    expect(r.defects.map((d) => d.code)).toContain('leading_question_mark')
    expect(r.verdict).toBe('misconfigured')
  })

  it('missing utm_term alone makes the ad misconfigured (coverage = fully canonical)', () => {
    const r = validateUrlTags(CANONICAL_UTM_STRING.replace('&utm_term={{adset.name}}', ''))
    expect(r.verdict).toBe('misconfigured')
    expect(r.defects).toEqual([expect.objectContaining({ code: 'missing_param', param: 'utm_term' })])
  })

  it('accepts {{campaign.id}} as a dynamic utm_campaign variant', () => {
    const r = validateUrlTags(CANONICAL_UTM_STRING.replace('utm_campaign={{campaign.name}}', 'utm_campaign={{campaign.id}}'))
    expect(r.verdict).toBe('correct')
  })

  it('flags duplicate params', () => {
    const r = validateUrlTags(`${CANONICAL_UTM_STRING}&utm_source=meta`)
    expect(r.defects.map((d) => d.code)).toContain('duplicate_param')
    expect(r.verdict).toBe('misconfigured')
  })
})

describe('computeCoverageStats', () => {
  it('counts verdicts and computes coverage (3 correct / 18 total ≈ 17%)', () => {
    const verdicts = [
      ...Array<'correct'>(3).fill('correct'),
      ...Array<'missing'>(14).fill('missing'),
      ...Array<'misconfigured'>(1).fill('misconfigured'),
    ]
    const s = computeCoverageStats(verdicts)
    expect(s).toEqual({ adsTotal: 18, adsCorrect: 3, adsMissing: 14, adsMisconfigured: 1, adsUnverified: 0, coverage: 3 / 18 })
  })

  it('excludes UNVERIFIED ads from the coverage denominator (an unreadable sync cannot fake a 0%)', () => {
    // 2 correct, 0 missing, 3 unverified ⇒ coverage judged over the 2 readable ads = 100%, not 2/5.
    const s = computeCoverageStats(['correct', 'correct', 'unverified', 'unverified', 'unverified'])
    expect(s.adsUnverified).toBe(3)
    expect(s.coverage).toBe(1)
  })

  it('coverage is null when there are no ads to judge', () => {
    expect(computeCoverageStats([]).coverage).toBeNull()
  })
})

describe('detectUtmCoverage', () => {
  it('silent at zero ads (pre-launch) and at full coverage', () => {
    expect(detectUtmCoverage({ adsTotal: 0, adsCorrect: 0 })).toBeNull()
    expect(detectUtmCoverage({ adsTotal: 5, adsCorrect: 5 })).toBeNull()
  })

  it('warns with counts and a stable count-state dedupe key below full coverage', () => {
    const f = detectUtmCoverage({ adsTotal: 18, adsCorrect: 3 })
    expect(f?.severity).toBe('warning')
    expect(f?.area).toBe('utm_coverage')
    expect(f?.message).toContain('15 of 18')
    expect(f?.dedupeKey).toBe('cov_3_18')
    // A new untracked active ad changes the count-state → new dedupe key → fresh alert.
    expect(detectUtmCoverage({ adsTotal: 19, adsCorrect: 3 })?.dedupeKey).toBe('cov_3_19')
  })
})

describe('assessBookingLinkage', () => {
  it('suspects a cross-domain break only at high coverage + ~zero share + enough purchases', () => {
    const r = assessBookingLinkage({ utmCoverage: 1, attributedShare: 0.02, totalPurchases: 12 })
    expect(r.suspected).toBe(true)
    expect(r.label).toBe('ASSUMPTION')
    expect(r.checklist).toBe(BOOKING_LINKAGE_CHECKLIST)
  })

  it('does not suspect linkage when UTMs are the problem (low coverage)', () => {
    const r = assessBookingLinkage({ utmCoverage: 0.06, attributedShare: 0.02, totalPurchases: 12 })
    expect(r.suspected).toBe(false)
    expect(r.rationale).toContain('fix the ad URL parameters first')
  })

  it('holds below the 5-purchase sample floor', () => {
    expect(assessBookingLinkage({ utmCoverage: 1, attributedShare: 0, totalPurchases: 3 }).suspected).toBe(false)
  })

  it('does not suspect when attribution is flowing, and cannot assess on unknown inputs', () => {
    expect(assessBookingLinkage({ utmCoverage: 1, attributedShare: 0.7, totalPurchases: 12 }).suspected).toBe(false)
    expect(assessBookingLinkage({ utmCoverage: null, attributedShare: 0.7, totalPurchases: 12 }).rationale).toContain('Cannot assess')
    expect(assessBookingLinkage({ utmCoverage: 1, attributedShare: null, totalPurchases: 12 }).rationale).toContain('Cannot assess')
  })
})
