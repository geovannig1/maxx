import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount, activeAccountErrorCode } from '@/lib/accounts/active-account'
import { planBriefSchema } from '@/lib/campaigns/plan-brief'
import { buildTemplatePlan } from '@/lib/campaigns/plan-template'
import { loadPlanContext } from '@/lib/campaigns/plan-context'
import { evaluatePlan, listPlans, planSummary } from '@/lib/campaigns/plan-repository'

// ADR-062: campaign plans as the MCP server sees them. READ-ONLY by design: it lists the plans the
// owner drafted and can preview a deterministic template draft for a brief, validated against the
// account, without storing it and without calling a model. Drafting for real, submitting and approving
// stay in the owner console (and the owner's chat), behind the owner session.

export async function getCampaignPlans(): Promise<object> {
  const result = await listPlans()
  if (!result.ok) return { read_health: 'unavailable', error_code: result.code, plans: [] }
  return { read_health: 'healthy', plans: result.rows, note: 'Plans are drafted, submitted and approved in the Maxx console; this tool only reads them.' }
}

export async function previewCampaignPlan(args: Record<string, unknown>): Promise<object> {
  // Never a model call here: the preview is the deterministic planner whatever the caller asks.
  const parsed = planBriefSchema.safeParse({ ...args, use_ai: false })
  if (!parsed.success) return { error: 'The brief is incomplete or out of bounds.', error_code: 'INVALID_BRIEF', fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.')))] }
  const db = getAdminClient()
  const account = await resolveOnlyActiveAccount(db)
  if (!account.ok) return { error: 'The active ad account could not be resolved uniquely.', error_code: activeAccountErrorCode(account.reason) }
  const loaded = await loadPlanContext(db, account.account.id)
  if (!loaded.ok) return { error: 'The account data the planner needs could not be read.', error_code: loaded.code }
  const drafted = buildTemplatePlan(parsed.data, loaded.context.draft)
  const { validation, readiness } = evaluatePlan(drafted.spec, loaded.context)
  return {
    persisted: false, source: 'template', spec: drafted.spec, summary: planSummary(drafted.spec, loaded.context.account.currency),
    validation: validation.issues, readiness, notes: drafted.notes,
    note: 'A preview only: nothing was stored and nothing was sent to Meta. Draft and submit it in the Maxx console.',
  }
}
