import { describe, expect, it } from 'vitest'
import { buildCreativeGroups } from '@/lib/reporting/creative-groups'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { metricsToExportRows } from '@/lib/reporting/export'
import { creativeAd, creativeContext, creativeData } from './fixtures/reporting-creative'

const action = (action_type: string, value: number) => ({ action_type, value: String(value) })
const raw = (spend: number, impressions: number, engagements: number, shares: number, views: number, thruplays: number) => ({
  spend: String(spend), impressions: String(impressions),
  actions: [action('post_engagement', engagements), action('post', shares)],
  video_continuous_2_sec_watched_actions: [action('video_view', views)],
  video_thruplay_watched_actions: [action('video_view', thruplays)],
})
const formulas = [
  ['cost_per_2s_view', 'spend', 'video_2s', 2, 1],
  ['cost_per_thruplay', 'spend', 'thruplays', 4, 2],
  ['cost_per_engagement', 'spend', 'engagements', 1, 0.5],
  ['cost_per_share', 'spend', 'shares', 10, 5],
  ['engagement_rate', 'engagements', 'impressions', 10, 20],
  ['share_rate', 'shares', 'impressions', 1, 2],
] as const

describe('supported native creative costs and response ratios', () => {
  it.each(formulas)('%s keeps distinct current/prior arithmetic and exact native input IDs', (key, numerator, denominator, current, previous) => {
    const metrics = buildMetaMetrics(creativeContext, raw(20, 200, 20, 2, 10, 5), raw(10, 100, 20, 2, 10, 5), { level: 'ad', id: '301' })
    expect(metrics[key], 'the canonical builder supplies the metric').toBeDefined()
    expect(metrics[key].current.value).toBe(current)
    expect(metrics[key].previous?.value).toBe(previous)
    expect(metrics[key].current.inputClaimIds).toEqual([metrics[numerator].current.claimId, metrics[denominator].current.claimId])
    expect(metrics[key].previous?.inputClaimIds).toEqual([metrics[numerator].previous!.claimId, metrics[denominator].previous!.claimId])
    expect(metrics[key].current.measurementKind).toBe('derived')
    expect(metrics[key].current.unit).toBe(key.endsWith('_rate') ? 'percent' : 'money')
    expect(metrics[key].event).toBeNull()
  })
  it('uses explicit continuous two-second, ThruPlay and post-engagement labels', () => {
    const metrics = creativeAd('301', raw(20, 200, 20, 2, 10, 5)).metrics
    expect(metrics.cost_per_2s_view?.label).toBe('Cost per continuous 2-second view')
    expect(metrics.cost_per_thruplay?.label).toBe('Cost per ThruPlay')
    expect(metrics.cost_per_engagement?.label).toBe('Cost per post engagement')
    expect(metrics).not.toHaveProperty('cost_per_3s_view')
  })
  it('calculates the selected cohort from sums, never the average of execution costs or rates', () => {
    const group = buildCreativeGroups(creativeData([
      creativeAd('301', raw(10, 10, 1, 1, 1, 1)), creativeAd('302', raw(90, 990, 99, 9, 9, 9)),
    ])).groups[0]
    expect(group.metrics.cost_per_engagement?.current.value).toBe(1)
    expect(group.metrics.cost_per_engagement?.current.value).not.toBe((10 + 90 / 99) / 2)
    expect(group.metrics.engagement_rate?.current.value).toBe(10)
    for (const key of ['cost_per_share', 'cost_per_2s_view', 'cost_per_thruplay']) expect(group.metrics[key]?.current.value).toBe(10)
    expect(group.metrics.share_rate?.current.value).toBe(1)
    expect(group.metrics.cost_per_share?.current.inputs.filter(input => input.role !== 'guard').map(input => input.claim?.claimId))
      .toEqual(group.members.flatMap(member => [member.entity.metrics.spend.current.claimId, member.entity.metrics.shares.current.claimId]))
  })
  it('distinguishes explicit zero cost/rate from missing inputs and zero denominators in each period', () => {
    const metrics = creativeAd('301', raw(0, 100, 0, 1, 0, 1), raw(5, 100, 10, 1, 1, 1)).metrics
    expect(metrics.cost_per_share?.current.value).toBe(0)
    expect(metrics.engagement_rate?.current.value).toBe(0)
    expect(metrics.cost_per_engagement?.current.value).toBeNull()
    expect(metrics.cost_per_engagement?.previous?.value).toBe(0.5)
    expect(creativeAd('302', {}).metrics.share_rate?.current.value).toBeNull()
    expect(creativeAd('303', raw(5, 0, 0, 0, 0, 0)).metrics.engagement_rate?.current.value).toBeNull()
  })
  it.each([
    [action('post_engagement', 2), action('post_engagement', 3)],
    [action('post_engagement', 2), { action_type: 'post', value: 'bad' }],
    [action('post_engagement', 2.5)],
  ])('does not manufacture a cost from duplicate or malformed native actions: %j', (...actions) => {
    const metrics = creativeAd('301', { spend: '10', impressions: '100', actions }).metrics
    expect(metrics.cost_per_engagement?.current.value).toBeNull()
    expect(metrics.engagement_rate?.current.value).toBeNull()
    expect(metrics.spend.current.value).toBe(10)
  })
  it('preserves native ratio lineage through the ordinary export', () => {
    const metrics = creativeAd('301', raw(20, 200, 20, 2, 10, 5)).metrics
    const exported = metricsToExportRows(metrics, 'Ad 301', creativeContext).find(row => row.metric === 'Cost per post engagement')
    expect(exported).toMatchObject({ value: 1, previous_value: 1, claim_id: metrics.cost_per_engagement?.current.claimId,
      input_claim_ids: JSON.stringify([metrics.spend.current.claimId, metrics.engagements.current.claimId]),
      previous_input_claim_ids: JSON.stringify([metrics.spend.previous!.claimId, metrics.engagements.previous!.claimId]) })
  })
})
