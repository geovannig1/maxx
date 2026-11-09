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
  note: 'Legacy creative briefs are retained as audit history. Strategy and execution details are withheld until an immutable, account-scoped CampaignPlan can be verified server-side.',
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
    briefs: [],
    historical_record_count: null,
    historical_records: [],
  }, { status: 503 })
}

async function authenticatedUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function GET() {
  const user = await authenticatedUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) {
      return unavailable(
        activeAccountErrorCode(activeAccount.reason),
        'The active ad account could not be resolved uniquely; legacy brief history is unavailable.',
      )
    }

    const { data, error, count } = await db
      .from('creative_briefs')
      .select('id, created_at', { count: 'exact' })
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(50)

    if (error) {
      return unavailable('LEGACY_BRIEF_HISTORY_UNAVAILABLE', 'Legacy brief history could not be read account-scoped.')
    }

    const records = historicalRefs(data)
    return Response.json({
      ...PLAN_REQUIRED,
      read_health: 'healthy',
      briefs: [],
      historical_record_count: count ?? records.length,
      historical_records: records,
    })
  } catch {
    return unavailable('LEGACY_BRIEF_HISTORY_UNAVAILABLE', 'Legacy brief history could not be read account-scoped.')
  }
}

async function blockLegacyBriefMutation() {
  const user = await authenticatedUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  return Response.json({
    ...PLAN_REQUIRED,
    code: 'USE_CAMPAIGN_PLANS',
    message: 'Creative briefs are retired. Plan new campaigns (structure, audiences, budget, copy) at /campaigns/new; they are validated and approved as campaign plans (ADR-062).',
  }, { status: 409 })
}

export const POST = blockLegacyBriefMutation
export const PUT = blockLegacyBriefMutation
export const PATCH = blockLegacyBriefMutation
export const DELETE = blockLegacyBriefMutation
