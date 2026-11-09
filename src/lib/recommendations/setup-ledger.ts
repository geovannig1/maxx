import { getAdminClient } from '@/lib/supabase/admin'
import { derivesActionTaken, isOutcomeReviewEligible, type UserDecision } from './decisions'
import { normalizeSettingValue } from './conflict-guard'

// Ad Decision Ledger — pure builders + graceful-degrading I/O for `ad_setup_decisions`.
//
// The ledger records SETTING-level setup/change decisions as INTENT ONLY. It reuses the closed-loop
// decision vocabulary and the review gate; trusted learning still flows ONLY through
// recommendation_outcomes.review_status='approved'. Nothing here executes a change or enables write mode —
// the safety invariants (write_mode_status:'off', action_allowed_now:false) are forced in buildSetupDecision.
//
// Read/write helpers degrade gracefully (return null/[]) if `ad_setup_decisions` is missing or unreadable — mirroring
// store.ts — so nothing breaks pre-apply.

/** Below this GA4 attribution coverage, a paid decision's outcome cannot self-validate (matches
 *  MIN_ATTRIBUTED_SHARE / the learning-status ATTRIBUTION_FLOOR). */
export const ATTRIBUTION_FLOOR = 0.5

export const SETTING_CATEGORIES = [
  'objective', 'conversion_event', 'optimization_event', 'attribution_window', 'evaluation_window',
  'budget', 'bid_strategy', 'audience', 'geo', 'age_gender', 'placements', 'advantage_plus',
  'retargeting', 'exclusions', 'creative', 'copy', 'landing_page', 'utm', 'pixel_capi', 'schedule',
  'launch_datetime', 'hypothesis', 'success_metric', 'min_data_threshold', 'follow_up',
] as const
export type SettingCategory = typeof SETTING_CATEGORIES[number]

export const LEDGER_ORIGINS = ['launch_setup', 'maxx_recommendation', 'manual_action'] as const
export type LedgerOrigin = typeof LEDGER_ORIGINS[number]

export interface SetupDecisionInput {
  ad_account_id: string
  entity_type: string
  entity_key: string
  entity_name?: string | null
  campaign_id?: string | null
  adset_id?: string | null
  ad_id?: string | null
  setting_category: SettingCategory | string
  setting_name: string
  previous_value?: string | null
  proposed_value?: string | null
  final_value?: string | null
  actual_launched_value?: string | null
  origin: LedgerOrigin
  recommended_by?: string | null
  reason?: string | null
  evidence?: string | null
  data_source?: string | null
  date_range_start?: string | null
  date_range_end?: string | null
  target_range_considered?: string | null
  confidence_label?: string | null
  risk_level?: string | null
  alternatives_considered?: string | null
  // conflict (from conflict-guard buildRevisionGuidance)
  conflicts_with_prior?: boolean
  prior_decision_id?: string | null
  change_summary?: string | null
  why_changed?: string | null
  prior_deprecated?: boolean
  switch_risk?: string | null
  // decision
  user_decision?: UserDecision | null
  decision_note?: string | null
  decided_by?: string | null
  decision_date?: string | null
  /** Explicit "the human took the action" — `acted_on` forces true regardless. */
  action_taken_explicit?: boolean
  action_taken_date?: string | null
  follow_up_date?: string | null
  // links
  recommendation_id?: string | null
  change_request_id?: string | null
  // learning-eligibility inputs
  uses_estimate_as_truth?: boolean
  attributed_share?: number | null
}

/** The row shape written to `ad_setup_decisions` (snake_case columns). */
export interface SetupDecisionRecord {
  ad_account_id: string
  entity_type: string
  entity_key: string
  entity_name: string | null
  campaign_id: string | null
  adset_id: string | null
  ad_id: string | null
  setting_category: string
  setting_name: string
  previous_value: string | null
  proposed_value: string | null
  final_value: string | null
  actual_launched_value: string | null
  origin: LedgerOrigin
  recommended_by: string | null
  reason: string | null
  evidence: string | null
  data_source: string | null
  date_range_start: string | null
  date_range_end: string | null
  target_range_considered: string | null
  confidence_label: string | null
  risk_level: string | null
  alternatives_considered: string | null
  conflicts_with_prior: boolean
  prior_decision_id: string | null
  change_summary: string | null
  why_changed: string | null
  prior_deprecated: boolean
  switch_risk: string | null
  approval_required: boolean
  user_decision: UserDecision | null
  decision_note: string | null
  decided_by: string | null
  decision_date: string | null
  action_taken: boolean
  action_taken_date: string | null
  follow_up_date: string | null
  recommendation_id: string | null
  change_request_id: string | null
  learning_eligibility: boolean
  // SAFETY INVARIANTS — always these values.
  write_mode_status: 'off'
  action_allowed_now: false
}

// Stable-key helper lives in the pure manifest module (client-importable); re-exported for server callers.
export { entityKeyForSetup } from './manifest'

/** Whether this decision's later outcome is eligible to feed the learning loop. Reuses the closed-loop
 *  rule (must be acted-on) and adds the paid-attribution firewall (estimate-as-truth / low coverage ⇒ not
 *  self-validating). Data sufficiency is judged later at outcome time (see classifyLedgerOutcome). */
export function deriveLearningEligibility(args: {
  user_decision: UserDecision | null
  action_taken: boolean
  uses_estimate_as_truth?: boolean
  attributed_share?: number | null
}): boolean {
  if (!args.user_decision) return false
  if (!isOutcomeReviewEligible({ user_decision: args.user_decision, action_taken: args.action_taken })) return false
  if (args.uses_estimate_as_truth === true) return false // organic/estimate can't validate a paid decision
  if (args.attributed_share != null && args.attributed_share < ATTRIBUTION_FLOOR) return false
  return true
}

/** PURE: assemble a ledger row, forcing the safety invariants and deriving action_taken + eligibility. */
export function buildSetupDecision(input: SetupDecisionInput): SetupDecisionRecord {
  const userDecision = input.user_decision ?? null
  const action_taken = userDecision ? derivesActionTaken(userDecision, input.action_taken_explicit) : (input.action_taken_explicit ?? false)
  const learning_eligibility = deriveLearningEligibility({
    user_decision: userDecision,
    action_taken,
    uses_estimate_as_truth: input.uses_estimate_as_truth,
    attributed_share: input.attributed_share,
  })
  return {
    ad_account_id: input.ad_account_id,
    entity_type: input.entity_type,
    entity_key: input.entity_key,
    entity_name: input.entity_name ?? null,
    campaign_id: input.campaign_id ?? null,
    adset_id: input.adset_id ?? null,
    ad_id: input.ad_id ?? null,
    setting_category: input.setting_category,
    setting_name: input.setting_name,
    previous_value: input.previous_value ?? null,
    proposed_value: input.proposed_value ?? null,
    final_value: input.final_value ?? null,
    actual_launched_value: input.actual_launched_value ?? null,
    origin: input.origin,
    recommended_by: input.recommended_by ?? null,
    reason: input.reason ?? null,
    evidence: input.evidence ?? null,
    data_source: input.data_source ?? null,
    date_range_start: input.date_range_start ?? null,
    date_range_end: input.date_range_end ?? null,
    target_range_considered: input.target_range_considered ?? null,
    confidence_label: input.confidence_label ?? null,
    risk_level: input.risk_level ?? null,
    alternatives_considered: input.alternatives_considered ?? null,
    conflicts_with_prior: input.conflicts_with_prior ?? false,
    prior_decision_id: input.prior_decision_id ?? null,
    change_summary: input.change_summary ?? null,
    why_changed: input.why_changed ?? null,
    prior_deprecated: input.prior_deprecated ?? false,
    switch_risk: input.switch_risk ?? null,
    // Maxx is approval-only: every setup/setting decision needs human approval (a conflicting switch
    // especially is never silent). action_allowed_now stays false regardless.
    approval_required: true,
    user_decision: userDecision,
    decision_note: input.decision_note ?? null,
    decided_by: input.decided_by ?? null,
    decision_date: input.decision_date ?? null,
    action_taken,
    action_taken_date: input.action_taken_date ?? null,
    follow_up_date: input.follow_up_date ?? null,
    recommendation_id: input.recommendation_id ?? null,
    change_request_id: input.change_request_id ?? null,
    learning_eligibility,
    write_mode_status: 'off',
    action_allowed_now: false,
  }
}

/** Did the value Meta actually shows match what we chose? null = not launched / unknown yet. */
export function launchedMatchesProposed(r: Pick<SetupDecisionRecord, 'setting_category' | 'final_value' | 'proposed_value' | 'actual_launched_value'>): boolean | null {
  if (r.actual_launched_value == null) return null
  const intended = r.final_value ?? r.proposed_value
  if (intended == null) return null
  return normalizeSettingValue(r.setting_category, intended) === normalizeSettingValue(r.setting_category, r.actual_launched_value)
}

/** The paid-attribution firewall: can this outcome VALIDATE the decision on its own? Organic-only /
 *  Meta-estimate-as-truth / sub-floor attribution ⇒ no (must go to human review, never auto-learn). */
export function canOutcomeValidate(args: { attributedShare?: number | null; usesEstimateAsTruth?: boolean; organicOnly?: boolean }): boolean {
  if (args.usesEstimateAsTruth === true) return false
  if (args.organicOnly === true) return false
  if (args.attributedShare == null) return false
  return args.attributedShare >= ATTRIBUTION_FLOOR
}

export type LedgerOutcomeState = 'pending' | 'inconclusive' | 'needs_review' | 'learned'

/** Outcome-time classification (after follow_up + data arrives). NEVER returns 'learned' on its own —
 *  'learned' requires an explicit owner `approved` (the review gate), and estimate-only never becomes
 *  trusted even when approved. */
export function classifyLedgerOutcome(args: {
  dataSufficient: boolean
  estimateOnly?: boolean
  organicOnly?: boolean
  attributedShare?: number | null
  decisiveResult?: boolean
  approved?: boolean
}): LedgerOutcomeState {
  if (!args.dataSufficient) return 'inconclusive' // low-data outcome is inconclusive
  if (args.decisiveResult === false) return 'inconclusive'
  if (args.estimateOnly === true) return 'needs_review' // estimate-only requires review, even if approved
  if (args.organicOnly === true || (args.attributedShare != null && args.attributedShare < ATTRIBUTION_FLOOR)) return 'needs_review'
  if (args.approved === true) return 'learned'
  return 'pending' // scored, awaiting owner review — never auto-trusted
}

// ── Graceful-degrading I/O (no-ops if `ad_setup_decisions` is unavailable) ───────────────────────────────

/** Insert one ledger row. Returns the new id, or null on any error (e.g. table absent). */
export async function insertSetupDecision(record: SetupDecisionRecord): Promise<string | null> {
  try {
    const db = getAdminClient()
    const { data, error } = await db.from('ad_setup_decisions').insert(record).select('id').single()
    if (error) {
      console.warn('[setup-ledger] insert skipped:', error.message)
      return null
    }
    return (data as { id: string }).id
  } catch (e) {
    console.warn('[setup-ledger] insert failed:', e instanceof Error ? e.message : String(e))
    return null
  }
}

/** The value a ledger row currently stands for: what actually launched > what was chosen > what was
 *  proposed. Both sides of a conflict comparison MUST use this (a manual action records only
 *  actual_launched_value — comparing against final_value alone would make later switches silent). */
export function currentValueOf(row: {
  actual_launched_value?: string | null
  final_value?: string | null
  proposed_value?: string | null
}): string | null {
  return row.actual_launched_value ?? row.final_value ?? row.proposed_value ?? null
}

/** The ACTIVE decision for a setting — the conflict-guard baseline. Skips retired rows
 *  (prior_deprecated=true: rejected or superseded by an approved switch) AND still-pending switches
 *  (conflicts_with_prior=true: never let an unapproved switch become the baseline). Falls back to an
 *  entity_name (+entity_type) match when the exact key finds nothing — a manifest row keyed by a
 *  planned-name slug and a manual action keyed by the real Meta id must still see each other.
 *  Returns null if none / table absent. */
export async function latestDecisionForSetting(
  adAccountDbId: string,
  entityKey: string,
  settingCategory: string,
  opts: { entityName?: string | null; entityType?: string | null; excludeId?: string } = {}
): Promise<{ id: string; current_value: string | null } | null> {
  try {
    const db = getAdminClient()
    const baseQuery = () => {
      let q = db
        .from('ad_setup_decisions')
        .select('id, actual_launched_value, final_value, proposed_value')
        .eq('ad_account_id', adAccountDbId)
        .eq('setting_category', settingCategory)
        .eq('prior_deprecated', false)
        .eq('conflicts_with_prior', false)
        .order('created_at', { ascending: false })
        .limit(1)
      if (opts.excludeId) q = q.neq('id', opts.excludeId)
      return q
    }

    const { data, error } = await baseQuery().eq('entity_key', entityKey).maybeSingle()
    if (error) return null
    let row = data as { id: string; actual_launched_value: string | null; final_value: string | null; proposed_value: string | null } | null

    if (!row && opts.entityName && opts.entityName.trim()) {
      let fq = baseQuery().eq('entity_name', opts.entityName)
      if (opts.entityType) fq = fq.eq('entity_type', opts.entityType)
      const { data: byName, error: nameErr } = await fq.maybeSingle()
      if (nameErr) return null
      row = byName as typeof row
    }

    if (!row) return null
    return { id: row.id, current_value: currentValueOf(row) }
  } catch {
    return null
  }
}

/** Slim row shape the UI surfaces read (subset of ad_setup_decisions columns). */
export interface LedgerRow {
  id: string
  entity_type: string
  entity_key: string
  entity_name: string | null
  setting_category: string
  setting_name: string
  previous_value: string | null
  proposed_value: string | null
  final_value: string | null
  actual_launched_value: string | null
  origin: LedgerOrigin
  reason: string | null
  user_decision: UserDecision | null
  decision_note: string | null
  decided_by: string | null
  action_taken: boolean
  conflicts_with_prior: boolean
  prior_decision_id: string | null
  prior_deprecated: boolean
  change_summary: string | null
  why_changed: string | null
  switch_risk: string | null
  follow_up_date: string | null
  created_at: string
}

/** Read the ledger for an account (newest first). Returns [] on error / table absent. */
export async function getLedgerForAccount(adAccountDbId: string, limit = 200): Promise<LedgerRow[]> {
  try {
    const db = getAdminClient()
    const { data, error } = await db
      .from('ad_setup_decisions')
      .select('*')
      .eq('ad_account_id', adAccountDbId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error || !data) return []
    return data as LedgerRow[]
  } catch {
    return []
  }
}

// ── Pure view selectors (UI surfaces) ──────────────────────────────────────────────────────────────────

/** Conflicting switches the human has not resolved. Resolution is marked ON THE ROW ITSELF (so it never
 *  depends on the prior row being inside the fetched window): approving a switch clears
 *  conflicts_with_prior (the audit trail stays in change_summary/prior_decision_id/why_changed);
 *  rejecting retires the row (prior_deprecated=true). Anything still flagged, un-retired, and not
 *  rejected is surfaced — a pending switch is never hidden. */
export function unresolvedConflicts(rows: LedgerRow[]): LedgerRow[] {
  return rows.filter((r) => r.conflicts_with_prior && !r.prior_deprecated && r.user_decision !== 'rejected')
}

/** Ledger history for one entity — matches the stable key, or the entity name when the key can't match
 *  (a manually-logged row may use a Meta id / planned slug while a rec uses the DB id). The name fallback
 *  is constrained to the same entity_type when given, so same-named entities at different levels
 *  (a campaign and an ad both called "Holiday promo") don't cross-match. */
export function historyForEntity(rows: LedgerRow[], entityKey: string, entityName?: string | null, entityType?: string | null): LedgerRow[] {
  return rows.filter(
    (r) =>
      r.entity_key === entityKey ||
      (entityName != null && entityName !== '' && r.entity_name === entityName && (entityType == null || r.entity_type === entityType))
  )
}

/** Which ledger setting categories a recommendation type would change. Setting-class rec types map to
 *  the settings they flip; flag-derived money/creative types map to the recorded decision they'd touch
 *  (scale/reduce_budget change the decided BUDGET; refresh_creative changes the decided CREATIVE) — so
 *  the citation is live in the real flag pipeline, not just for hypothetical setting-class producers.
 *  Pure reads (keep/hold/investigate/pause/…) return []. */
export function settingCategoriesForRecType(recType: string): string[] {
  switch (recType) {
    case 'change_optimization_event': return ['optimization_event', 'conversion_event']
    case 'change_audience': return ['audience']
    case 'restructure': return ['objective', 'placements']
    case 'scale':
    case 'reduce_budget':
    case 'scale_proposal': return ['budget']
    case 'refresh_creative': return ['creative']
    default: return []
  }
}

/** PURE: the ledger context a setting-class recommendation must cite — the ACTIVE recorded decision for
 *  the setting it proposes to change (entity-scoped, with account-level decisions as fallback). Returns
 *  null when the rec doesn't touch a recorded setting. This makes Maxx cite the prior decision instead of
 *  recommending a change blind to it; actually changing the setting still requires the conflict flow. */
export function settingDecisionContext(
  rows: LedgerRow[],
  entity: { entityKey: string; entityName?: string | null; entityType?: string | null },
  recType: string
): string | null {
  const categories = settingCategoriesForRecType(recType)
  if (categories.length === 0) return null
  const scoped = [
    ...historyForEntity(rows, entity.entityKey, entity.entityName, entity.entityType),
    ...rows.filter((r) => r.entity_key === 'account'),
  ]
  // Active = not retired and not a still-pending switch (same semantics as the conflict-guard baseline).
  const active = scoped.filter((r) => categories.includes(r.setting_category) && !r.prior_deprecated && !r.conflicts_with_prior)
  if (active.length === 0) return null
  const latest = active.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
  const value = currentValueOf(latest) ?? '—'
  const why = latest.reason ? ` (why: ${latest.reason})` : ''
  return `Recorded decision on ${latest.created_at.slice(0, 10)}: ${latest.setting_name} = ${value}${why}. This recommendation proposes changing a decided setting — it must go through the conflict flow (prior decision stays active until you approve the switch).`
}
