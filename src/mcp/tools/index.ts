import { ToolInputError, logToolError } from '@/lib/security/api-error'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { getAccountSummary } from './account-summary'
import { getDailyReport } from './daily-report'
import { getCampaignPerformance } from './campaign-performance'
import { getAlerts, getAuditTasks } from './alerts-tasks'
import { getCreativeFatigue } from './creative-fatigue'
import { getWinnerLoserFlags, getScaleCandidates, getWatchlist } from './flags'
import { getCreativeBriefs, getTestingBacklog } from './briefs'
import { createPausedTestDraft, pauseAd, activateAd, adjustBudget, duplicateAdSet } from './write-tools'
import { getCampaignPlans, previewCampaignPlan } from './campaign-plans'
import { getCompetitorAds, getCompetitorTrends } from './competitor-ads'
import { getCreativeInsights } from './creative-insights'
import { getAudienceBreakdown } from './audience-breakdown'
import { getActionLog } from './action-log'
import { getTrajectoryForecast } from './trajectory'
import { searchAgentMemory } from './memory'
import { getCreativeHealthScores } from './health-score'
import { getHookSuggestions, getCopyBank } from './copy-bank'
import { getDiscoveryFeed } from './discovery-feed'
import { getLearnings } from './learnings'
import { getDecisionHistory } from './decision-history'
import { getGa4ByCampaign } from './ga4-campaigns'
import { getBookingsByTypeDeprecated, getOutcomes, getOutcomesByLabel } from './outcomes'
import { getUtmHealth } from './utm-health'
import { getOperatingMode } from './operating-mode'
import { getLaunchReadiness } from './launch-readiness'
import { getLaunchPerformanceDiagnosis } from './diagnose-performance'
import { getExpertKnowledge } from './expert-knowledge'
import { getOpenRecommendationsTool } from './open-recommendations'
import { getPlaybookTool } from './playbook'
import { TOOL_DEFINITIONS } from './tool-definitions'
import { getEconomics } from './economics'
import { evaluateRecommendation, type EvaluateArgs } from './evaluate-recommendation'
import { getAuctionDiagnostics } from './auction-diagnostics'
import { getMetricAnomalies } from './metric-anomalies'
import { getReconciliation } from './reconciliation'
import { getDataDrift } from './data-drift'
import { getMetaRecommendations } from './meta-recommendations'
import { getDiagnosisBundle } from './diagnosis-bundle'
import { getPerformanceCockpit } from './performance-cockpit'

export { TOOL_DEFINITIONS } from './tool-definitions'

// Tool names that MUTATE state (proposal-only). Neither the in-app chat nor the MCP stdio server exposes
// them (isMcpExposedTool admits only READ_ONLY_TOOL_DEFINITIONS).
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'pause_ad', 'activate_ad', 'adjust_budget', 'duplicate_adset',
  'create_paused_test_draft',
])

/** The subset of tools safe for the read-only web chat: every read/search/evaluate tool, no writes. */
export const READ_ONLY_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => !WRITE_TOOLS.has(t.name))
const READ_ONLY_TOOL_NAMES = new Set(READ_ONLY_TOOL_DEFINITIONS.map((tool) => tool.name))

/** An unknown or unexposed tool name; its message names only the requested tool. */
class UnknownToolError extends Error {}

/** Production stdio is diagnostics-only until a server-bound CampaignPlan exists. */
export function isMcpExposedTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name)
}

/** Execute one tool by name and return its RAW JSON result. Single dispatcher shared by the MCP server
 *  (stdio) and the in-app chat route — no duplicate wiring. Throws on unknown tool. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  let result: unknown
      switch (name) {
        case 'get_performance_cockpit':
          result = await getPerformanceCockpit(args as { start_date?: string; end_date?: string })
          break
        case 'get_account_summary':
          result = await getAccountSummary(args as Record<string, string>)
          break
        case 'get_daily_report':
          result = await getDailyReport(args as { date?: string })
          break
        case 'get_campaign_performance':
          result = await getCampaignPerformance(args as Record<string, string>)
          break
        case 'get_creative_performance':
          result = await getCreativeFatigue(
            args as { start_date?: string; end_date?: string; min_spend?: number }
          )
          break
        case 'get_alerts':
          result = await getAlerts(
            args as {
              severity?: 'critical' | 'warning' | 'info'
              is_resolved?: boolean
              limit?: number
            }
          )
          break
        case 'get_audit_tasks':
          result = await getAuditTasks(
            args as { status?: string; priority?: string; limit?: number }
          )
          break
        case 'get_winner_loser_flags':
          result = await getWinnerLoserFlags(args as { flag_type?: string; audience_type?: string; window_days?: number; limit?: number })
          break
        case 'get_scale_candidates':
          result = await getScaleCandidates(args as { limit?: number })
          break
        case 'get_watchlist':
          result = await getWatchlist(args as { limit?: number })
          break
        case 'get_creative_briefs':
          result = await getCreativeBriefs(args as { limit?: number })
          break
        case 'get_testing_backlog':
          result = await getTestingBacklog(args as { limit?: number })
          break
        case 'get_competitor_ads':
          result = await getCompetitorAds(args as { competitor_id?: string; limit?: number })
          break
        case 'get_creative_insights':
          result = await getCreativeInsights(args as { days?: number; start_date?: string; end_date?: string })
          break
        case 'get_audience_breakdown':
          result = await getAudienceBreakdown(args as { breakdown_type?: 'age' | 'gender' | 'publisher_platform' | 'device_platform'; campaign_id?: string; days?: number; limit?: number })
          break
        case 'pause_ad':
          result = await pauseAd(args as { action_decision_id: string; ad_id: string; reason?: string })
          break
        case 'activate_ad':
          result = await activateAd(args as { action_decision_id: string; ad_id: string; reason?: string })
          break
        case 'adjust_budget':
          result = await adjustBudget(args as { action_decision_id: string; adset_id: string; new_daily_budget?: number; new_daily_budget_usd?: number; reason?: string })
          break
        case 'duplicate_adset':
          result = await duplicateAdSet(args as { action_decision_id: string; adset_id: string; new_name: string; new_daily_budget?: number; new_daily_budget_usd?: number })
          break
        case 'get_campaign_plans':
          result = await getCampaignPlans()
          break
        case 'preview_campaign_plan':
          result = await previewCampaignPlan(args)
          break
        case 'create_paused_test_draft':
          result = await createPausedTestDraft(args as Parameters<typeof createPausedTestDraft>[0])
          break
        case 'get_action_log':
          result = await getActionLog(args as { action_type?: string; entity_level?: string; meta_entity_id?: string; start_date?: string; end_date?: string; limit?: number })
          break
        case 'get_trajectory_forecast':
          result = await getTrajectoryForecast(args as { window_days?: number })
          break
        case 'get_competitor_trends':
          result = await getCompetitorTrends()
          break
        case 'search_agent_memory':
          result = await searchAgentMemory(args as { query: string; tags?: string[]; limit?: number })
          break
        case 'get_creative_health_scores':
          result = await getCreativeHealthScores(args as { min_spend?: number; limit?: number })
          break
        case 'get_hook_suggestions':
          result = await getHookSuggestions(args as { copy_type?: string; audience_type?: string; limit?: number; start_date?: string; end_date?: string })
          break
        case 'get_copy_bank':
          result = await getCopyBank(args as { copy_type?: string; audience_type?: string; limit?: number; start_date?: string; end_date?: string })
          break
        case 'get_discovery_feed':
          result = await getDiscoveryFeed(args as { min_days_running?: number; saved_only?: boolean; limit?: number })
          break
        case 'get_learnings':
          result = await getLearnings(args as { dimension?: string; verdict?: string; limit?: number })
          break
        case 'get_decision_history':
          result = await getDecisionHistory(args as { entity_key?: string; setting_category?: string; limit?: number })
          break
        case 'get_ga4_by_campaign':
          result = await getGa4ByCampaign(args as { start_date?: string; end_date?: string })
          break
        case 'get_outcomes':
          result = await getOutcomes(args as { start_date?: string; end_date?: string })
          break
        case 'get_outcomes_by_label':
          result = await getOutcomesByLabel(args as { start_date?: string; end_date?: string })
          break
        case 'get_bookings_by_type':
          // Deprecated alias for one release: answers with get_outcomes_by_label.
          result = await getBookingsByTypeDeprecated(args as { start_date?: string; end_date?: string })
          break
        case 'get_utm_health':
          result = await getUtmHealth(args as { start_date?: string; end_date?: string })
          break
        case 'get_operating_mode':
          result = await getOperatingMode()
          break
        case 'get_launch_readiness':
          result = await getLaunchReadiness(args as { landing_page_url?: string })
          break
        case 'diagnose_ad_performance':
          result = await getLaunchPerformanceDiagnosis(args as { window_days?: number })
          break
        case 'get_expert_knowledge':
          result = await getExpertKnowledge(args as { area?: string; topic?: string; limit?: number })
          break
        case 'get_recommendations':
          result = await getOpenRecommendationsTool(args as { limit?: number })
          break
        case 'get_playbook':
          result = getPlaybookTool(args as { intent?: string })
          break
        case 'get_economics':
          result = await getEconomics(args as { window_days?: number; start_date?: string; end_date?: string })
          break
        case 'get_auction_diagnostics':
          result = await getAuctionDiagnostics(args as { window_days?: number })
          break
        case 'get_metric_anomalies':
          result = await getMetricAnomalies(args as { window_days?: number })
          break
        case 'get_reconciliation':
          result = await getReconciliation(args as { window_days?: number; start_date?: string; end_date?: string })
          break
        case 'get_meta_recommendations':
          result = await getMetaRecommendations()
          break
        case 'get_data_drift':
          result = await getDataDrift()
          break
        case 'get_diagnosis_bundle':
          result = await getDiagnosisBundle(args as { window_days?: number })
          break
        case 'evaluate_recommendation':
          result = await evaluateRecommendation(args as unknown as EvaluateArgs)
          break
        default:
          throw new UnknownToolError(`UNKNOWN_TOOL: ${name}`)
  }
  return result
}

export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: READ_ONLY_TOOL_DEFINITIONS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      if (!isMcpExposedTool(name)) {
        throw new UnknownToolError(`READ_ONLY_MCP: tool ${name} is not exposed by the production stdio server`)
      }
      const result = await executeTool(name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      // Only messages this module or a tool authored reach the model; database and provider text
      // thrown by a tool is logged to stderr and replaced with a generic message.
      const unknownTool = error instanceof UnknownToolError
      const code = unknownTool ? 'UNKNOWN_TOOL' : 'TOOL_ERROR'
      const message = unknownTool || error instanceof ToolInputError
        ? error.message
        : logToolError(name, code, error)
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
        isError: true,
      }
    }
  })
}
