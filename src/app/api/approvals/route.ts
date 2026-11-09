import { ownerOnly } from '@/lib/auth/require-owner'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const PLAN_REQUIRED = {
  status: 'CAMPAIGN_PLAN_REQUIRED' as const,
  authority_tier: 'diagnostic_only' as const,
  actionable: false as const,
  blocker_codes: ['campaign_plan_not_implemented'],
  note: 'Legacy creative/test approval rows are retained as audit history. Their proposal details are withheld and no row is currently approvable.',
}

interface HistoricalRecordRef {
  id: string
  recorded_at: string | null
}

function historicalRefs(rows: unknown[] | null): HistoricalRecordRef[] {
  return (rows ?? []).flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const candidate = row as { id?: unknown; created_at?: unknown }
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return []
    return [{
      id: candidate.id,
      recorded_at: typeof candidate.created_at === 'string' ? candidate.created_at : null,
    }]
  })
}

function unavailable(errorCode: string, message: string): Response {
  return Response.json({
    ...PLAN_REQUIRED,
    read_health: 'unavailable',
    error_code: errorCode,
    error: message,
    approvals: [],
    historical_record_count: null,
    historical_records: [],
  }, { status: 503 })
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) {
      return unavailable(
        activeAccountErrorCode(activeAccount.reason),
        'The active ad account could not be resolved uniquely; legacy approval history is unavailable.',
      )
    }

    const { data, error, count } = await db
      .from('pending_approvals')
      .select('id, created_at', { count: 'exact' })
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      return unavailable('LEGACY_APPROVAL_HISTORY_UNAVAILABLE', 'Legacy approval history could not be read account-scoped.')
    }

    const records = historicalRefs(data)
    return Response.json({
      ...PLAN_REQUIRED,
      read_health: 'healthy',
      approvals: [],
      historical_record_count: count ?? records.length,
      historical_records: records,
    })
  } catch {
    return unavailable('LEGACY_APPROVAL_HISTORY_UNAVAILABLE', 'Legacy approval history could not be read account-scoped.')
  }
}
