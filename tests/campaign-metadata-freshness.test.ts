import { describe, it, expect } from 'vitest'
import { classifyCampaignMetadata, type CampaignMetaRow } from '@/lib/flags/engine'

// Freshness-gated CBO/ABO classification. fetchCampaigns only returns ACTIVE/PAUSED campaigns,
// so an archived/deleted campaign keeps a stale metadata row forever; classifying budget structure from
// it could create or suppress budget decisions off dead data. Timestamps compare as PARSED epochs
// (never lexically), and unresolvedReferenced includes STALE and MISSING referenced campaigns alike so a
// suppressed budget evaluation can never report a green sync.

const BOUNDARY = '2026-07-19T06:00:00Z'
const row = (id: string, daily: number | null, lifetime: number | null, synced: string | null): CampaignMetaRow =>
  ({ id, daily_budget: daily, lifetime_budget: lifetime, last_synced_at: synced })

describe('classifyCampaignMetadata - freshness-gated, fail-closed', () => {
  it('fresh rows classify: CBO joins cbo, ABO leaves unknown; both count as KNOWN', () => {
    const { cbo, unknown, unresolvedReferenced } = classifyCampaignMetadata(
      [row('c1', 100, null, '2026-07-19T06:05:00Z'), row('c2', null, null, '2026-07-19T06:05:00Z')],
      new Set(['c1', 'c2']),
      BOUNDARY
    )
    expect(cbo.has('c1')).toBe(true)       // daily budget -> CBO
    expect(cbo.has('c2')).toBe(false)      // both budgets null -> ABO
    expect(unknown.size).toBe(0)           // both KNOWN (fresh)
    expect(unresolvedReferenced).toEqual([])
  })

  it('a STALE referenced row stays unknown (frozen) and is reported UNRESOLVED', () => {
    const { cbo, unknown, unresolvedReferenced } = classifyCampaignMetadata(
      [row('c1', 100, null, '2026-07-19T05:00:00Z')], // refreshed BEFORE the boundary
      new Set(['c1']),
      BOUNDARY
    )
    expect(cbo.has('c1')).toBe(false)      // stale CBO metadata must NOT classify
    expect(unknown.has('c1')).toBe(true)   // frozen: preserve, create nothing
    expect(unresolvedReferenced).toEqual(['c1'])
  })

  it('a MISSING referenced row is UNRESOLVED too (missing must not report green)', () => {
    const { unknown, unresolvedReferenced } = classifyCampaignMetadata([], new Set(['ghost']), BOUNDARY)
    expect(unknown.has('ghost')).toBe(true)
    expect(unresolvedReferenced).toEqual(['ghost'])
  })

  it('a NULL boundary disables budget evaluation: everything unknown AND unresolved', () => {
    const { cbo, unknown, unresolvedReferenced } = classifyCampaignMetadata(
      [row('c1', 100, null, '2026-07-19T06:05:00Z')], // even a perfectly fresh row
      new Set(['c1']),
      null
    )
    expect(cbo.size).toBe(0)
    expect(unknown.has('c1')).toBe(true)
    expect(unresolvedReferenced).toEqual(['c1'])
  })

  it('zero-valued NON-NULL budget is CBO (mirrors campaignIsCbo / the RPC predicate)', () => {
    const { cbo } = classifyCampaignMetadata([row('c1', 0, null, '2026-07-19T06:05:00Z')], new Set(['c1']), BOUNDARY)
    expect(cbo.has('c1')).toBe(true)
  })

  it('null last_synced_at is treated as stale (never fresh)', () => {
    const { cbo, unknown } = classifyCampaignMetadata([row('c1', 100, null, null)], new Set(['c1']), BOUNDARY)
    expect(cbo.has('c1')).toBe(false)
    expect(unknown.has('c1')).toBe(true)
  })

  it('EQUIVALENT timestamp formats classify identically (epoch compare, not lexical)', () => {
    // Same instant as BOUNDARY written three ways - lexical string compare would misorder
    // '+00:00' vs 'Z' and fractional variants; epoch parsing must not.
    for (const synced of ['2026-07-19T06:00:00+00:00', '2026-07-19T06:00:00.000Z', '2026-07-19T07:00:00+01:00']) {
      const { cbo, unknown } = classifyCampaignMetadata([row('c1', 100, null, synced)], new Set(['c1']), BOUNDARY)
      expect(cbo.has('c1'), `synced=${synced}`).toBe(true) // exactly-at-boundary is fresh
      expect(unknown.size).toBe(0)
    }
    // And an offset-written boundary against a Z-written stamp.
    const { cbo } = classifyCampaignMetadata(
      [row('c1', 100, null, '2026-07-19T06:00:01Z')], new Set(['c1']), '2026-07-19T07:00:00+01:00')
    expect(cbo.has('c1')).toBe(true)
  })

  it('INVALID timestamps fail closed: bad last_synced_at = stale; bad boundary = evaluation disabled', () => {
    const badStamp = classifyCampaignMetadata([row('c1', 100, null, 'not-a-date')], new Set(['c1']), BOUNDARY)
    expect(badStamp.cbo.size).toBe(0)
    expect(badStamp.unknown.has('c1')).toBe(true)
    const badBoundary = classifyCampaignMetadata([row('c1', 100, null, '2026-07-19T06:05:00Z')], new Set(['c1']), 'garbage')
    expect(badBoundary.cbo.size).toBe(0)
    expect(badBoundary.unresolvedReferenced).toEqual(['c1'])
  })
})
