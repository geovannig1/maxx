import 'server-only'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { actionTypeForDecision, OWNER_DECISION_MAX_AGE_DAYS } from './owner-change-policy'
import type { WriteActionType } from './executor'
import { stuckRunsByRequest } from './account-lock'

// ADR-059 read models: what is waiting for the owner, what the owner may propose, and what was
// recently applied (and can be rolled back). Account-scoped; a failed read is reported, never empty.

type Db = ReturnType<typeof getAdminClient>

export const CHANGE_CARD_COLUMNS = 'id, action_decision_id, status, action_type, entity_level, meta_entity_id, params, before_state, after_state, preview, reason, confidence, risk_level, rollback_plan, requested_by, created_at, expires_at, executed_at, evidence, data_source, initiated_by, rollback_of, step_override, result, campaign_plan_version_id'

export interface ChangeCardRow {
  id: string
  action_decision_id: string | null
  status: string
  action_type: string
  entity_level: string
  meta_entity_id: string
  params: Record<string, unknown> | null
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
  preview: string | null
  reason: string | null
  confidence: number | null
  risk_level: string | null
  rollback_plan: string | null
  requested_by: string | null
  created_at: string
  expires_at: string | null
  executed_at: string | null
  evidence: string | null
  data_source: string | null
  initiated_by: string | null
  rollback_of: string | null
  step_override: boolean | null
  result: Record<string, unknown> | null
  /** ADR-062: set on a campaign plan's creation (or its archive rollback). */
  campaign_plan_version_id: string | null
  /** Security review M1: when a run of this change is stuck holding the account lock, when it started. */
  stuck_since?: string | null
}

/** Mark each row whose run is stuck (stale 'executing' claim) so /changes offers its recovery. */
export async function withStuckSince<T extends { id: string }>(db: Db, accountId: string, rows: T[]): Promise<Array<T & { stuck_since: string | null }>> {
  const stuck = await stuckRunsByRequest(db, accountId)
  return rows.map((row) => ({ ...row, stuck_since: stuck.get(row.id) ?? null }))
}

export interface ProposableDecision {
  id: string
  action_kind: string
  action_type: WriteActionType
  target_level: 'ad' | 'adset'
  target_id: string
  target_name: string | null
  authority_tier: 'execution_eligible' | 'owner_review'
  owner_copy: string
  evaluated_at: string
  /** Local (last-sync) daily budget of an ad-set target, in the account currency; display only. */
  synced_daily_budget: number | null
}

type Read<T> = { ok: true; rows: T } | { ok: false; code: string }

function failed(step: string, error: { message?: string }): { ok: false; code: string } {
  console.error(`[OWNER CHANGE READ] ${step} failed:`, error.message ?? 'no detail')
  return { ok: false, code: 'CHANGE_READ_FAILED' }
}

async function accountOf(db: Db, given?: string): Promise<string | null> {
  if (given) return given
  const active = await resolveOnlyActiveAccount(db)
  return active.ok ? active.account.id : null
}

/** Pending and approved-not-executed requests (an approval whose apply step is still owed), plus a
 *  campaign plan whose creation failed part-way (it can be resumed or rolled back, ADR-062). */
export async function listPendingChanges(accountId?: string): Promise<Read<ChangeCardRow[]>> {
  const db = getAdminClient()
  const account = await accountOf(db, accountId)
  if (!account) return { ok: false, code: 'ACTIVE_ACCOUNT_UNAVAILABLE' }
  const [open, failedPlans] = await Promise.all([
    db.from('change_requests').select(CHANGE_CARD_COLUMNS)
      .eq('ad_account_id', account).in('status', ['pending', 'approved'])
      .order('created_at', { ascending: false }).limit(100),
    db.from('change_requests').select(CHANGE_CARD_COLUMNS)
      .eq('ad_account_id', account).eq('status', 'failed').not('campaign_plan_version_id', 'is', null)
      .order('created_at', { ascending: false }).limit(20),
  ])
  if (open.error) return failed('pending changes', open.error)
  if (failedPlans.error) return failed('failed plan changes', failedPlans.error)
  const rows = [...(open.data ?? []), ...(failedPlans.data ?? [])] as unknown as ChangeCardRow[]
  return { ok: true, rows: (await withStuckSince(db, account, rows)).sort((a, b) => b.created_at.localeCompare(a.created_at)) }
}

/** Executed in the last 14 days, newest first: the rows a rollback can start from. */
export async function listRecentlyApplied(accountId: string): Promise<Read<ChangeCardRow[]>> {
  const db = getAdminClient()
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data, error } = await db.from('change_requests').select(CHANGE_CARD_COLUMNS)
    .eq('ad_account_id', accountId).eq('status', 'executed').gte('executed_at', since)
    .order('executed_at', { ascending: false }).limit(25)
  if (error) return failed('recent changes', error)
  return { ok: true, rows: (data ?? []) as unknown as ChangeCardRow[] }
}

interface DecisionRow {
  id: string; action_kind: string; target_level: string; target_id: string | null; authority_tier: string
  owner_copy: string; evaluated_at: string
}

/** Current decisions the owner may turn into a change. The proposal re-checks everything. */
export async function listProposableDecisions(accountId: string): Promise<Read<ProposableDecision[]>> {
  const db = getAdminClient()
  const since = new Date(Date.now() - OWNER_DECISION_MAX_AGE_DAYS * 86_400_000).toISOString()
  const { data, error } = await db.from('action_decisions')
    .select('id, action_kind, target_level, target_id, authority_tier, owner_copy, evaluated_at')
    .eq('ad_account_id', accountId).eq('approval_state', 'not_requested')
    .in('authority_tier', ['owner_review', 'execution_eligible']).in('target_level', ['ad', 'adset'])
    .gte('evaluated_at', since).order('evaluated_at', { ascending: false }).limit(50)
  if (error) return failed('proposable decisions', error)
  const newestPerTarget = new Map<string, DecisionRow>()
  for (const row of (data ?? []) as DecisionRow[]) {
    const key = `${row.target_level}:${row.target_id}`
    if (!newestPerTarget.has(key)) newestPerTarget.set(key, row)
  }
  const candidates = [...newestPerTarget.values()].flatMap((row) => {
    const actionType = actionTypeForDecision(row.action_kind, row.target_level)
    return actionType && row.target_id ? [{ row, actionType }] : []
  })
  const adIds = candidates.filter((c) => c.row.target_level === 'ad').map((c) => c.row.target_id as string)
  const adsetIds = candidates.filter((c) => c.row.target_level === 'adset').map((c) => c.row.target_id as string)
  const [ads, adsets] = await Promise.all([
    adIds.length ? db.from('ads').select('ad_id, ad_name').eq('ad_account_id', accountId).in('ad_id', adIds) : Promise.resolve({ data: [], error: null }),
    adsetIds.length ? db.from('adsets').select('adset_id, adset_name, daily_budget').eq('ad_account_id', accountId).in('adset_id', adsetIds) : Promise.resolve({ data: [], error: null }),
  ])
  // Names are display only; a failed name read leaves the id visible rather than hiding the decision.
  const adNames = new Map(((ads.data ?? []) as Array<{ ad_id: string; ad_name: string | null }>).map((a) => [a.ad_id, a.ad_name]))
  const adsetInfo = new Map(((adsets.data ?? []) as Array<{ adset_id: string; adset_name: string | null; daily_budget: number | null }>).map((a) => [a.adset_id, a]))
  return {
    ok: true,
    rows: candidates.map(({ row, actionType }) => {
      const adset = adsetInfo.get(row.target_id as string)
      return {
        id: row.id, action_kind: row.action_kind, action_type: actionType,
        target_level: row.target_level as 'ad' | 'adset', target_id: row.target_id as string,
        target_name: row.target_level === 'ad' ? adNames.get(row.target_id as string) ?? null : adset?.adset_name ?? null,
        authority_tier: row.authority_tier as ProposableDecision['authority_tier'],
        owner_copy: row.owner_copy, evaluated_at: row.evaluated_at,
        synced_daily_budget: adset?.daily_budget == null ? null : Number(adset.daily_budget),
      }
    }),
  }
}
