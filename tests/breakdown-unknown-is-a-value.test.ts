import { describe, it, expect } from 'vitest'
import { buildBreakdownRow } from '@/lib/platforms/meta/fetch-breakdowns'
import type { MetaBreakdownRecord } from '@/lib/platforms/meta/fetch-breakdowns'

/**
 * Meta returns the literal string "unknown" as a real publisher_platform bucket: the field is
 * present, and its value can be "unknown" for an ad set.
 *
 * An ingest guard that treats that value as unreadable and throws fails the
 * executive-placements step, holds every sync at `partial`, freezes the last-successful-sync
 * clock, and quarantines the recommendation feed. A value Meta reported is an
 * observation; only an ABSENT field is a contract violation.
 */

function record(overrides: Partial<MetaBreakdownRecord> = {}): MetaBreakdownRecord {
  return {
    adset_id: '100000000000000012',
    campaign_id: '100000000000000011',
    impressions: '1000',
    spend: '12.34',
    clicks: '20',
    ctr: '2.0',
    ...overrides,
  } as MetaBreakdownRecord
}

describe('buildBreakdownRow — reported vs absent dimension values', () => {
  it('keeps Meta\'s literal "unknown" placement as an observed value', () => {
    const row = buildBreakdownRow(
      record({ publisher_platform: 'unknown' }),
      'adset',
      'publisher_platform',
    )
    expect(row.breakdown_value).toBe('unknown')
    expect(row.spend).toBe(12.34)
  })

  it('keeps ordinary placement values unchanged', () => {
    for (const value of ['facebook', 'instagram', 'threads', 'audience_network']) {
      const row = buildBreakdownRow(
        record({ publisher_platform: value }),
        'adset',
        'publisher_platform',
      )
      expect(row.breakdown_value).toBe(value)
    }
  })

  it('still rejects a dimension Meta did not report at all', () => {
    expect(() => buildBreakdownRow(record(), 'adset', 'publisher_platform'))
      .toThrow(/publisher_platform value is missing/)
  })

  it('still rejects a blank dimension value', () => {
    expect(() => buildBreakdownRow(
      record({ publisher_platform: '   ' }),
      'adset',
      'publisher_platform',
    )).toThrow(/publisher_platform value is missing/)
  })

  it('applies the same rule to platform_position, the other placement dimension', () => {
    const row = buildBreakdownRow(
      record({ platform_position: 'unknown' }),
      'adset',
      'platform_position',
    )
    expect(row.breakdown_value).toBe('unknown')
    expect(() => buildBreakdownRow(record(), 'adset', 'platform_position'))
      .toThrow(/platform_position value is missing/)
  })
})
