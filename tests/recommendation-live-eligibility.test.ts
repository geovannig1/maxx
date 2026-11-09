import { describe, expect, it } from 'vitest'
import {
  recommendationTargetsCurrentOperatingEntity,
  type OperatingEntitySnapshot,
} from '@/lib/recommendations/live-eligibility'

const NOW = Date.parse('2026-07-30T16:00:00Z')
const FRESH = '2026-07-30T15:00:00Z'
const STALE = '2026-07-28T12:00:00Z'

function snapshot(): OperatingEntitySnapshot {
  return {
    campaigns: new Map([
      ['campaign-active', {
        id: 'campaign-active', status: 'ACTIVE', effectiveStatus: 'ACTIVE', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
      ['campaign-paused', {
        id: 'campaign-paused', status: 'PAUSED', effectiveStatus: 'PAUSED', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
    ]),
    adsets: new Map([
      ['adset-active', {
        id: 'adset-active', campaignId: 'campaign-active', status: 'ACTIVE',
        effectiveStatus: 'ACTIVE', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
      ['adset-paused', {
        id: 'adset-paused', campaignId: 'campaign-active', status: 'PAUSED',
        effectiveStatus: 'PAUSED', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
      ['adset-parent-paused', {
        id: 'adset-parent-paused', campaignId: 'campaign-paused', status: 'ACTIVE',
        effectiveStatus: 'CAMPAIGN_PAUSED', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
    ]),
    ads: new Map([
      ['ad-active', {
        id: 'ad-active', campaignId: 'campaign-active', adsetId: 'adset-active', status: 'ACTIVE',
        effectiveStatus: 'ACTIVE', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
      ['ad-paused', {
        id: 'ad-paused', campaignId: 'campaign-active', adsetId: 'adset-active', status: 'PAUSED',
        effectiveStatus: 'PAUSED', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
      ['ad-parent-paused', {
        id: 'ad-parent-paused', campaignId: 'campaign-paused', adsetId: 'adset-parent-paused', status: 'ACTIVE',
        effectiveStatus: 'CAMPAIGN_PAUSED', lastSyncedAt: FRESH, lastMaterialChangeAt: FRESH,
      }],
    ]),
  }
}

describe('current operating recommendation eligibility', () => {
  it('keeps account recommendations and fresh active entity chains', () => {
    const entities = snapshot()

    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'investigate', targetEntityType: 'account', targetEntityId: null },
      entities,
      NOW,
    )).toBe(true)
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'keep', targetEntityType: 'ad', targetEntityId: 'ad-active' },
      entities,
      NOW,
    )).toBe(true)
  })

  it('does not apply Meta delivery lifecycle rules to non-Meta diagnostic targets', () => {
    const entities = snapshot()

    for (const [targetEntityType, targetEntityId] of [
      ['none', null],
      ['audience', 'audience-1'],
      ['creative', 'creative-1'],
    ] as const) {
      expect(recommendationTargetsCurrentOperatingEntity(
        { recommendationType: 'investigate', targetEntityType, targetEntityId },
        entities,
        NOW,
      ), targetEntityType).toBe(true)
    }
  })

  it('quarantines paused targets from the live operating feed', () => {
    const entities = snapshot()

    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'keep', targetEntityType: 'ad', targetEntityId: 'ad-paused' },
      entities,
      NOW,
    )).toBe(false)
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'pause', targetEntityType: 'adset', targetEntityId: 'adset-paused' },
      entities,
      NOW,
    )).toBe(false)
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'scale', targetEntityType: 'campaign', targetEntityId: 'campaign-paused' },
      entities,
      NOW,
    )).toBe(false)
  })

  it('quarantines active children when a parent is not actively delivering', () => {
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'keep', targetEntityType: 'ad', targetEntityId: 'ad-parent-paused' },
      snapshot(),
      NOW,
    )).toBe(false)
  })

  it('fails closed for missing or stale target metadata', () => {
    const entities = snapshot()
    entities.ads.set('ad-stale', {
      id: 'ad-stale', campaignId: 'campaign-active', adsetId: 'adset-active', status: 'ACTIVE',
      effectiveStatus: 'ACTIVE', lastSyncedAt: STALE, lastMaterialChangeAt: STALE,
    })

    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'keep', targetEntityType: 'ad', targetEntityId: 'ad-stale' },
      entities,
      NOW,
    )).toBe(false)
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'keep', targetEntityType: 'ad', targetEntityId: 'missing' },
      entities,
      NOW,
    )).toBe(false)
  })

  it('allows only a fresh explicitly-paused target for a future activate recommendation', () => {
    const entities = snapshot()

    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'activate', targetEntityType: 'ad', targetEntityId: 'ad-paused' },
      entities,
      NOW,
    )).toBe(true)

    entities.ads.set('ad-paused', {
      ...entities.ads.get('ad-paused')!,
      lastSyncedAt: STALE,
    })
    expect(recommendationTargetsCurrentOperatingEntity(
      { recommendationType: 'activate', targetEntityType: 'ad', targetEntityId: 'ad-paused' },
      entities,
      NOW,
    )).toBe(false)
  })
})
