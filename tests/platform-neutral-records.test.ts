import { describe, expect, it } from 'vitest'
import {
  metaAdRecord,
  metaAdSetRecord,
  metaCampaignRecord,
  metaCreativeRecord,
  metaInsightRecord,
} from '@/lib/platforms/meta/records'
import { getAdPlatform } from '@/lib/platforms/registry'
import type { MetaInsightRow } from '@/types/meta-api'

// Meta's wire records map into the platform-neutral shapes (src/lib/platforms/records.ts): ids and names
// as strings, statuses normalised, budgets and metrics as numbers in major units, and an unreported value
// null rather than 0. Fixtures are offline wire shapes.

describe('Meta wire records → neutral shapes', () => {
  it('maps a campaign, normalising its status and reading budgets as major units', () => {
    expect(metaCampaignRecord({
      id: '101', name: 'Spring', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', objective: 'OUTCOME_LEADS',
      daily_budget: '25.5', buying_type: 'AUCTION',
    })).toEqual({
      id: '101', name: 'Spring', status: 'active', deliveryStatus: 'CAMPAIGN_PAUSED', objective: 'OUTCOME_LEADS',
      dailyBudget: 25.5, lifetimeBudget: null,
    })
  })

  it('maps an ad set with its campaign and optimisation goal; an ad-set budget absent is null', () => {
    expect(metaAdSetRecord({
      id: '201', name: 'Set', status: 'PAUSED', effective_status: 'PAUSED', campaign_id: '101',
      optimization_goal: 'OFFSITE_CONVERSIONS', targeting: { geo_locations: {} },
    })).toEqual({
      id: '201', name: 'Set', status: 'paused', deliveryStatus: 'PAUSED', campaignId: '101',
      dailyBudget: null, lifetimeBudget: null, optimizationGoal: 'OFFSITE_CONVERSIONS',
    })
  })

  it('maps an ad and its creative id; an unknown status is "other", never active', () => {
    expect(metaAdRecord({
      id: '301', name: 'Ad', status: 'IN_PROCESS', effective_status: 'IN_PROCESS', adset_id: '201', campaign_id: '101',
      creative: { id: '401' },
    })).toEqual({
      id: '301', name: 'Ad', status: 'other', deliveryStatus: 'IN_PROCESS', campaignId: '101', adSetId: '201', creativeId: '401',
    })
    expect(metaAdRecord({ id: '302', name: 'Ad', status: 'ARCHIVED', effective_status: 'ARCHIVED', adset_id: '201', campaign_id: '101' }))
      .toMatchObject({ status: 'archived', creativeId: null })
  })

  it('maps a creative', () => {
    expect(metaCreativeRecord({
      id: '401', name: 'Creative', body: 'Primary text', title: 'Headline', link_url: 'https://example.test/',
      video_id: '501', thumbnail_url: 'https://example.test/t.jpg', call_to_action_type: 'LEARN_MORE',
    })).toEqual({
      id: '401', name: 'Creative', body: 'Primary text', title: 'Headline', linkUrl: 'https://example.test/',
      imageUrl: null, videoId: '501', thumbnailUrl: 'https://example.test/t.jpg', callToAction: 'LEARN_MORE',
    })
  })

  it('maps an insight row: delivery metrics as numbers, link clicks kept apart from all clicks', () => {
    const row: MetaInsightRow = {
      date_start: '2026-09-01', date_stop: '2026-09-01', campaign_id: '101', adset_id: '201',
      spend: '12.34', impressions: '1000', reach: '800', frequency: '1.25', clicks: '40', inline_link_clicks: '25',
      actions: [{ action_type: 'link_click', value: '25' }],
    }
    expect(metaInsightRecord(row)).toEqual({
      dateStart: '2026-09-01', dateStop: '2026-09-01', campaignId: '101', adSetId: '201', adId: null,
      spend: 12.34, impressions: 1000, reach: 800, frequency: 1.25, clicks: 40, linkClicks: 25,
    })
  })

  it('reports an unreported or malformed metric as null, never 0 (control: a reported 0 stays 0)', () => {
    const mapped = metaInsightRecord({ date_start: '2026-09-01', date_stop: '2026-09-01', spend: '', impressions: 'n/a', clicks: '0' })
    expect(mapped).toMatchObject({ spend: null, impressions: null, reach: null, linkClicks: null, clicks: 0 })
  })
})

describe('the Meta platform exposes the mapping through its records group', () => {
  it('delegates each record kind to the Meta mapper', () => {
    const { records } = getAdPlatform('meta')
    const row: MetaInsightRow = { date_start: '2026-09-01', date_stop: '2026-09-01', spend: '5' }
    expect(records.insight(row)).toEqual(metaInsightRecord(row))
    const campaign = { id: '1', name: 'C', status: 'ACTIVE', effective_status: 'ACTIVE' }
    expect(records.campaign(campaign)).toEqual(metaCampaignRecord(campaign))
  })
})
