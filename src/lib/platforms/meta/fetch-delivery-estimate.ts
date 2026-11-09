import { metaGet, MetaApiError } from './client'

// Ad-set DELIVERY-ESTIMATE audience bounds — GET /{adset}/delivery_estimate returns
// estimate_mau_lower_bound / estimate_mau_upper_bound for the ad set's current targeting.
//
// HONESTY RULE: this is a DIFFERENT estimator than Ads Manager's "audience size" bucket (which comes
// from Meta's internal anomaly engine and is not readable via the API). Callers must label these numbers
// as delivery-estimate MAU bounds and never present them as the Ads-Manager bucket.
//
// Read-only, optional, isolated: degrades to { available: false, reason } on any error so diagnosis
// never depends on this live call succeeding.

export type DeliveryEstimateResult =
  | { available: true; mau_lower: number; mau_upper: number }
  | { available: false; reason: string }

interface DeliveryEstimatePage {
  data?: Array<{
    estimate_mau_lower_bound?: number
    estimate_mau_upper_bound?: number
    estimate_ready?: boolean
  }>
}

export async function fetchDeliveryEstimate(adsetMetaId: string): Promise<DeliveryEstimateResult> {
  if (!adsetMetaId) return { available: false, reason: 'No ad set id.' }
  try {
    const page = await metaGet<DeliveryEstimatePage>(`/${adsetMetaId}/delivery_estimate`, {
      fields: 'estimate_mau_lower_bound,estimate_mau_upper_bound,estimate_ready',
    })
    const row = page.data?.[0]
    if (!row || row.estimate_mau_lower_bound == null || row.estimate_mau_upper_bound == null) {
      return { available: false, reason: 'Delivery estimate returned no MAU bounds.' }
    }
    return { available: true, mau_lower: row.estimate_mau_lower_bound, mau_upper: row.estimate_mau_upper_bound }
  } catch (err) {
    const reason =
      err instanceof MetaApiError
        ? `Meta delivery_estimate error (code ${err.code}): ${err.message}`
        : `Delivery estimate fetch failed: ${err instanceof Error ? err.message : String(err)}`
    return { available: false, reason }
  }
}
