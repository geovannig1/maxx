import { getAdminClient } from '@/lib/supabase/admin'
import { nyDaysAgo } from '@/lib/utils/date-utils'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Latest account-level warehouse day eligible to be treated as closed. Fails closed to null. */
export async function readLatestClosedAccountDeliveryDate(
  adAccountDbId: string,
  db?: ReturnType<typeof getAdminClient>,
): Promise<string | null> {
  try {
    const client = db ?? getAdminClient()
    const { data, error } = await client
      .from('daily_insights')
      .select('date_start')
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'account')
      .lte('date_start', nyDaysAgo(1))
      .order('date_start', { ascending: false })
      .limit(1)
    if (error || !Array.isArray(data) || data.length === 0) return null
    const latest = (data[0] as { date_start?: unknown }).date_start
    return typeof latest === 'string' && ISO_DATE.test(latest) ? latest : null
  } catch {
    return null
  }
}
