import { createClient } from '@/lib/supabase/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { USER_DECISIONS } from '@/lib/recommendations/decisions'
import {
  LEDGER_ORIGINS,
  SETTING_CATEGORIES,
  buildSetupDecision,
  insertSetupDecision,
  latestDecisionForSetting,
  entityKeyForSetup,
} from '@/lib/recommendations/setup-ledger'
import { evaluateConflict, buildRevisionGuidance } from '@/lib/recommendations/conflict-guard'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { rejectCrossOriginMutation } from '@/lib/security/same-origin'

export const runtime = 'nodejs'

// POST /api/setup-decisions — record one SETTING-level setup decision or manual action in the Ad
// Decision Ledger. Records INTENT ONLY: it never executes a change, never calls the Meta API, and write
// mode stays OFF (the row is schema-forced to write_mode_status='off' / action_allowed_now=false).
// Before inserting, the conflict guard compares the new value against the latest recorded decision for
// the same (entity, setting) — a contradicting switch is flagged and requires explicit approval; it is
// never silent and never auto-deprecates the prior decision. Auth-gated to a signed-in user.
const bodySchema = z.object({
  entity_type: z.enum(['account', 'campaign', 'adset', 'ad', 'audience', 'creative']),
  entity_id: z.string().max(200).optional(),      // real Meta/DB id when known
  planned_name: z.string().max(200).optional(),   // pre-launch campaign name (slugged into the stable key)
  entity_name: z.string().max(200).optional(),
  setting_category: z.enum(SETTING_CATEGORIES), // boundary-validated: free text would silently dodge the per-category conflict normalizers
  setting_name: z.string().min(1).max(120),
  previous_value: z.string().max(2000).optional(),
  proposed_value: z.string().max(2000).optional(),
  final_value: z.string().max(2000).optional(),
  actual_launched_value: z.string().max(2000).optional(),
  origin: z.enum(LEDGER_ORIGINS),
  reason: z.string().max(4000).optional(),
  evidence: z.string().max(4000).optional(),
  data_source: z.string().max(200).optional(),
  alternatives_considered: z.string().max(4000).optional(),
  switch_risk: z.string().max(2000).optional(),
  why_changed: z.string().max(2000).optional(),
  user_decision: z.enum(USER_DECISIONS).optional(),
  decision_note: z.string().max(2000).optional(),
  action_taken: z.boolean().optional(),
  follow_up_date: z.string().max(20).optional(),
  recommendation_id: z.string().uuid().optional(),
})

export async function POST(req: NextRequest) {
  const crossOrigin = rejectCrossOriginMutation(req)
  if (crossOrigin) return crossOrigin
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await req.json())
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (body.origin === 'launch_setup') {
    // ADR-062: launch setups are campaign plans now. A ledger row cannot stand in for one: the client
    // could send identifiers and a well-formed hash, and accepting those caller claims would recreate
    // the placeholder side door this boundary closes. Plans are drafted, validated and approved at
    // /campaigns/new and created PAUSED through /changes.
    return Response.json({
      error: 'Launch setups are campaign plans now: plan, approve and create it paused at /campaigns/new (ADR-062).',
      code: 'USE_CAMPAIGN_PLANS',
      reason_codes: ['use_campaign_plans'],
    }, { status: 409 })
  }

  const admin = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(admin)
  if (!activeAccount.ok) {
    const status = activeAccount.reason === 'not_found' ? 404 : activeAccount.reason === 'ambiguous' ? 409 : 503
    const error = activeAccount.reason === 'not_found'
      ? 'No active ad account configured'
      : activeAccount.reason === 'ambiguous'
        ? 'More than one active ad account is configured'
        : 'The active ad account could not be resolved'
    return Response.json({
      error,
      code: activeAccountErrorCode(activeAccount.reason),
    }, { status })
  }
  const adAccountDbId = activeAccount.account.id

  const entityKey = entityKeyForSetup(body.entity_id ?? null, body.planned_name ?? null)

  // The value this decision would make current: launched (already done) > chosen > proposed.
  const newValue = body.actual_launched_value ?? body.final_value ?? body.proposed_value ?? null

  // Conflict guard: compare against the ACTIVE decision for this setting (coalesced value; name+type
  // fallback so manifest slugs and Meta-id manual actions see each other; pending switches excluded).
  const prior = await latestDecisionForSetting(adAccountDbId, entityKey, body.setting_category, {
    entityName: body.entity_name ?? body.planned_name ?? null,
    entityType: body.entity_type,
  })
  const assessment = prior
    ? evaluateConflict(
        { setting_category: body.setting_category, final_value: prior.current_value },
        { setting_category: body.setting_category, proposed_value: newValue }
      )
    : null
  const guidance = assessment?.conflicts
    ? buildRevisionGuidance(assessment, {
        why_better: body.why_changed,
        risk_of_switching: body.switch_risk,
        prior_decision_id: prior!.id,
        // Never auto-deprecate here — the switch is approved via PATCH { approve_switch: true }.
        deprecate_prior: false,
      })
    : null

  const nowIso = new Date().toISOString()
  // Entity linkage for outcome scoring (Step 14b): when the caller gives a real entity id, store it in
  // the level-specific column so the post-action window can be scoped to THIS entity instead of the
  // account. Without it, a setting decision would be judged by account-wide delivery.
  const entityId = body.entity_id?.trim() || null
  const record = buildSetupDecision({
    ad_account_id: adAccountDbId,
    entity_type: body.entity_type,
    entity_key: entityKey,
    campaign_id: body.entity_type === 'campaign' ? entityId : null,
    adset_id: body.entity_type === 'adset' ? entityId : null,
    ad_id: body.entity_type === 'ad' ? entityId : null,
    entity_name: body.entity_name ?? body.planned_name ?? null,
    setting_category: body.setting_category,
    setting_name: body.setting_name,
    previous_value: body.previous_value ?? prior?.current_value ?? null,
    proposed_value: body.proposed_value ?? null,
    final_value: body.final_value ?? null,
    actual_launched_value: body.actual_launched_value ?? null,
    origin: body.origin,
    recommended_by: body.origin === 'manual_action' ? (user.email ?? user.id) : 'maxx',
    reason: body.reason ?? null,
    evidence: body.evidence ?? null,
    data_source: body.data_source ?? null,
    alternatives_considered: body.alternatives_considered ?? null,
    conflicts_with_prior: guidance?.conflicts_with_prior ?? false,
    prior_decision_id: guidance?.prior_decision_id ?? null,
    change_summary: guidance?.change_summary ?? null,
    why_changed: guidance?.why_changed ?? null,
    // A row REJECTED at insert is retired immediately — it must never become the conflict baseline
    // (mirrors the PATCH rule; the prior decision stays active).
    prior_deprecated: body.user_decision === 'rejected',
    switch_risk: body.switch_risk ?? null,
    user_decision: body.user_decision ?? null,
    decision_note: body.decision_note ?? null,
    decided_by: body.user_decision ? (user.email ?? user.id) : null,
    decision_date: body.user_decision ? nowIso : null,
    action_taken_explicit: body.action_taken,
    action_taken_date: undefined, // set below from the derived flag
    follow_up_date: body.follow_up_date ?? null,
    recommendation_id: body.recommendation_id ?? null,
  })
  if (record.action_taken) record.action_taken_date = nowIso

  const id = await insertSetupDecision(record)
  if (!id) return Response.json({ error: 'Ledger insert failed' }, { status: 500 })

  // Explicit contract: recording a decision changes nothing live.
  return Response.json({
    id,
    conflict: guidance, // null when the new value agrees with the prior decision
    action_allowed_now: false,
    write_mode: 'off',
    message: guidance
      ? 'Recorded WITH a conflict flag — this contradicts a prior decision for the same setting. The prior stays active until you approve the switch. Nothing was executed.'
      : 'Recorded. This is a ledger entry only; nothing was executed.',
  })
}
