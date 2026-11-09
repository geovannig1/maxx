import 'server-only'
import type { AdPlatform } from '../types'
import { MetaApiError } from './client'
import { fetchAdAccount } from './fetch-accounts'
import { fetchCampaigns } from './fetch-campaigns'
import { fetchAdSets } from './fetch-adsets'
import { fetchAds } from './fetch-ads'
import { fetchCreatives } from './fetch-creatives'
import { fetchCustomAudiences } from './fetch-custom-audiences'
import { fetchInsights, fetchNativePeriodDelivery } from './fetch-insights'
import { fetchBreakdowns, upsertBreakdowns } from './fetch-breakdowns'
import { fetchDaypartInsights, upsertDaypartInsights } from './fetch-daypart'
import { fetchActiveAdSetBudgets, fetchActiveCampaignBudgets, fetchTodayCampaignSpend } from './pacing'
import { fetchMetaConversion, interpretMetaCapiResponse, recordDelivery } from './conversions-delivery'
import { applyMetaChange, fetchActiveBudgetRows, hasMetaWriteCredentials, metaGetEntity } from './writes'
import { metaCreateObject, metaFindMarked, metaReadObject, metaSetStatus } from './campaign-writes'
import { fetchCompetitorAds } from './ad-library-fetcher'
import { fetchPixelStatus } from './pixel-status'
import { eventPerWeek, fetchDatasetEventVolume } from './fetch-dataset-stats'
import { fetchDatasetQuality } from './fetch-dataset-quality'
import { fetchMetaRecommendations, isStaleRecommendation } from './fetch-meta-recommendations'
import { fetchDeliveryEstimate } from './fetch-delivery-estimate'
import { checkMetaConnection } from './connection-check'
import { buildMetaOutcomeEvent, metaTestEventCode, resolveMetaSendCredentials } from './outcome-event'
import { readMetaReport } from './reporting/meta-reader'

// Meta, the first ad platform. Each operation forwards its arguments unchanged to
// the Meta module that already implemented it, so every Graph request is the one those modules sent
// before. Delegates resolve the module function at call time (not at load), which keeps test doubles
// that replace one module from affecting the others.

import { fromMetaMinorUnits, metaSupportsCurrency, toMetaMinorUnits } from './currency-offset'

export const metaAdPlatform = {
  id: 'meta',
  label: 'Meta',
  isApiError: (err: unknown): err is MetaApiError => err instanceof MetaApiError,
  budgetUnits: {
    supports: (...args: Parameters<typeof metaSupportsCurrency>) => metaSupportsCurrency(...args),
    toMinor: (...args: Parameters<typeof toMetaMinorUnits>) => toMetaMinorUnits(...args),
    fromMinor: (...args: Parameters<typeof fromMetaMinorUnits>) => fromMetaMinorUnits(...args),
  },
  entities: {
    fetchAccount: (...args: Parameters<typeof fetchAdAccount>) => fetchAdAccount(...args),
    fetchCampaigns: (...args: Parameters<typeof fetchCampaigns>) => fetchCampaigns(...args),
    fetchAdSets: (...args: Parameters<typeof fetchAdSets>) => fetchAdSets(...args),
    fetchAds: (...args: Parameters<typeof fetchAds>) => fetchAds(...args),
    fetchCreatives: (...args: Parameters<typeof fetchCreatives>) => fetchCreatives(...args),
    fetchCustomAudiences: (accountId: string) => fetchCustomAudiences(accountId),
  },
  insights: {
    fetchInsights: (...args: Parameters<typeof fetchInsights>) => fetchInsights(...args),
    fetchPeriodDelivery: (...args: Parameters<typeof fetchNativePeriodDelivery>) => fetchNativePeriodDelivery(...args),
  },
  pacing: {
    fetchTodaySpendByCampaign: (...args: Parameters<typeof fetchTodayCampaignSpend>) => fetchTodayCampaignSpend(...args),
    fetchActiveCampaignBudgets: (...args: Parameters<typeof fetchActiveCampaignBudgets>) => fetchActiveCampaignBudgets(...args),
    fetchActiveAdSetBudgets: (...args: Parameters<typeof fetchActiveAdSetBudgets>) => fetchActiveAdSetBudgets(...args),
  },
  breakdowns: {
    fetch: (...args: Parameters<typeof fetchBreakdowns>) => fetchBreakdowns(...args),
    upsert: (...args: Parameters<typeof upsertBreakdowns>) => upsertBreakdowns(...args),
  },
  daypart: {
    fetch: (...args: Parameters<typeof fetchDaypartInsights>) => fetchDaypartInsights(...args),
    upsert: (...args: Parameters<typeof upsertDaypartInsights>) => upsertDaypartInsights(...args),
  },
  conversions: {
    send: (...args: Parameters<typeof fetchMetaConversion>) => fetchMetaConversion(...args),
    interpretResponse: (...args: Parameters<typeof interpretMetaCapiResponse>) => interpretMetaCapiResponse(...args),
    recordDelivery: (...args: Parameters<typeof recordDelivery>) => recordDelivery(...args),
    buildOutcomeEvent: (...args: Parameters<typeof buildMetaOutcomeEvent>) => buildMetaOutcomeEvent(...args),
    testEventCode: (...args: Parameters<typeof metaTestEventCode>) => metaTestEventCode(...args),
    resolveSendCredentials: (...args: Parameters<typeof resolveMetaSendCredentials>) => resolveMetaSendCredentials(...args),
  },
  writes: {
    isConfigured: (...args: Parameters<typeof hasMetaWriteCredentials>) => hasMetaWriteCredentials(...args),
    readEntity: (...args: Parameters<typeof metaGetEntity>) => metaGetEntity(...args),
    readActiveBudgetRows: (...args: Parameters<typeof fetchActiveBudgetRows>) => fetchActiveBudgetRows(...args),
    apply: (...args: Parameters<typeof applyMetaChange>) => applyMetaChange(...args),
  },
  campaignCreation: {
    isConfigured: (...args: Parameters<typeof hasMetaWriteCredentials>) => hasMetaWriteCredentials(...args),
    create: (...args: Parameters<typeof metaCreateObject>) => metaCreateObject(...args),
    findMarked: (...args: Parameters<typeof metaFindMarked>) => metaFindMarked(...args),
    read: (...args: Parameters<typeof metaReadObject>) => metaReadObject(...args),
    setStatus: (...args: Parameters<typeof metaSetStatus>) => metaSetStatus(...args),
  },
  adLibrary: {
    fetchCompetitorAds: (...args: Parameters<typeof fetchCompetitorAds>) => fetchCompetitorAds(...args),
  },
  trackingHealth: {
    fetchPixelStatus: (...args: Parameters<typeof fetchPixelStatus>) => fetchPixelStatus(...args),
  },
  datasetDiagnostics: {
    fetchEventVolume: (...args: Parameters<typeof fetchDatasetEventVolume>) => fetchDatasetEventVolume(...args),
    eventPerWeek: (...args: Parameters<typeof eventPerWeek>) => eventPerWeek(...args),
    fetchQuality: (...args: Parameters<typeof fetchDatasetQuality>) => fetchDatasetQuality(...args),
  },
  recommendations: {
    fetch: (...args: Parameters<typeof fetchMetaRecommendations>) => fetchMetaRecommendations(...args),
    isStale: (...args: Parameters<typeof isStaleRecommendation>) => isStaleRecommendation(...args),
  },
  deliveryEstimate: {
    fetch: (...args: Parameters<typeof fetchDeliveryEstimate>) => fetchDeliveryEstimate(...args),
  },
  connectionCheck: {
    check: (...args: Parameters<typeof checkMetaConnection>) => checkMetaConnection(...args),
  },
  reporting: {
    readReport: (...args: Parameters<typeof readMetaReport>) => readMetaReport(...args),
  },
} as const satisfies AdPlatform
