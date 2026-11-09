import { metaGetPaginated, unsupportedOptionalMetaField } from './client'
import {
  DELIVERY_SUB_STATUS_FIELD,
  normalizeDeliverySubStatus,
} from './delivery-sub-status'
import type { MetaAd } from '@/types/meta-api'

const REQUIRED_AD_FIELDS = [
  'id',
  'name',
  'status',
  'effective_status',
  'adset_id',
  'campaign_id',
  'creative{id}',
  'url_tags',
  'review_feedback',
  'issues_info{error_code,error_summary,error_message,level}',
  'tracking_specs',
  'created_time',
  'updated_time',
]

const DESTINATION_URL_FIELD = 'destination_url'
const OPTIONAL_AD_FIELDS = [DESTINATION_URL_FIELD, DELIVERY_SUB_STATUS_FIELD]

type RawMetaAd = Omit<
  MetaAd,
  'delivery_sub_status' | 'delivery_sub_status_read_available' | 'destination_url_read_available'
> & { delivery_sub_status?: unknown }

function fields(optionalFields: Set<string>): string {
  return [
    ...REQUIRED_AD_FIELDS,
    ...OPTIONAL_AD_FIELDS.filter((field) => optionalFields.has(field)),
  ].join(',')
}

/**
 * Fetch all ads for an ad account.
 */
export async function fetchAds(accountId: string): Promise<MetaAd[]> {
  const optionalFields = new Set(OPTIONAL_AD_FIELDS)
  let raw: RawMetaAd[]
  while (true) {
    try {
      raw = await metaGetPaginated<RawMetaAd>(
        `/act_${accountId}/ads`,
        { fields: fields(optionalFields), limit: '200' },
      )
      break
    } catch (error) {
      const unsupportedField = unsupportedOptionalMetaField(error, optionalFields)
      if (!unsupportedField) throw error
      optionalFields.delete(unsupportedField)
      console.warn(`[Sync] Meta did not expose ${unsupportedField}; retrying ad sync without that optional field`)
    }
  }

  return raw.map((ad) => {
    const delivery = normalizeDeliverySubStatus(
      ad.delivery_sub_status,
      optionalFields.has(DELIVERY_SUB_STATUS_FIELD),
    )
    return {
      ...ad,
      destination_url_read_available: optionalFields.has(DESTINATION_URL_FIELD),
      delivery_sub_status: delivery.payload,
      delivery_sub_status_read_available: delivery.read_available,
    }
  })
}
