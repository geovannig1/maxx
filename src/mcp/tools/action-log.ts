import { logToolError } from '@/lib/security/api-error'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

interface ActionLogRow {
  id: string
  action_type: string
  entity_level: string
  meta_entity_id: string
  payload: Record<string, unknown> | null
  result: Record<string, unknown> | null
  approved_at: string
  created_at: string
}

export async function getActionLog(args: {
  action_type?: string
  entity_level?: string
  meta_entity_id?: string
  start_date?: string
  end_date?: string
  limit?: number
}): Promise<object> {
  const supabase = getAdminClient()
  const limit = Math.min(args.limit ?? 50, 200)
  const activeAccount = await resolveOnlyActiveAccount(supabase)
  if (!activeAccount.ok) {
    return {
      error: `Action log unavailable: active account ownership is ${activeAccount.reason}.`,
      error_code: activeAccountErrorCode(activeAccount.reason),
      read_health: 'unavailable',
      rows: [],
    }
  }

  let query = supabase
    .from('action_log')
    .select('id, action_type, entity_level, meta_entity_id, payload, result, approved_at, created_at')
    .eq('ad_account_id', activeAccount.account.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (args.action_type) {
    query = query.eq('action_type', args.action_type)
  }
  if (args.entity_level) {
    query = query.eq('entity_level', args.entity_level)
  }
  if (args.meta_entity_id) {
    query = query.eq('meta_entity_id', args.meta_entity_id)
  }
  if (args.start_date) {
    query = query.gte('created_at', args.start_date)
  }
  if (args.end_date) {
    // Include the full end date
    query = query.lte('created_at', `${args.end_date}T23:59:59Z`)
  }

  const { data, error } = await query

  if (error) {
    return { error: logToolError('get_action_log', 'ACTION_LOG_READ_FAILED', error), error_code: 'ACTION_LOG_READ_FAILED', rows: [] }
  }

  const rows = (data ?? []) as ActionLogRow[]

  return {
    count: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      action_type: r.action_type,
      entity_level: r.entity_level,
      meta_entity_id: r.meta_entity_id,
      payload: r.payload,
      result: r.result,
      approved_at: r.approved_at,
      created_at: r.created_at,
    })),
  }
}
