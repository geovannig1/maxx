import { resolveOnlyActiveAccount, activeAccountErrorCode, type ActiveAccountErrorCode } from '@/lib/accounts/active-account'
import { decisionMapKey, entityKeyFor, type RecommendationDecision } from '@/lib/recommendations/decisions'
import { readOpenRecommendations } from '@/lib/recommendations/store'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday } from '@/lib/utils/date-utils'
import { projectDiagnosticAlert } from '@/lib/authority/diagnostic-surface'
import {
  buildDecisionQueue,
  type DecisionAuthority,
  type DecisionQueueAlertInput,
  type DecisionQueueItemV2,
  type DecisionQueueOutcomeInput,
  type DecisionQueueTaskInput,
} from './queue-v2'

export interface DecisionQueueReadModel {
  items: DecisionQueueItemV2[]
  notices: string[]
  accountErrorCode: ActiveAccountErrorCode | null
  generatedAt: string
}

export type DecisionQueueAccountRead = Omit<DecisionQueueReadModel, 'accountErrorCode'>
export interface DecisionQueueReadScope {
  alertScope?: 'unresolved_critical'
}

const ALERT_FIELDS = 'id, title, message, alert_type, severity, detected_at, alert_date, amount_at_risk'
const CRITICAL_ALERT_PAGE_SIZE = 100

/** The bell's API count is exact. Its destination therefore reads the same severity scope until the final short page. */
export async function readUnresolvedCriticalAlerts(
  db: Pick<ReturnType<typeof getAdminClient>, 'from'>,
  accountId: string,
) {
  const alerts: Array<Record<string, unknown>> = []
  for (let from = 0; ; from += CRITICAL_ALERT_PAGE_SIZE) {
    const { data, error } = await db.from('alerts')
      .select(ALERT_FIELDS)
      .eq('ad_account_id', accountId)
      .eq('is_resolved', false)
      .eq('severity', 'critical')
      .order('detected_at', { ascending: false })
      .range(from, from + CRITICAL_ALERT_PAGE_SIZE - 1)
    if (error) return { data: null, error }
    const page = (data ?? []) as Array<Record<string, unknown>>
    alerts.push(...page)
    if (page.length < CRITICAL_ALERT_PAGE_SIZE) return { data: alerts, error: null }
  }
}

function joinedDecision(value: unknown): { id: string | null; authority_tier: DecisionAuthority } {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || typeof candidate !== 'object') return { id: null, authority_tier: 'diagnostic_only' }
  const row = candidate as Record<string, unknown>
  const tier = row.authority_tier
  return {
    id: typeof row.id === 'string' ? row.id : null,
    authority_tier: tier === 'execution_eligible' || tier === 'owner_review' || tier === 'diagnostic_only'
      ? tier
      : 'diagnostic_only',
  }
}

export async function readDecisionQueueForAccount(
  db: ReturnType<typeof getAdminClient>,
  accountId: string,
  scope?: DecisionQueueReadScope,
): Promise<DecisionQueueAccountRead> {
  const notices: string[] = []

  const [recommendationResult, decisionsResult, alertsResult, tasksResult, outcomesResult, outcomeDecisionResult, eligibleRecommendationResult] = await Promise.allSettled([
    readOpenRecommendations(accountId, 100),
    db.from('recommendation_decisions')
      .select('entity_key, recommendation_type, user_decision, decision_note, decided_by, decision_date, action_taken, action_taken_date, follow_up_date, expected_outcome_window, learning_eligibility')
      .eq('ad_account_id', accountId),
    scope?.alertScope === 'unresolved_critical'
      ? readUnresolvedCriticalAlerts(db, accountId)
      : db.from('alerts')
        .select(ALERT_FIELDS)
        .eq('ad_account_id', accountId)
        .eq('is_resolved', false)
        .order('detected_at', { ascending: false })
        .limit(100),
    db.from('audit_tasks')
      .select('id, title, description, recommendation, priority, status, due_date, created_at, action_decision_id, action_decision:action_decisions(id, authority_tier)')
      .eq('ad_account_id', accountId)
      .in('status', ['open', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(100),
    db.from('recommendation_outcomes')
      .select('id, recommendation_id, recommendation, outcome, outcome_note, review_status, recommended_on, evaluate_after, evaluated_at, estimate_only')
      .eq('ad_account_id', accountId)
      .not('outcome', 'is', null)
      .order('evaluated_at', { ascending: false })
      .limit(100),
    db.from('recommendation_decisions')
      .select('recommendation_id, action_taken, learning_eligibility')
      .eq('ad_account_id', accountId)
      .eq('action_taken', true)
      .eq('learning_eligibility', true)
      .limit(1000),
    db.from('recommendations')
      .select('id, learning_eligibility')
      .eq('ad_account_id', accountId)
      .eq('learning_eligibility', true)
      .limit(1000),
  ])

  const recommendationRead = recommendationResult.status === 'fulfilled' ? recommendationResult.value : null
  if (!recommendationRead || recommendationRead.health === 'unavailable') {
    notices.push('Current recommendations are unavailable. Existing alerts, tasks, and outcome reviews remain independently visible.')
  } else if (recommendationRead.health === 'degraded') {
    notices.push('Some current recommendations were quarantined by their evidence or entity checks.')
  }
  const decisionResponse = decisionsResult.status === 'fulfilled' ? decisionsResult.value : null
  const decisionsHealthy = decisionResponse !== null && !decisionResponse.error
  const decisions = new Map<string, RecommendationDecision>()
  if (decisionsHealthy) {
    for (const row of (decisionResponse.data ?? []) as Array<RecommendationDecision & { entity_key: string; recommendation_type: string }>) {
      decisions.set(decisionMapKey(row.entity_key, row.recommendation_type), row)
    }
  } else {
    notices.push('Owner decision state is unavailable, so recommendation controls are withheld.')
  }

  const recommendations = decisionsHealthy
    ? (recommendationRead?.recommendations ?? []).map((row) => ({
        id: row.id,
        recommendation_type: row.recommendation_type,
        target_entity_type: row.target_entity_type,
        target_entity_id: row.target_entity_id,
        target_entity_name: row.target_entity_name,
        observed_fact: row.observed_fact,
        reason_for_action: row.reason_for_action,
        date_range_start: row.date_range_start,
        date_range_end: row.date_range_end,
        recommended_next_check_date: row.recommended_next_check_date,
        risk_level: row.risk_level,
        confidence_score: row.confidence_score,
        confidence_label: row.confidence_label,
        generated_at: row.generated_at,
        expected_upside: row.expected_upside,
        possible_downside: row.possible_downside,
        minimum_data_needed: row.minimum_data_needed,
        metric_claim_ids: row.metric_claim_ids,
        metric_claim_lineage_verified: row.metric_claim_lineage_verified,
        action_authority_tier: row.action_authority_tier,
        action_decision_id: row.action_decision?.id ?? null,
        current_state: row.action_decision?.metrics ?? null,
        proposed_state: row.action_decision?.proposed_mutation ?? null,
        authority_version: row.action_decision?.policy_version ?? null,
        authority_target_level: row.action_decision?.target_level ?? null,
        authority_target_id: row.action_decision?.target_id ?? null,
        target_language: row.target_language,
        learning_eligibility: row.learning_eligibility,
        evidence: recommendationRead?.evidence?.get(row.id) ?? [],
        decision: decisions.get(decisionMapKey(entityKeyFor(row.target_entity_id), row.recommendation_type)) ?? null,
      }))
    : []

  const alertResponse = alertsResult.status === 'fulfilled' ? alertsResult.value : null
  if (!alertResponse || alertResponse.error) notices.push('Alert notifications are unavailable.')
  const alerts = ((alertResponse?.data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const safe = projectDiagnosticAlert(row)
    return {
      id: String(safe.id),
      title: String(safe.title),
      message: String(safe.message),
      alert_type: String(safe.alert_type),
      severity: String(safe.severity ?? 'warning'),
      detected_at: String(safe.detected_at ?? new Date(0).toISOString()),
      alert_date: typeof safe.alert_date === 'string' ? safe.alert_date : null,
      amount_at_risk: null,
    } satisfies DecisionQueueAlertInput
  })

  const taskResponse = tasksResult.status === 'fulfilled' ? tasksResult.value : null
  if (!taskResponse || taskResponse.error) notices.push('Manual task records are unavailable.')
  const tasks = ((taskResponse?.data ?? []) as Array<Record<string, unknown>>).map((row): DecisionQueueTaskInput => {
    const authority = joinedDecision(row.action_decision)
    return {
      id: String(row.id),
      title: String(row.title ?? 'Owner task'),
      description: typeof row.description === 'string' ? row.description : null,
      recommendation: typeof row.recommendation === 'string' ? row.recommendation : null,
      priority: String(row.priority ?? 'medium'),
      status: String(row.status ?? 'open'),
      due_date: typeof row.due_date === 'string' ? row.due_date : null,
      created_at: String(row.created_at ?? new Date(0).toISOString()),
      action_authority_tier: authority.authority_tier,
      action_decision_id: authority.id,
    }
  })

  const outcomeResponse = outcomesResult.status === 'fulfilled' ? outcomesResult.value : null
  if (!outcomeResponse || outcomeResponse.error) notices.push('Outcome-review records are unavailable.')
  const eligibleRecommendationResponse = eligibleRecommendationResult.status === 'fulfilled'
    ? eligibleRecommendationResult.value
    : null
  const outcomeDecisionResponse = outcomeDecisionResult.status === 'fulfilled'
    ? outcomeDecisionResult.value
    : null
  if (!eligibleRecommendationResponse || eligibleRecommendationResponse.error
      || !outcomeDecisionResponse || outcomeDecisionResponse.error) {
    notices.push('Outcome-contract or implementation lineage is unavailable; learning review is withheld.')
  }
  const eligibleRecommendationIds = new Set(((eligibleRecommendationResponse?.data ?? []) as Array<{ id: string }>).map((row) => row.id))
  const implementedEligibleIds = new Set(((outcomeDecisionResponse?.data ?? []) as Array<{ recommendation_id: string | null }>).flatMap((row) => row.recommendation_id ? [row.recommendation_id] : []))
  const outcomes = ((outcomeResponse?.data ?? []) as Array<Record<string, unknown>>).map((row): DecisionQueueOutcomeInput => {
    const recommendationId = typeof row.recommendation_id === 'string' ? row.recommendation_id : null
    return {
      id: String(row.id),
      recommendation: String(row.recommendation ?? 'Outcome observation'),
      outcome: String(row.outcome ?? 'inconclusive'),
      outcome_note: typeof row.outcome_note === 'string' ? row.outcome_note : null,
      review_status: typeof row.review_status === 'string' ? row.review_status : null,
      recommended_on: String(row.recommended_on),
      evaluate_after: String(row.evaluate_after),
      evaluated_at: typeof row.evaluated_at === 'string' ? row.evaluated_at : null,
      estimate_only: typeof row.estimate_only === 'boolean' ? row.estimate_only : null,
      learning_eligibility: recommendationId !== null && eligibleRecommendationIds.has(recommendationId),
      action_evidence: recommendationId !== null && implementedEligibleIds.has(recommendationId),
    }
  })

  return {
    items: buildDecisionQueue({ recommendations, alerts, tasks, outcomes, today: nyToday() }),
    notices,
    generatedAt: new Date().toISOString(),
  }
}

export async function readDecisionQueue(scope?: DecisionQueueReadScope): Promise<DecisionQueueReadModel> {
  const db = getAdminClient()
  const active = await resolveOnlyActiveAccount(db)
  if (!active.ok) {
    return {
      items: [],
      notices: [],
      accountErrorCode: activeAccountErrorCode(active.reason),
      generatedAt: new Date().toISOString(),
    }
  }
  const data = await readDecisionQueueForAccount(db, active.account.id, scope)
  return { ...data, accountErrorCode: null }
}
