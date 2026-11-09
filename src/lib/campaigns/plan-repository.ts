import 'server-only'
import { createHash } from 'node:crypto'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { ownerUserIdMismatch } from '@/lib/auth/owner-identity'
import { callOwnerRpc, OWNER_IDENTITY_MISMATCH } from '@/lib/writes/owner-rpc'
import { getAdPlatform } from '@/lib/platforms/registry'
import { formatMoney } from '@/lib/utils/format-currency'
import { planBriefSchema, type PlanBrief, type PlanBriefInput } from './plan-brief'
import { canonicalJson, campaignPlanSpecSchema, planAds, planDailyBudgetMinor, type CampaignPlanSpec, type PlanStatus } from './plan-spec'
import { validateCampaignPlan, type PlanIssue, type PlanValidation } from './plan-validation'
import { planReadiness, type ReadinessItem } from './plan-readiness'
import { loadPlanContext, type LoadedPlanContext } from './plan-context'
import { proposePlanWithAi } from './plan-ai'

// ADR-062: the CampaignPlan repository. Every version is validated here against the account as it is
// now, then written through the service-role-only RPC that numbers it and supersedes the previous
// draft. Results are HTTP bodies with stable codes; database text goes to the server log only.

type Db = ReturnType<typeof getAdminClient>

export interface PlanResult { http: number; body: Record<string, unknown> }

export interface PlanVersionView {
  id: string
  plan_id: string
  version: number
  status: PlanStatus
  source: 'template' | 'ai' | 'owner_edit'
  spec: CampaignPlanSpec
  spec_hash: string
  currency: string
  total_daily_budget_minor: number
  validation: PlanIssue[]
  readiness: ReadinessItem[]
  notes: string[]
  created_at: string
  status_changed_at: string
}

const VERSION_COLUMNS = 'id, plan_id, version, status, source, spec, spec_hash, currency, total_daily_budget_minor, validation, readiness, notes, created_at, status_changed_at'

const fail = (http: number, code: string, message: string, extra: Record<string, unknown> = {}): PlanResult => ({ http, body: { code, error: message, ...extra } })

function dbFailure(step: string, error: { message?: string } | null, code = 'CAMPAIGN_PLAN_WRITE_FAILED'): PlanResult {
  console.error(`[CAMPAIGN PLAN] ${step} failed:`, error?.message ?? 'no detail')
  return fail(500, code, 'The campaign plan could not be saved. Nothing was changed in Meta.')
}

export const hashSpec = (spec: CampaignPlanSpec): string => createHash('sha256').update(canonicalJson(spec)).digest('hex')

export function minorFormatter(currency: string): (minor: number) => string {
  return (minor) => formatMoney(getAdPlatform('meta').budgetUnits.fromMinor(minor, currency), { currency })
}

/** Validation and readiness for a spec against the loaded account context. */
export function evaluatePlan(spec: CampaignPlanSpec, ctx: LoadedPlanContext): { validation: PlanValidation; readiness: ReadinessItem[] } {
  const validation = validateCampaignPlan(spec, ctx.validation)
  return { validation, readiness: planReadiness(spec, validation, ctx.readiness) }
}

/** Defence in depth beside the route's owner gate: a pinned owner id must match (security review L6). */
export const ownerMismatch = ownerUserIdMismatch

export async function activeAccountId(db: Db): Promise<string | null> {
  const active = await resolveOnlyActiveAccount(db)
  return active.ok ? active.account.id : null
}

function rpcFailure(error: { message?: string }): PlanResult {
  const text = error.message ?? ''
  if (text === OWNER_IDENTITY_MISMATCH) return fail(403, 'NOT_OWNER', 'Only the owner can change a plan.')
  if (/campaign_plan_has_version_in_flight/.test(text)) return fail(409, 'PLAN_IN_FLIGHT', 'This plan has a version waiting for approval or being created. Reject it on Changes before editing.')
  if (/campaign_plan_version_not_draft/.test(text)) return fail(409, 'PLAN_NOT_DRAFT', 'Only the current draft of a plan can be submitted.')
  if (/campaign_plan_not_found|campaign_plan_account_mismatch|campaign_plan_version_not_found|campaign_plan_version_account_mismatch/.test(text)) return fail(404, 'PLAN_NOT_FOUND', 'Plan not found for the active account.')
  return dbFailure('plan RPC', error)
}

/** Validate and store a spec as a new version (a new plan when planId is null). */
export async function savePlanVersion(input: {
  db: Db; ctx: LoadedPlanContext; ownerUserId: string; planId: string | null; title: string; brief: PlanBrief | Record<string, unknown>
  spec: CampaignPlanSpec; notes: string[]; source: PlanVersionView['source']
}): Promise<PlanResult> {
  const { validation, readiness } = evaluatePlan(input.spec, input.ctx)
  const { data, error } = await callOwnerRpc(input.db, 'create_campaign_plan_version', {
    p_plan_id: input.planId, p_ad_account_id: input.ctx.account.id, p_owner_user_id: input.ownerUserId,
    p_title: input.title.slice(0, 200), p_brief: input.brief,
    p_version: {
      spec: input.spec, spec_hash: hashSpec(input.spec), currency: input.spec.currency, total_daily_budget_minor: planDailyBudgetMinor(input.spec),
      validation: validation.issues, readiness, notes: input.notes.slice(0, 20), source: input.source,
    },
  })
  if (error) return rpcFailure(error)
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; plan_id?: string; version?: number } | null
  if (!row?.id) return dbFailure('plan RPC', null)
  return {
    http: 201,
    body: {
      status: 'DRAFT_SAVED', plan_id: row.plan_id, version_id: row.id, version: row.version, ok: validation.ok,
      validation: validation.issues, readiness, notes: input.notes, step_override_required: validation.stepOverrideRequired,
      total_daily_budget: minorFormatter(input.spec.currency)(validation.totalDailyMinor),
    },
  }
}

/** Draft a plan from a brief (AI when on and asked for, the template otherwise) and store it as version 1. */
export async function draftCampaignPlan(briefInput: PlanBriefInput, options: { ownerUserId: string }): Promise<PlanResult> {
  if (ownerMismatch(options.ownerUserId)) return fail(403, 'NOT_OWNER', 'Only the owner can draft a plan.')
  const parsed = planBriefSchema.safeParse(briefInput)
  if (!parsed.success) return fail(400, 'INVALID_BRIEF', 'The brief is incomplete or out of bounds.', { fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] })
  const db = getAdminClient()
  const accountId = await activeAccountId(db)
  if (!accountId) return fail(409, 'ACCOUNT_UNAVAILABLE', 'The active ad account could not be resolved uniquely.')
  const loaded = await loadPlanContext(db, accountId)
  if (!loaded.ok) return fail(503, loaded.code, 'The account data the planner needs could not be read. Nothing was saved.')
  const brief = parsed.data
  const proposed = await proposePlanWithAi(brief, loaded.context.draft)
  const result = await savePlanVersion({
    db, ctx: loaded.context, ownerUserId: options.ownerUserId, planId: null, title: proposed.spec.campaign.name, brief,
    spec: proposed.spec, notes: proposed.notes, source: proposed.source,
  })
  if (result.http === 201) result.body = { ...result.body, source: proposed.source, summary: planSummary(proposed.spec, loaded.context.account.currency) }
  return result
}

export interface PlanSummary { name: string; objective: string; daily_budget: string; ad_sets: number; ads: number; new_creatives: number }

export function planSummary(spec: CampaignPlanSpec, currency: string): PlanSummary {
  const ads = planAds(spec)
  return {
    name: spec.campaign.name, objective: spec.campaign.objective, daily_budget: minorFormatter(currency)(planDailyBudgetMinor(spec)),
    ad_sets: spec.ad_sets.length, ads: ads.length, new_creatives: ads.filter(({ ad }) => ad.creative.mode !== 'existing_creative').length,
  }
}

/** Store an owner edit of a plan as its next version, after re-validating it. */
export async function editPlanVersion(input: { planId: string; ownerUserId: string; spec: unknown }): Promise<PlanResult> {
  if (ownerMismatch(input.ownerUserId)) return fail(403, 'NOT_OWNER', 'Only the owner can edit a plan.')
  const parsed = campaignPlanSpecSchema.safeParse(input.spec)
  if (!parsed.success) {
    return fail(400, 'INVALID_PLAN', 'The plan has fields outside the allowed shape.', { validation: parsed.error.issues.slice(0, 30).map((i) => ({ path: i.path.join('.'), code: 'shape', severity: 'blocker', message: i.message })) })
  }
  const db = getAdminClient()
  const accountId = await activeAccountId(db)
  if (!accountId) return fail(409, 'ACCOUNT_UNAVAILABLE', 'The active ad account could not be resolved uniquely.')
  const { data: plan, error } = await db.from('campaign_plans').select('id, title, brief').eq('id', input.planId).eq('ad_account_id', accountId).maybeSingle()
  if (error) return dbFailure('plan read', error, 'CAMPAIGN_PLAN_READ_FAILED')
  if (!plan) return fail(404, 'PLAN_NOT_FOUND', 'Plan not found for the active account.')
  const loaded = await loadPlanContext(db, accountId)
  if (!loaded.ok) return fail(503, loaded.code, 'The account data the validator needs could not be read. Nothing was saved.')
  const row = plan as { id: string; title: string; brief: Record<string, unknown> }
  return savePlanVersion({ db, ctx: loaded.context, ownerUserId: input.ownerUserId, planId: row.id, title: row.title, brief: row.brief, spec: parsed.data, notes: [], source: 'owner_edit' })
}

export interface PlanListRow {
  id: string; title: string; created_at: string; latest_version: number
  status: PlanStatus | null; version_id: string | null; total_daily_budget: string | null
}

/** Plans of the active account, newest first, with their latest version's status. */
export async function listPlans(): Promise<{ ok: true; rows: PlanListRow[] } | { ok: false; code: string }> {
  const db = getAdminClient()
  const accountId = await activeAccountId(db)
  if (!accountId) return { ok: false, code: 'ACCOUNT_UNAVAILABLE' }
  const { data: plans, error } = await db.from('campaign_plans').select('id, title, created_at, latest_version')
    .eq('ad_account_id', accountId).order('created_at', { ascending: false }).limit(50)
  if (error) { console.error('[CAMPAIGN PLAN] list failed:', error.message); return { ok: false, code: 'CAMPAIGN_PLAN_READ_FAILED' } }
  const rows = (plans ?? []) as Array<{ id: string; title: string; created_at: string; latest_version: number }>
  if (rows.length === 0) return { ok: true, rows: [] }
  const { data: versions, error: vError } = await db.from('campaign_plan_versions').select('id, plan_id, version, status, currency, total_daily_budget_minor')
    .eq('ad_account_id', accountId).in('plan_id', rows.map((r) => r.id))
  if (vError) { console.error('[CAMPAIGN PLAN] versions failed:', vError.message); return { ok: false, code: 'CAMPAIGN_PLAN_READ_FAILED' } }
  const latest = new Map<string, { id: string; status: PlanStatus; currency: string; total_daily_budget_minor: number }>()
  for (const v of (versions ?? []) as Array<{ id: string; plan_id: string; version: number; status: PlanStatus; currency: string; total_daily_budget_minor: number }>) {
    const plan = rows.find((r) => r.id === v.plan_id)
    if (plan && v.version === plan.latest_version) latest.set(v.plan_id, v)
  }
  return {
    ok: true,
    rows: rows.map((r) => {
      const v = latest.get(r.id)
      return { ...r, status: v?.status ?? null, version_id: v?.id ?? null, total_daily_budget: v ? minorFormatter(v.currency)(Number(v.total_daily_budget_minor)) : null }
    }),
  }
}

export interface PlanDetail {
  plan: { id: string; title: string; created_at: string; brief: Record<string, unknown> }
  versions: PlanVersionView[]
  changeRequests: Array<{ id: string; status: string; action_type: string; created_at: string; result: Record<string, unknown> | null; campaign_plan_version_id: string; rollback_of: string | null }>
  objects: Array<{ local_key: string; object_kind: string; meta_id: string | null; state: string; simulated: boolean; plan_version_id: string }>
}

/** One plan of the active account with its versions (newest first), requests and created objects. */
export async function getPlan(planId: string): Promise<{ ok: true; detail: PlanDetail } | { ok: false; http: number; code: string }> {
  const db = getAdminClient()
  const accountId = await activeAccountId(db)
  if (!accountId) return { ok: false, http: 409, code: 'ACCOUNT_UNAVAILABLE' }
  const { data: plan, error } = await db.from('campaign_plans').select('id, title, created_at, brief').eq('id', planId).eq('ad_account_id', accountId).maybeSingle()
  if (error) return { ok: false, http: 500, code: 'CAMPAIGN_PLAN_READ_FAILED' }
  if (!plan) return { ok: false, http: 404, code: 'PLAN_NOT_FOUND' }
  const { data: versions, error: vError } = await db.from('campaign_plan_versions').select(VERSION_COLUMNS)
    .eq('plan_id', planId).eq('ad_account_id', accountId).order('version', { ascending: false }).limit(20)
  if (vError) return { ok: false, http: 500, code: 'CAMPAIGN_PLAN_READ_FAILED' }
  const ids = ((versions ?? []) as Array<{ id: string }>).map((v) => v.id)
  const [requests, objects] = ids.length === 0 ? [{ data: [], error: null }, { data: [], error: null }] : await Promise.all([
    db.from('change_requests').select('id, status, action_type, created_at, result, campaign_plan_version_id, rollback_of').eq('ad_account_id', accountId).in('campaign_plan_version_id', ids).order('created_at', { ascending: false }),
    db.from('campaign_plan_objects').select('local_key, object_kind, meta_id, state, simulated, plan_version_id').eq('ad_account_id', accountId).in('plan_version_id', ids).order('created_at', { ascending: true }),
  ])
  if (requests.error || objects.error) return { ok: false, http: 500, code: 'CAMPAIGN_PLAN_READ_FAILED' }
  return {
    ok: true,
    detail: {
      plan: plan as PlanDetail['plan'],
      versions: (versions ?? []) as unknown as PlanVersionView[],
      changeRequests: (requests.data ?? []) as PlanDetail['changeRequests'],
      objects: (objects.data ?? []) as PlanDetail['objects'],
    },
  }
}
