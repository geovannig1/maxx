import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'

const PLAN_REQUIRED_NOTE =
  'CAMPAIGN_PLAN_REQUIRED — no immutable, account-scoped CampaignPlan repository exists, so legacy rows are audit history only. Their strategy and execution details are withheld and are not current or actionable.'

interface HistoricalRecordRef {
  id: string
  recorded_at: string | null
}

function boundedLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20
  return Math.min(Math.max(Math.floor(value), 1), 50)
}

function baseResult() {
  return {
    status: 'CAMPAIGN_PLAN_REQUIRED' as const,
    authority_tier: 'diagnostic_only' as const,
    actionable: false as const,
    blocker_codes: ['campaign_plan_not_implemented'],
    note: PLAN_REQUIRED_NOTE,
  }
}

function unavailableResult(kind: 'brief' | 'test', errorCode: string, message: string) {
  return {
    ...baseResult(),
    read_health: 'unavailable' as const,
    error: message,
    error_code: errorCode,
    total: 0,
    briefs: [],
    tests: [],
    historical_record_count: null,
    historical_records: [] as HistoricalRecordRef[],
    artifact_kind: kind,
  }
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

async function resolveAccount() {
  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  return { db, activeAccount }
}

export async function getCreativeBriefs(args: { limit?: number } = {}) {
  const limit = boundedLimit(args.limit)
  try {
    const { db, activeAccount } = await resolveAccount()
    if (!activeAccount.ok) {
      return unavailableResult(
        'brief',
        activeAccountErrorCode(activeAccount.reason),
        'The active ad account could not be resolved uniquely; legacy brief history is unavailable.',
      )
    }

    const { data, error } = await db
      .from('creative_briefs')
      .select('id, created_at')
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      return unavailableResult('brief', 'LEGACY_BRIEF_HISTORY_UNAVAILABLE', 'Legacy brief history could not be read account-scoped.')
    }

    const records = historicalRefs(data)
    return {
      ...baseResult(),
      read_health: 'healthy' as const,
      total: 0,
      briefs: [],
      historical_record_count: records.length,
      historical_records: records,
      artifact_kind: 'brief' as const,
    }
  } catch {
    return unavailableResult('brief', 'LEGACY_BRIEF_HISTORY_UNAVAILABLE', 'Legacy brief history could not be read account-scoped.')
  }
}

export async function getTestingBacklog(args: { limit?: number } = {}) {
  const limit = boundedLimit(args.limit)
  try {
    const { db, activeAccount } = await resolveAccount()
    if (!activeAccount.ok) {
      return unavailableResult(
        'test',
        activeAccountErrorCode(activeAccount.reason),
        'The active ad account could not be resolved uniquely; legacy test history is unavailable.',
      )
    }

    const { data, error } = await db
      .from('tests')
      .select('id, created_at')
      .eq('ad_account_id', activeAccount.account.id)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      return unavailableResult('test', 'LEGACY_TEST_HISTORY_UNAVAILABLE', 'Legacy test history could not be read account-scoped.')
    }

    const records = historicalRefs(data)
    return {
      ...baseResult(),
      read_health: 'healthy' as const,
      total: 0,
      tests: [],
      historical_record_count: records.length,
      historical_records: records,
      artifact_kind: 'test' as const,
    }
  } catch {
    return unavailableResult('test', 'LEGACY_TEST_HISTORY_UNAVAILABLE', 'Legacy test history could not be read account-scoped.')
  }
}
