import { describe, it, expect } from 'vitest'
import { parseRecommendationsPage, isStaleRecommendation } from '@/lib/platforms/meta/parse-recommendations'
import { redactDetail, requireDataArray } from '@/lib/platforms/meta/contract'
import {
  RECS_NESTED_SINGLE_GROUP, RECS_MULTIPLE_GROUPS, RECS_MISSING_OPTIONAL_FIELDS, RECS_BUSINESS_LEVEL,
  RECS_EMPTY_PAGE, RECS_EMPTY_NESTED, RECS_MALFORMED_TOP_LEVEL, RECS_NOT_AN_OBJECT, RECS_NO_DATA_KEY,
  RECS_DATA_NOT_ARRAY, RECS_WITH_PAGING,
} from './_support/meta-fixtures'

// The old mapper read title/message/code/importance at the TOP level of data[]. The real payload
// nests them under data[].recommendations[].recommendation_content, so every record became an
// all-null object and the caller reported `available: true` with a list of empty results — a silent
// contract break that read as a clean, empty account state.

describe('parseRecommendationsPage — the real nested shape', () => {
  it('flattens data[].recommendations[] and preserves every documented field', () => {
    const r = parseRecommendationsPage(RECS_NESTED_SINGLE_GROUP)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recommendations).toHaveLength(1)
    const rec = r.value.recommendations[0]
    expect(rec.objectIds).toEqual(['100000000000000003'])
    expect(rec.type).toBe('AUDIENCE_CONSOLIDATION')
    expect(rec.stage).toBe('AVAILABLE')
    expect(rec.url).toBe('https://adsmanager.example.invalid/recommendation/1')
    expect(rec.body).toMatch(/Consolidate ad sets/)
    expect(rec.liftEstimate).toBe(0.14)
    expect(rec.opportunityScoreLift).toBe(6.2)
    expect(rec.recommendationTime).toBe('2026-07-24T09:15:00.000Z')
  })

  it('regression: NOT every field is null (the exact old-parser defect)', () => {
    const r = parseRecommendationsPage(RECS_NESTED_SINGLE_GROUP)
    if (!r.ok) throw new Error('expected ok')
    const rec = r.value.recommendations[0]
    const allNull = Object.values(rec).every((v) => v === null || (Array.isArray(v) && v.length === 0))
    expect(allNull).toBe(false)
  })

  it('flattens MULTIPLE groups into one ordered list', () => {
    const r = parseRecommendationsPage(RECS_MULTIPLE_GROUPS)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.groupCount).toBe(2)
    expect(r.value.recommendations.map((x) => x.type)).toEqual([
      'CREATIVE_DIVERSIFICATION', 'BUDGET_SCALE', 'PLACEMENT_EXPANSION',
    ])
  })

  it('keeps multiple object ids', () => {
    const r = parseRecommendationsPage(RECS_MULTIPLE_GROUPS)
    if (!r.ok) throw new Error('expected ok')
    expect(r.value.recommendations[0].objectIds).toEqual(['100000000000000003', '100000000000000004'])
  })

  it('missing optional fields stay NULL — never defaulted to 0 or a placeholder', () => {
    const r = parseRecommendationsPage(RECS_MISSING_OPTIONAL_FIELDS)
    if (!r.ok) throw new Error('expected ok')
    const rec = r.value.recommendations[0]
    expect(rec.liftEstimate).toBeNull()
    expect(rec.opportunityScoreLift).toBeNull()
    expect(rec.url).toBeNull()
    expect(rec.recommendationTime).toBeNull()
    expect(rec.objectIds).toEqual([])
    // ...but the substance that IS present survives.
    expect(rec.type).toBe('AUDIENCE_REVIEW')
    expect(rec.body).toMatch(/Review the audience definition/)
  })

  it('accepts the business-level variant (recommendation_name + level, no type)', () => {
    const r = parseRecommendationsPage(RECS_BUSINESS_LEVEL)
    if (!r.ok) throw new Error('expected ok')
    const rec = r.value.recommendations[0]
    expect(rec.type).toBeNull()
    expect(rec.name).toBe('Campaign consolidation')
    expect(rec.level).toBe('CAMPAIGN')
  })

  it('an EMPTY page is a valid state, not a failure', () => {
    const r = parseRecommendationsPage(RECS_EMPTY_PAGE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recommendations).toEqual([])
    expect(r.value.groupCount).toBe(0)
    expect(r.value.violations).toEqual([])
  })

  it('a group with an empty nested list is also a valid state', () => {
    const r = parseRecommendationsPage(RECS_EMPTY_NESTED)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recommendations).toEqual([])
    expect(r.value.groupCount).toBe(1)
  })

  it('tolerates a paging block without following it', () => {
    const r = parseRecommendationsPage(RECS_WITH_PAGING)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recommendations).toHaveLength(1)
  })
})

describe('parseRecommendationsPage — fails closed', () => {
  it('records present but NONE valid => failure, never "0 recommendations"', () => {
    const r = parseRecommendationsPage(RECS_MALFORMED_TOP_LEVEL)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.violation.errorClass).toBe('no_valid_records')
    expect(r.violation.detail).toMatch(/none matched the expected recommendation shape/)
  })

  it('a non-object body fails closed', () => {
    const r = parseRecommendationsPage(RECS_NOT_AN_OBJECT)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violation.errorClass).toBe('not_an_object')
  })

  it('a missing data key fails closed', () => {
    const r = parseRecommendationsPage(RECS_NO_DATA_KEY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violation.errorClass).toBe('missing_data_array')
  })

  it('a non-array data key fails closed', () => {
    const r = parseRecommendationsPage(RECS_DATA_NOT_ARRAY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violation.errorClass).toBe('missing_data_array')
  })

  it('null and undefined bodies fail closed', () => {
    expect(parseRecommendationsPage(null).ok).toBe(false)
    expect(parseRecommendationsPage(undefined).ok).toBe(false)
  })

  it('every violation carries the endpoint and API version for audit', () => {
    const r = parseRecommendationsPage(RECS_NOT_AN_OBJECT)
    if (r.ok) throw new Error('expected failure')
    expect(r.violation.endpoint).toBe('/act_{account}/recommendations')
    expect(r.violation.apiVersion).toMatch(/^v\d+\.\d+$/)
    expect(r.violation.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('a partially valid page surfaces per-record violations without discarding good records', () => {
    const mixed = {
      data: [
        { recommendations: [RECS_NESTED_SINGLE_GROUP.data[0].recommendations[0], { junk: true }] },
      ],
    }
    const r = parseRecommendationsPage(mixed)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.recommendations).toHaveLength(1)
    expect(r.value.violations).toHaveLength(1)
    expect(r.value.violations[0].errorClass).toBe('unexpected_data_shape')
  })
})

describe('isStaleRecommendation — advisory evidence can go stale', () => {
  const NOW = Date.parse('2026-07-26T00:00:00Z')
  const rec = (time: string | null) => ({
    objectIds: [], type: 'X', name: null, level: null, stage: null,
    recommendationTime: time, url: null, body: 'b', liftEstimate: null, opportunityScoreLift: null,
  })

  it('a recent recommendation is fresh', () => {
    expect(isStaleRecommendation(rec('2026-07-24T00:00:00Z'), NOW)).toBe(false)
  })

  it('an old recommendation is stale', () => {
    expect(isStaleRecommendation(rec('2026-06-01T00:00:00Z'), NOW)).toBe(true)
  })

  it('an UNKNOWN time is treated as stale, never as fresh', () => {
    expect(isStaleRecommendation(rec(null), NOW)).toBe(true)
  })
})

describe('contract redaction — no token, signed URL, or PII may reach a log or store', () => {
  it('strips URLs (signed paging URLs embed access tokens)', () => {
    expect(redactDetail('failed at https://graph.facebook.com/v25.0/x?access_token=EAABBCCDD'))
      .not.toMatch(/graph\.facebook\.com/)
  })

  it('strips access_token assignments and long EA tokens', () => {
    expect(redactDetail('access_token=EAAsomethingveryverylongtoken123456')).not.toMatch(/EAAsomethingvery/)
    expect(redactDetail('bare EAABBCCDDEEFFGGHHIIJJKKLLMMNN token')).toMatch(/\[token-redacted\]/)
  })

  it('strips e-mail addresses', () => {
    expect(redactDetail('rejected value for person@example.com')).toMatch(/\[email-redacted\]/)
  })

  it('truncates long details', () => {
    expect(redactDetail('x'.repeat(500)).length).toBeLessThanOrEqual(201)
  })
})

describe('requireDataArray', () => {
  it('accepts a well-formed envelope', () => {
    const r = requireDataArray('/x', { data: [1, 2] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual([1, 2])
  })
  it('rejects arrays at the top level', () => {
    expect(requireDataArray('/x', [{ data: [] }]).ok).toBe(false)
  })
})
