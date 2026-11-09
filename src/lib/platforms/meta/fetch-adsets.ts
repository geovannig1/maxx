import { metaGetPaginated, unsupportedOptionalMetaField } from './client'
import {
  DELIVERY_SUB_STATUS_FIELD,
  normalizeDeliverySubStatus,
} from './delivery-sub-status'
import type { MetaAdSet } from '@/types/meta-api'
import { fromMetaMinorUnits, metaCurrencyOffset } from './currency-offset'
import { accountCurrency } from '@/config/business-config'

const REQUIRED_ADSET_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'campaign_id',
  'daily_budget',
  'lifetime_budget',
  'budget_remaining',
  'bid_amount',
  'bid_strategy',
  'optimization_goal',
  'billing_event',
  'destination_type',
  'targeting',
  'promoted_object',
  'learning_stage_info',
  'attribution_spec',
  'pacing_type',
  'start_time',
  'end_time',
  'created_time',
  'updated_time',
]

const TARGETING_RELAXATION_FIELD = 'targeting_optimization_types'
const OPTIONAL_ADSET_FIELDS = [TARGETING_RELAXATION_FIELD, DELIVERY_SUB_STATUS_FIELD]

type RawMetaAdSet = Omit<
  MetaAdSet,
  'delivery_sub_status' | 'delivery_sub_status_read_available'
> & { delivery_sub_status?: unknown }

function fields(optionalFields: Set<string>): string {
  return [
    ...REQUIRED_ADSET_FIELDS,
    ...OPTIONAL_ADSET_FIELDS.filter((field) => optionalFields.has(field)),
  ].join(',')
}

/**
 * Fetch all ad sets for an ad account.
 * Budgets and bid amounts are converted from Meta cents (string) to dollars.
 */
export async function fetchAdSets(accountId: string): Promise<MetaAdSet[]> {
  const optionalFields = new Set(OPTIONAL_ADSET_FIELDS)
  let raw: RawMetaAdSet[]
  while (true) {
    try {
      raw = await metaGetPaginated<RawMetaAdSet>(
        `/act_${accountId}/adsets`,
        { fields: fields(optionalFields), limit: '200' },
      )
      break
    } catch (error) {
      const unsupportedField = unsupportedOptionalMetaField(error, optionalFields)
      if (!unsupportedField) throw error
      optionalFields.delete(unsupportedField)
      console.warn(`[Sync] Meta did not expose ${unsupportedField}; retrying ad-set sync without that optional field`)
    }
  }

  return raw.map((s) => {
    const delivery = normalizeDeliverySubStatus(
      s.delivery_sub_status,
      optionalFields.has(DELIVERY_SUB_STATUS_FIELD),
    )
    return {
      ...s,
      delivery_sub_status: delivery.payload,
      delivery_sub_status_read_available: delivery.read_available,
      daily_budget: parseCentsToDollars(s.daily_budget),
      lifetime_budget: parseCentsToDollars(s.lifetime_budget),
      budget_remaining: parseCentsToDollars(s.budget_remaining),
      bid_amount: parseCentsToDollars(s.bid_amount),
    }
  })
}

function parseCentsToDollars(value: string | undefined): string | undefined {
  if (value == null || value === '') return undefined
  const cents = parseInt(value, 10)
  // Meta's offset table, not ISO digits; a currency Meta does not list leaves the amount unknown.
  if (isNaN(cents) || metaCurrencyOffset(accountCurrency()) === null) return undefined
  return fromMetaMinorUnits(cents).toString()
}
