import { logToolError } from '@/lib/security/api-error'
import { getAdminClient } from '@/lib/supabase/admin'
import { getRanCopyPerformance } from '@/lib/creative/copy-performance'
import { nyDaysAgo } from '@/lib/utils/date-utils'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

export async function getHookSuggestions(args: {
  copy_type?: string
  audience_type?: string
  limit?: number
  start_date?: string
  end_date?: string
}): Promise<object> {
  const db = getAdminClient()
  const limit = Math.min(args.limit ?? 20, 100)

  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return {
      error: `Copy evidence is unavailable because active account ownership is ${activeAccount.reason}.`,
      error_code: activeAccountErrorCode(activeAccount.reason),
      read_health: 'unavailable',
      copy: [],
      ran_copy_performance: null,
    }
  }
  const adAccountDbId = activeAccount.account.id

  let query = db
    .from('copy_variations')
    .select('id, copy_type, audience_type, copy_text, angle, char_count, is_approved, performance_notes, created_at')
    .eq('ad_account_id', adAccountDbId)
    .order('is_approved', { ascending: false })
    .limit(limit)

  if (args.copy_type) query = query.eq('copy_type', args.copy_type)
  if (args.audience_type) query = query.eq('audience_type', args.audience_type)

  const { data, error } = await query
  if (error) return { error: logToolError('get_copy_bank', 'COPY_BANK_READ_FAILED', error), error_code: 'COPY_BANK_READ_FAILED', copy: [] }

  // LIVE performance for copy that actually ran — grounds suggestions in measured delivery.
  const start = args.start_date ?? nyDaysAgo(30)
  const end = args.end_date ?? nyDaysAgo(1)
  let ranCopy: object[] = []
  let ranCopyReadHealth: 'healthy' | 'unavailable' = 'healthy'
  try {
    ranCopy = await getRanCopyPerformance(adAccountDbId, start, end)
  } catch {
    ranCopyReadHealth = 'unavailable'
  }

  return {
    total: (data ?? []).length,
    copy: data ?? [],
    ran_copy_performance: {
      window: { start, end },
      groups: ranCopy,
      read_health: ranCopyReadHealth,
      note: 'What actually RAN, grouped by hook (first line of primary text) + headline. link_ctr/cpc/spend/impressions are Meta API delivery facts; meta_bookings_estimate is the PIXEL count — a Meta-reported ESTIMATE, never revenue. Only verdict="ranked" groups (≥ 20 of spend in the account currency or ≥ 1000 impressions) are ordered by link CTR; treat "insufficient" groups as unjudged. Prefer proven hooks for reuse; drafted bank items above are UNTESTED until they run.',
    },
  }
}

export async function getCopyBank(args: {
  copy_type?: string
  audience_type?: string
  limit?: number
  start_date?: string
  end_date?: string
}): Promise<object> {
  return getHookSuggestions(args)
}
