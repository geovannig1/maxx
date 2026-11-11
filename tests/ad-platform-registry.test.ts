import { describe, expect, it, vi } from 'vitest'

// The ad-platform interface and registry. Core code reaches an ad platform only
// through getAdPlatform(); Meta is the first implementation. Every Meta operation is a thin delegate
// to the moved Meta module, so this proves each interface method forwards its exact arguments and
// returns the module's own result (the modules' behaviour is pinned by their existing tests).

const m = vi.hoisted(() => {
  const names = [
    'fetchAdAccount', 'fetchCampaigns', 'fetchAdSets', 'fetchAds', 'fetchCreatives', 'fetchCustomAudiences',
    'fetchInsights', 'fetchNativePeriodDelivery', 'fetchBreakdowns', 'upsertBreakdowns',
    'fetchDaypartInsights', 'upsertDaypartInsights', 'fetchTodayCampaignSpend', 'fetchActiveCampaignBudgets',
    'fetchActiveAdSetBudgets', 'resolvePixelId', 'fetchMetaConversion', 'interpretMetaCapiResponse',
    'recordDelivery', 'hasMetaWriteCredentials', 'metaGetEntity', 'fetchActiveBudgetRows', 'applyMetaChange',
    'fetchCompetitorAds', 'fetchPixelStatus', 'fetchDatasetEventVolume', 'eventPerWeek', 'fetchDatasetQuality',
    'fetchMetaRecommendations', 'isStaleRecommendation', 'fetchDeliveryEstimate', 'checkMetaConnection',
    'readMetaReport', 'buildMetaOutcomeEvent', 'metaTestEventCode', 'resolveMetaSendCredentials',
    'metaSupportsCurrency', 'toMetaMinorUnits', 'fromMetaMinorUnits',
    'metaCreateObject', 'metaFindMarked', 'metaReadObject', 'metaSetStatus',
    'metaCampaignRecord', 'metaAdSetRecord', 'metaAdRecord', 'metaCreativeRecord', 'metaInsightRecord',
  ] as const
  return Object.fromEntries(names.map((n) => [n, vi.fn(() => ({ from: n }))])) as
    Record<(typeof names)[number], ReturnType<typeof vi.fn>>
})

vi.mock('@/lib/platforms/meta/fetch-accounts', () => ({ fetchAdAccount: m.fetchAdAccount }))
vi.mock('@/lib/platforms/meta/records', () => ({
  metaCampaignRecord: m.metaCampaignRecord, metaAdSetRecord: m.metaAdSetRecord, metaAdRecord: m.metaAdRecord,
  metaCreativeRecord: m.metaCreativeRecord, metaInsightRecord: m.metaInsightRecord,
}))
vi.mock('@/lib/platforms/meta/fetch-campaigns', () => ({ fetchCampaigns: m.fetchCampaigns }))
vi.mock('@/lib/platforms/meta/fetch-adsets', () => ({ fetchAdSets: m.fetchAdSets }))
vi.mock('@/lib/platforms/meta/fetch-ads', () => ({ fetchAds: m.fetchAds }))
vi.mock('@/lib/platforms/meta/fetch-creatives', () => ({ fetchCreatives: m.fetchCreatives }))
vi.mock('@/lib/platforms/meta/fetch-custom-audiences', () => ({ fetchCustomAudiences: m.fetchCustomAudiences }))
vi.mock('@/lib/platforms/meta/fetch-insights', () => ({
  fetchInsights: m.fetchInsights, fetchNativePeriodDelivery: m.fetchNativePeriodDelivery,
}))
vi.mock('@/lib/platforms/meta/fetch-breakdowns', () => ({
  fetchBreakdowns: m.fetchBreakdowns, upsertBreakdowns: m.upsertBreakdowns,
}))
vi.mock('@/lib/platforms/meta/fetch-daypart', () => ({
  fetchDaypartInsights: m.fetchDaypartInsights, upsertDaypartInsights: m.upsertDaypartInsights,
}))
vi.mock('@/lib/platforms/meta/pacing', () => ({
  fetchTodayCampaignSpend: m.fetchTodayCampaignSpend,
  fetchActiveCampaignBudgets: m.fetchActiveCampaignBudgets,
  fetchActiveAdSetBudgets: m.fetchActiveAdSetBudgets,
}))
vi.mock('@/lib/platforms/meta/conversions-delivery', () => ({
  resolvePixelId: m.resolvePixelId, fetchMetaConversion: m.fetchMetaConversion,
  interpretMetaCapiResponse: m.interpretMetaCapiResponse, recordDelivery: m.recordDelivery,
}))
vi.mock('@/lib/platforms/meta/writes', () => ({
  hasMetaWriteCredentials: m.hasMetaWriteCredentials, metaGetEntity: m.metaGetEntity,
  fetchActiveBudgetRows: m.fetchActiveBudgetRows, applyMetaChange: m.applyMetaChange,
}))
vi.mock('@/lib/platforms/meta/currency-offset', () => ({
  metaSupportsCurrency: m.metaSupportsCurrency, toMetaMinorUnits: m.toMetaMinorUnits, fromMetaMinorUnits: m.fromMetaMinorUnits,
}))
vi.mock('@/lib/platforms/meta/campaign-writes', () => ({
  metaCreateObject: m.metaCreateObject, metaFindMarked: m.metaFindMarked, metaReadObject: m.metaReadObject, metaSetStatus: m.metaSetStatus,
}))
vi.mock('@/lib/platforms/meta/ad-library-fetcher', () => ({ fetchCompetitorAds: m.fetchCompetitorAds }))
vi.mock('@/lib/platforms/meta/pixel-status', () => ({ fetchPixelStatus: m.fetchPixelStatus }))
vi.mock('@/lib/platforms/meta/fetch-dataset-stats', () => ({
  fetchDatasetEventVolume: m.fetchDatasetEventVolume, eventPerWeek: m.eventPerWeek,
}))
vi.mock('@/lib/platforms/meta/fetch-dataset-quality', () => ({ fetchDatasetQuality: m.fetchDatasetQuality }))
vi.mock('@/lib/platforms/meta/fetch-meta-recommendations', () => ({
  fetchMetaRecommendations: m.fetchMetaRecommendations, isStaleRecommendation: m.isStaleRecommendation,
}))
vi.mock('@/lib/platforms/meta/fetch-delivery-estimate', () => ({ fetchDeliveryEstimate: m.fetchDeliveryEstimate }))
vi.mock('@/lib/platforms/meta/connection-check', () => ({ checkMetaConnection: m.checkMetaConnection }))
vi.mock('@/lib/platforms/meta/reporting/meta-reader', () => ({ readMetaReport: m.readMetaReport }))
vi.mock('@/lib/platforms/meta/outcome-event', () => ({
  buildMetaOutcomeEvent: m.buildMetaOutcomeEvent, metaTestEventCode: m.metaTestEventCode,
  resolveMetaSendCredentials: m.resolveMetaSendCredentials,
}))

import {
  AD_PLATFORM_CAPABILITIES,
  UnknownAdPlatformError,
  UnsupportedCapabilityError,
  capabilitiesOf,
  getAdPlatform,
  listAdPlatforms,
  requireCapability,
} from '@/lib/platforms/registry'
import type { AdPlatform, AdPlatformId } from '@/lib/platforms/types'
import { MetaApiError } from '@/lib/platforms/meta/client'

const meta = getAdPlatform('meta')

/** A platform implementing only the required groups: every optional capability absent. */
const minimal: AdPlatform = {
  id: 'meta',
  label: 'Minimal test platform',
  isApiError: meta.isApiError,
  budgetUnits: meta.budgetUnits,
  records: meta.records,
  entities: meta.entities,
  insights: meta.insights,
}

type Call = [group: string, method: string, target: keyof typeof m, args: unknown[]]
const DELEGATES: Call[] = [
  ['entities', 'fetchAccount', 'fetchAdAccount', ['act_1']],
  ['entities', 'fetchCampaigns', 'fetchCampaigns', ['act_1']],
  ['entities', 'fetchAdSets', 'fetchAdSets', ['act_1']],
  ['entities', 'fetchAds', 'fetchAds', ['act_1']],
  ['entities', 'fetchCreatives', 'fetchCreatives', [['cr_1', 'cr_2']]],
  ['entities', 'fetchCustomAudiences', 'fetchCustomAudiences', ['act_1']],
  ['insights', 'fetchInsights', 'fetchInsights', [{ accountId: 'act_1', level: 'ad', since: '2026-11-01', until: '2026-11-02' }]],
  ['insights', 'fetchPeriodDelivery', 'fetchNativePeriodDelivery', [{ accountId: 'act_1', since: '2026-11-01', until: '2026-11-07' }]],
  ['breakdowns', 'fetch', 'fetchBreakdowns', [{ accountId: 'act_1', level: 'adset', since: 'a', until: 'b', breakdowns: ['age'] }]],
  ['breakdowns', 'upsert', 'upsertBreakdowns', ['db-1', '2026-11-01', []]],
  ['daypart', 'fetch', 'fetchDaypartInsights', [{ accountId: 'act_1', since: 'a', until: 'b' }]],
  ['daypart', 'upsert', 'upsertDaypartInsights', ['db-1', 'a', 'b', []]],
  ['pacing', 'fetchTodaySpendByCampaign', 'fetchTodayCampaignSpend', ['123']],
  ['pacing', 'fetchActiveCampaignBudgets', 'fetchActiveCampaignBudgets', ['123']],
  ['pacing', 'fetchActiveAdSetBudgets', 'fetchActiveAdSetBudgets', ['123']],
  ['conversions', 'send', 'fetchMetaConversion', ['pixel-1', 'credential-1', { data: [] }]],
  ['conversions', 'interpretResponse', 'interpretMetaCapiResponse', [true, 200, { events_received: 1 }]],
  ['conversions', 'recordDelivery', 'recordDelivery', [{ outcomeId: 'o-1' }, { from: 'db' }]],
  ['conversions', 'buildOutcomeEvent', 'buildMetaOutcomeEvent', [{ id: 'o-1' }, { eventName: 'Lead', nowMs: 1 }]],
  ['conversions', 'testEventCode', 'metaTestEventCode', [{ META_TEST_EVENT_CODE: 'T1' }]],
  ['conversions', 'resolveSendCredentials', 'resolveMetaSendCredentials', [{ META_PIXEL_ID: '1' }]],
  ['writes', 'isConfigured', 'hasMetaWriteCredentials', []],
  ['writes', 'readEntity', 'metaGetEntity', ['120001', 'status']],
  ['writes', 'readActiveBudgetRows', 'fetchActiveBudgetRows', ['123']],
  ['writes', 'apply', 'applyMetaChange', ['pause_ad', '120001', {}]],
  ['campaignCreation', 'isConfigured', 'hasMetaWriteCredentials', []],
  ['campaignCreation', 'create', 'metaCreateObject', ['act_1/campaigns', { name: 'x', status: 'PAUSED' }]],
  ['campaignCreation', 'findMarked', 'metaFindMarked', ['act_1/campaigns', 'mxabc-campaign']],
  ['campaignCreation', 'read', 'metaReadObject', ['120001', 'status']],
  ['campaignCreation', 'setStatus', 'metaSetStatus', ['120001', 'ARCHIVED']],
  ['budgetUnits', 'supports', 'metaSupportsCurrency', ['TWD']],
  ['records', 'campaign', 'metaCampaignRecord', [{ id: '101' }]],
  ['records', 'adSet', 'metaAdSetRecord', [{ id: '201' }]],
  ['records', 'ad', 'metaAdRecord', [{ id: '301' }]],
  ['records', 'creative', 'metaCreativeRecord', [{ id: '401' }]],
  ['records', 'insight', 'metaInsightRecord', [{ date_start: '2026-11-01' }]],
  ['budgetUnits', 'toMinor', 'toMetaMinorUnits', [12.5, 'BHD']],
  ['budgetUnits', 'fromMinor', 'fromMetaMinorUnits', [1250, 'BHD']],
  ['adLibrary', 'fetchCompetitorAds', 'fetchCompetitorAds', ['competitor-1', 'page-1']],
  ['trackingHealth', 'fetchPixelStatus', 'fetchPixelStatus', ['pixel-1']],
  ['datasetDiagnostics', 'fetchEventVolume', 'fetchDatasetEventVolume', [{ adAccountDbId: 'db-1' }]],
  ['datasetDiagnostics', 'eventPerWeek', 'eventPerWeek', [{ available: true }, 'Purchase']],
  ['datasetDiagnostics', 'fetchQuality', 'fetchDatasetQuality', [{ adAccountDbId: 'db-1' }]],
  ['recommendations', 'fetch', 'fetchMetaRecommendations', []],
  ['recommendations', 'isStale', 'isStaleRecommendation', [{ id: 'r-1' }, 1_700_000_000_000]],
  ['deliveryEstimate', 'fetch', 'fetchDeliveryEstimate', ['120002']],
  ['connectionCheck', 'check', 'checkMetaConnection', [{ accessToken: 't', accountId: 'act_1' }]],
  ['reporting', 'readReport', 'readMetaReport', [{ account: { id: 'db-1' } }, { detailIds: ['ad-1'] }]],
]

describe('ad-platform registry', () => {
  it('registers Meta as the only platform, under its own id', () => {
    expect(listAdPlatforms().map((p) => p.id)).toEqual(['meta'])
    expect(meta.id).toBe('meta')
    expect(meta.label).toBe('Meta')
  })

  it('rejects an unknown platform id instead of falling back to Meta', () => {
    expect(() => getAdPlatform('google' as AdPlatformId)).toThrow(UnknownAdPlatformError)
    expect(() => getAdPlatform('google' as AdPlatformId)).toThrow(/google/)
  })

  it('derives capability flags from the operations a platform implements', () => {
    expect(capabilitiesOf(meta)).toEqual(Object.fromEntries(AD_PLATFORM_CAPABILITIES.map((c) => [c, true])))
    // Control: the same derivation reports every optional capability absent on a minimal platform.
    expect(capabilitiesOf(minimal)).toEqual(Object.fromEntries(AD_PLATFORM_CAPABILITIES.map((c) => [
      c, c === 'entities' || c === 'insights',
    ])))
  })

  it('requireCapability returns the operations, or names the platform and capability it lacks', () => {
    expect(requireCapability(meta, 'writes')).toBe(meta.writes)
    expect(() => requireCapability(minimal, 'writes')).toThrow(UnsupportedCapabilityError)
    expect(() => requireCapability(minimal, 'conversions')).toThrow(/Minimal test platform.*conversions/)
  })

  it('recognizes Meta API errors and nothing else', () => {
    expect(meta.isApiError(new MetaApiError({ message: 'expired', code: 190 }))).toBe(true)
    // Controls: a plain Error and a look-alike object are not platform API errors.
    expect(meta.isApiError(new Error('expired'))).toBe(false)
    expect(meta.isApiError({ name: 'MetaApiError', code: 190, isTokenError: () => true })).toBe(false)
  })
})

describe('Meta platform operations delegate to the moved Meta modules', () => {
  it('covers every operation of every group the platform implements', () => {
    const implemented = Object.entries(meta)
      .filter(([, v]) => v && typeof v === 'object')
      .flatMap(([group, ops]) => Object.keys(ops as object).map((op) => `${group}.${op}`))
      .sort()
    expect(DELEGATES.map(([g, op]) => `${g}.${op}`).sort()).toEqual(implemented)
  })

  it.each(DELEGATES)('%s.%s -> %s forwards its arguments and returns the module result', (group, method, target, args) => {
    m[target].mockClear()
    const ops = (meta as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[group]
    const result = ops[method](...args)
    expect(m[target]).toHaveBeenCalledTimes(1)
    expect(m[target]).toHaveBeenCalledWith(...args)
    expect(result).toEqual({ from: target })
  })
})
