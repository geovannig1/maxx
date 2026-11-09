import { metaGetPaginated } from './client'
import type { MetaCampaign } from '@/types/meta-api'
import { fromMetaMinorUnits, metaCurrencyOffset } from './currency-offset'
import { accountCurrency } from '@/config/business-config'

const CAMPAIGN_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'objective',
  'daily_budget',
  'lifetime_budget',
  'spend_cap',
  'buying_type',
  'special_ad_categories',
  'start_time',
  'stop_time',
  'created_time',
  'updated_time',
].join(',')

// Only fetch ACTIVE and PAUSED campaigns
const STATUS_FILTER = JSON.stringify([
  { field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] },
])

/**
 * Fetch all campaigns for an ad account.
 * Budgets are converted from Meta cents (string) to dollars (number).
 */
export async function fetchCampaigns(accountId: string): Promise<MetaCampaign[]> {
  const raw = await metaGetPaginated<MetaCampaign>(
    `/act_${accountId}/campaigns`,
    {
      fields: CAMPAIGN_FIELDS,
      filtering: STATUS_FILTER,
      limit: '200',
    }
  )

  return raw.map((c) => ({
    ...c,
    daily_budget: parseCentsToDollars(c.daily_budget),
    lifetime_budget: parseCentsToDollars(c.lifetime_budget),
    spend_cap: parseCentsToDollars(c.spend_cap),
  }))
}

function parseCentsToDollars(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined
  const cents = parseInt(value, 10)
  // Meta's offset table, not ISO digits; a currency Meta does not list leaves the amount unknown.
  if (isNaN(cents) || metaCurrencyOffset(accountCurrency()) === null) return undefined
  return fromMetaMinorUnits(cents).toString()
}
