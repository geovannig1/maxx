import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { USER_DECISIONS, derivesActionTaken, type UserDecision } from '@/lib/recommendations/decisions'
import {
  deriveLearningEligibility,
  latestDecisionForSetting,
  launchedMatchesProposed,
  currentValueOf,
} from '@/lib/recommendations/setup-ledger'
import { evaluateConflict } from '@/lib/recommendations/conflict-guard'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// PATCH /api/setup-decisions/[id] — update one ledger row: record the human's decision, the final or
// actually-launched value, or approve a flagged switch. INTENT ONLY — nothing executes, write mode stays
// OFF. `approve_switch:true` is the ONLY path that deprecates a prior conflicting decision, and it is an
// explicit human act (the conflict guard never auto-deprecates). Auth-gated to a signed-in user.
const bodySchema = z
  .object({
    user_decision: z.enum(USER_DECISIONS).optional(),
    decision_note: z.string().max(2000).optional(),
    final_value: z.string().max(2000).optional(),
    actual_launched_value: z.string().max(2000).optional(),
    action_taken: z.boolean().optional(),
    follow_up_date: z.string().max(20).optional(),
    approve_switch: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Empty patch' })

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const { id } = await params

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const admin = getAdminClient()
  const { data: row, error: rowErr } = await admin
    .from('ad_setup_decisions')
    .select(
      'id, ad_account_id, entity_key, entity_name, entity_type, setting_category, proposed_value, final_value, actual_launched_value, conflicts_with_prior, prior_decision_id, user_decision, action_taken, origin'
    )
    .eq('id', id)
    .maybeSingle()
  if (rowErr) return apiErrorResponse('PATCH /api/setup-decisions/[id]', 'SETUP_DECISION_READ_FAILED', rowErr, 500)
  if (!row) return Response.json({ error: 'Ledger row not found' }, { status: 404 })
  if (row.origin === 'launch_setup') {
    return Response.json({
      error: 'Legacy launch-setup rows are read-only. New campaigns are planned, approved and created paused as campaign plans (/campaigns/new, ADR-062).',
      code: 'USE_CAMPAIGN_PLANS',
      reason_codes: ['use_campaign_plans'],
    }, { status: 409 })
  }

  const activeAccount = await resolveOnlyActiveAccount(admin)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    return Response.json({
      error: activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : activeAccount.reason === 'not_found'
          ? 'No active ad account found'
          : 'The active ad account could not be resolved',
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }
  if (row.ad_account_id !== activeAccount.account.id) {
    return Response.json({
      error: 'Ledger row does not belong to the active ad account',
      code: 'LEDGER_ROW_OUTSIDE_ACTIVE_ACCOUNT',
    }, { status: 404 })
  }
  const adAccountId = activeAccount.account.id

  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = { updated_at: nowIso }

  // learning_eligibility follows the (possibly updated) decision + action state in EITHER branch — the
  // "Record launched" flow (action_taken only) must become review-eligible too. This flag is
  // informational at decision time; the authoritative gating (estimate/attribution/low-data rules)
  // happens at outcome scoring (classifyLedgerOutcome) and at the human review gate.
  if (body.user_decision) {
    const action_taken = derivesActionTaken(body.user_decision, body.action_taken ?? (row.action_taken as boolean))
    patch.user_decision = body.user_decision
    patch.decided_by = user.email ?? user.id
    patch.decision_date = nowIso
    patch.action_taken = action_taken
    if (action_taken && !(row.action_taken as boolean)) patch.action_taken_date = nowIso
    patch.learning_eligibility = deriveLearningEligibility({ user_decision: body.user_decision, action_taken })
  } else if (body.action_taken !== undefined) {
    patch.action_taken = body.action_taken
    if (body.action_taken && !(row.action_taken as boolean)) patch.action_taken_date = nowIso
    const decision = (row.user_decision as UserDecision | null) ?? null
    if (decision) {
      patch.learning_eligibility = deriveLearningEligibility({ user_decision: decision, action_taken: body.action_taken })
    }
  }
  if (body.decision_note !== undefined) patch.decision_note = body.decision_note
  if (body.final_value !== undefined) patch.final_value = body.final_value
  if (body.actual_launched_value !== undefined) patch.actual_launched_value = body.actual_launched_value
  if (body.follow_up_date !== undefined) patch.follow_up_date = body.follow_up_date

  // `prior_deprecated` means "THIS row is retired as the active decision for its setting" — it is what
  // latestDecisionForSetting() filters on. A REJECTED conflicting row is retired (it must never become
  // the conflict-guard baseline); the NEW row of an approved switch stays active (prior_deprecated=false).
  if (body.user_decision === 'rejected') patch.prior_deprecated = true

  // The row's state after this patch (used by the guard re-run and the drift check below).
  const merged = {
    setting_category: row.setting_category as string,
    proposed_value: row.proposed_value as string | null,
    final_value: (body.final_value ?? row.final_value) as string | null,
    actual_launched_value: (body.actual_launched_value ?? row.actual_launched_value) as string | null,
  }

  // Changing what the row stands for (final/launched value) re-runs the conflict guard — PATCH must not
  // be a silent-switch side door. The guard sets OR CLEARS the conflict fields so a fixed value doesn't
  // keep a stale "switch pending" flag. Skipped when this call is itself the switch approval.
  if ((body.final_value !== undefined || body.actual_launched_value !== undefined) && body.approve_switch !== true) {
    const prior = await latestDecisionForSetting(
      row.ad_account_id as string,
      row.entity_key as string,
      row.setting_category as string,
      { entityName: row.entity_name as string | null, entityType: row.entity_type as string | null, excludeId: id }
    )
    if (prior) {
      const assessment = evaluateConflict(
        { setting_category: row.setting_category as string, final_value: prior.current_value },
        { setting_category: row.setting_category as string, proposed_value: currentValueOf(merged) }
      )
      patch.conflicts_with_prior = assessment.conflicts
      patch.prior_decision_id = assessment.conflicts ? prior.id : null
      patch.change_summary = assessment.change_summary
    } else {
      patch.conflicts_with_prior = false
      patch.prior_decision_id = null
      patch.change_summary = null
    }
  }

  // Approving a flagged switch: the explicit human act that retires the PRIOR decision and clears the
  // pending flag on THIS row (the audit trail stays in change_summary / prior_decision_id / why_changed).
  let switchApproved = false
  if (body.approve_switch === true && row.conflicts_with_prior && row.prior_decision_id) {
    const { error: priorErr } = await admin
      .from('ad_setup_decisions')
      .update({ prior_deprecated: true, updated_at: nowIso })
      .eq('id', row.prior_decision_id as string)
      .eq('ad_account_id', adAccountId)
    if (priorErr) return apiErrorResponse('PATCH /api/setup-decisions/[id]', 'SETUP_DECISION_READ_FAILED', priorErr, 500)
    patch.conflicts_with_prior = false
    switchApproved = true
  }

  const { data, error } = await admin
    .from('ad_setup_decisions')
    .update(patch)
    .eq('id', id)
    .eq('ad_account_id', adAccountId)
    .select('id, user_decision, action_taken, final_value, actual_launched_value, prior_deprecated, conflicts_with_prior, change_summary')
    .single()
  if (error) return apiErrorResponse('PATCH /api/setup-decisions/[id]', 'SETUP_DECISION_WRITE_FAILED', error, 500)

  // Launched-vs-plan drift (null = not comparable): what Meta actually shows vs what was decided.
  const launched_matches_plan = launchedMatchesProposed(merged)

  // Explicit contract: updating the ledger changes nothing live.
  return Response.json({
    data,
    switch_approved: switchApproved,
    launched_matches_plan,
    action_allowed_now: false,
    write_mode: 'off',
  })
}
