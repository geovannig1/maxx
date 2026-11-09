import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  foldStatsPage, isSupportedAggregation, SUPPORTED_QUALITY_AGGREGATIONS,
  OTHER_DOCUMENTED_AGGREGATIONS, EMQ_NOTE,
} from '@/lib/platforms/meta/fetch-dataset-quality'
import {
  STATS_MATCH_KEYS, STATS_HAD_PII, STATS_EVENT_SOURCE, STATS_PROCESSING_RESULTS,
  STATS_EMPTY, STATS_NO_DATA_KEY, STATS_INNER_NOT_ARRAY, STATS_NULL_BUCKET,
} from './_support/meta-fixtures'

// The fetcher used to request `aggregation=event_match_quality` and read a `match_quality` field.
// Verified against Meta's official Ads Pixel stats reference (Marketing API v25.0, 2026-07-26), that
// aggregation does not exist and that field is never returned — so the request could only ever
// produce a fabricated or empty EMQ. EMQ is now owner-observed in Events Manager, full stop.

// The verbatim documented enum. Kept here so a future edit that adds an aggregation must first prove
// it against this list.
const DOCUMENTED_ENUM = [
  'browser_type', 'custom_data_field', 'device_os', 'device_type', 'event', 'host', 'match_keys',
  'had_pii', 'pixel_fire', 'event_detection_method', 'url', 'event_value_count', 'url_by_rule',
  'event_total_counts', 'event_source', 'event_processing_results',
]

describe('dataset stats — only documented aggregations may be requested', () => {
  it('every aggregation this module requests is in the documented enum', () => {
    for (const agg of SUPPORTED_QUALITY_AGGREGATIONS) expect(DOCUMENTED_ENUM).toContain(agg)
  })

  it('covers the match-key, PII-presence, event-source and processing-result dimensions', () => {
    expect([...SUPPORTED_QUALITY_AGGREGATIONS].sort()).toEqual(
      ['event_processing_results', 'event_source', 'had_pii', 'match_keys'],
    )
  })

  it('the documented-but-unused list stays inside the enum too', () => {
    for (const agg of OTHER_DOCUMENTED_AGGREGATIONS) expect(DOCUMENTED_ENUM).toContain(agg)
  })

  it('REJECTS event_match_quality — it is not a real aggregation', () => {
    expect(isSupportedAggregation('event_match_quality')).toBe(false)
    expect(DOCUMENTED_ENUM).not.toContain('event_match_quality')
  })

  it('rejects other invented aggregation names', () => {
    for (const bad of ['emq', 'match_quality', 'event_quality', 'signal_quality']) {
      expect(isSupportedAggregation(bad)).toBe(false)
    }
  })

  it('the invalid request path is GONE from the source — no event_match_quality request remains', () => {
    // Behavioural tests cannot observe a request that is never made, so this one guards the source.
    const src = readFileSync(resolve(process.cwd(), 'src/lib/platforms/meta/fetch-dataset-quality.ts'), 'utf8')
    // The string may appear in the explanatory comment and the rejection list, but never as a value
    // handed to metaGet.
    expect(src).not.toMatch(/aggregation:\s*['"]event_match_quality['"]/)
    expect(src).not.toMatch(/match_quality:/)
  })
})

describe('EMQ policy', () => {
  it('the note states EMQ is owner-observed and must never be derived', () => {
    expect(EMQ_NOTE).toMatch(/NOT available from the Marketing API/i)
    expect(EMQ_NOTE).toMatch(/OWNER-OBSERVED/i)
    expect(EMQ_NOTE).toMatch(/Never derive one from coverage or processing stats/i)
  })
})

describe('foldStatsPage — the verified result-node shape', () => {
  it('sums hourly buckets per dimension value and ranks them', () => {
    const { buckets, violation } = foldStatsPage('/stats?match_keys', STATS_MATCH_KEYS)
    expect(violation).toBeUndefined()
    expect(buckets.map((b) => [b.value, b.count])).toEqual([['em', 200], ['fbp', 60], ['fbc', 15]])
  })

  it('computes share of the aggregation total', () => {
    const { buckets } = foldStatsPage('/stats?match_keys', STATS_MATCH_KEYS)
    const total = 200 + 60 + 15
    expect(buckets[0].share).toBeCloseTo(200 / total, 10)
    expect(buckets.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 10)
  })

  it('folds had_pii, event_source and event_processing_results', () => {
    expect(foldStatsPage('/x', STATS_HAD_PII).buckets.map((b) => b.value)).toEqual(['true', 'false'])
    expect(foldStatsPage('/x', STATS_EVENT_SOURCE).buckets.map((b) => b.value)).toEqual(['website', 'server'])
    expect(foldStatsPage('/x', STATS_PROCESSING_RESULTS).buckets.map((b) => b.value))
      .toEqual(['processed', 'deduplicated', 'dropped'])
  })

  it('an empty page yields no buckets and no violation', () => {
    const r = foldStatsPage('/x', STATS_EMPTY)
    expect(r.buckets).toEqual([])
    expect(r.violation).toBeUndefined()
  })

  it('fails closed on a missing data key', () => {
    const r = foldStatsPage('/x', STATS_NO_DATA_KEY)
    expect(r.buckets).toEqual([])
    expect(r.violation?.errorClass).toBe('missing_data_array')
  })

  it('fails closed on a non-array inner data', () => {
    expect(foldStatsPage('/x', STATS_INNER_NOT_ARRAY).violation?.errorClass).toBe('unexpected_data_shape')
  })

  it('fails closed on a null bucket', () => {
    expect(foldStatsPage('/x', STATS_NULL_BUCKET).violation?.errorClass).toBe('unexpected_data_shape')
  })

  it('a parse failure yields NO buckets — never a zero-filled "successful" record', () => {
    const r = foldStatsPage('/x', STATS_NO_DATA_KEY)
    expect(r.buckets).toHaveLength(0)
    expect(r.violation).toBeDefined()
  })

  it('ignores entries with no usable value', () => {
    const r = foldStatsPage('/x', { data: [{ data: [{ value: '', count: 5 }, { value: 'ph', count: 3 }] }] })
    expect(r.buckets.map((b) => [b.value, b.count])).toEqual([['ph', 3]])
  })

  // A MISSING numeric count used to be coerced to 0, turning an unreadable payload into a
  // confident "this dimension had no events".
  it('a MISSING numeric count is a contract violation, NOT zero', () => {
    const r = foldStatsPage('/x', { data: [{ data: [{ value: 'em' }, { value: 'ph', count: 3 }] }] })
    expect(r.buckets).toEqual([])
    expect(r.violation?.errorClass).toBe('missing_numeric_count')
  })

  it('a non-numeric or NaN count is also a violation', () => {
    expect(foldStatsPage('/x', { data: [{ data: [{ value: 'em', count: '5' }] }] }).violation?.errorClass).toBe('missing_numeric_count')
    expect(foldStatsPage('/x', { data: [{ data: [{ value: 'em', count: NaN }] }] }).violation?.errorClass).toBe('missing_numeric_count')
  })

  it('every violation carries endpoint + API version', () => {
    const v = foldStatsPage('/stats?had_pii', STATS_NO_DATA_KEY).violation!
    expect(v.endpoint).toBe('/stats?had_pii')
    expect(v.apiVersion).toMatch(/^v\d+\.\d+$/)
  })
})
