import { BUSINESS_PROFILE } from '@/config/business-profile'
import { getAdminClient } from '@/lib/supabase/admin'
import { nyToday } from '@/lib/utils/date-utils'
import { getExpertInsightsForRecommendations, type UsableInsight } from '@/lib/recommendations/knowledge'
import { HOOK_CORPUS, type HookPattern } from '@/lib/creative/hook-corpus'
import { runtimeCitableCorpus } from '@/lib/knowledge/corpus'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'

// MCP tool: the agent's diagnostic window into governed external knowledge. Closes brain-audit holes 2 + 14:
// the instructions mandate "only cite approved insights" but no tool let the agent FETCH them, and the
// cited hook-pattern corpus was reachable only by the brief generator. One stable shape, three shelves:
//   corpus            — general cited claims, projected without historical account-fit prose/settings
//   approved_insights — owner-APPROVED expert_insights only (fail-closed reuse of filterUsableInsights)
//   hook_patterns     — the cited hook-pattern corpus (creative area only)
// Read-only and non-prescriptive. Never a fact source about THIS account.

export interface CorpusEntryLite {
  key: string
  domain: string
  claim: string
  source: string
  tier: string
}

interface CorpusEntryCandidate extends CorpusEntryLite {
  /** Historical account-fit prose is accepted only so this projection can withhold it. */
  account_relevance?: string
}

/** Loose area→domain matching: 'budget'→budget_scaling, 'structure'/'audience'→structure_audience, etc. */
export function domainMatchesArea(domain: string, area: string): boolean {
  const a = area.toLowerCase()
  const d = domain.toLowerCase()
  return d === a || d.includes(a) || a.includes(d) || (a === 'economics' && d === 'profit_economics') || (a === 'landing' && d === 'landing_offer')
}

export interface ExpertKnowledgeResult {
  corpus: CorpusEntryLite[]
  approved_insights: UsableInsight[]
  hook_patterns: Pick<HookPattern, 'key' | 'name' | 'structure' | 'skeleton' | 'source' | 'evidence_tier'>[]
  action_authority_tier: 'diagnostic_only'
  setup_guidance_status: 'withheld'
  prescriptions: []
  withheld_account_context_count: number
  note: string
  read_health?: 'healthy' | 'unavailable'
  error_code?: string
}

// The corpus predates versioned owner context. Most account fit lives in account_relevance (always withheld),
// while some citable sentences themselves embed dollar thresholds or service-radius settings. Without a
// typed provenance flag, fail closed on those setting-shaped claims rather than maintaining a value allowlist.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const ACCOUNT_SETTING_CLAIM = new RegExp(String.raw`\$\s*\d|\b\d+(?:\.\d+)?[- ]?mile\b|\b${escapeRegExp(BUSINESS_PROFILE.name)}\b|\bthis account\b|\bcurrent structure\b`, 'i')

/** PURE: assemble the response from already-fetched shelves + filters (unit-testable). */
export function assembleExpertKnowledge(input: {
  corpus: CorpusEntryCandidate[]
  insights: UsableInsight[]
  area?: string
  topic?: string
  limit: number
}): Omit<ExpertKnowledgeResult, 'note'> {
  const { area, limit } = input
  const topic = input.topic?.toLowerCase().trim()

  let insights = input.insights
  if (area) insights = insights.filter((i) => i.applicable_area === null || i.applicable_area === area)
  if (topic) insights = insights.filter((i) => i.claim.toLowerCase().includes(topic))

  const safeCorpus = input.corpus
    .filter((entry) => !ACCOUNT_SETTING_CLAIM.test(entry.claim))
    .map(({ key, domain, claim, source, tier }) => ({ key, domain, claim, source, tier }))
  const withheldAccountContextCount = input.corpus.length - safeCorpus.length

  let corpus = safeCorpus
  if (area) corpus = corpus.filter((c) => domainMatchesArea(c.domain, area))
  if (topic) corpus = corpus.filter((c) => `${c.claim} ${c.domain}`.toLowerCase().includes(topic))

  // Hook patterns are creative knowledge — include for creative asks (or unfiltered asks mentioning hooks).
  const wantHooks = area === 'creative' || (!!topic && /hook|copy|headline|creative/.test(topic))
  const hook_patterns = wantHooks
    ? HOOK_CORPUS.map((h) => ({ key: h.key, name: h.name, structure: h.structure, skeleton: h.skeleton, source: h.source, evidence_tier: h.evidence_tier }))
    : []

  return {
    corpus: corpus.slice(0, limit),
    approved_insights: insights.slice(0, limit),
    hook_patterns,
    action_authority_tier: 'diagnostic_only',
    setup_guidance_status: 'withheld',
    prescriptions: [],
    withheld_account_context_count: withheldAccountContextCount,
  }
}

export async function getExpertKnowledge(args: { area?: string; topic?: string; limit?: number }): Promise<ExpertKnowledgeResult> {
  const limit = Math.min(Math.max(args?.limit ?? 10, 1), 25)

  // Owner-approved insights are account state. Ambiguity is not equivalent to an empty shelf.
  let insights: UsableInsight[] = []
  let readHealth: 'healthy' | 'unavailable' = 'healthy'
  let errorCode: string | undefined
  try {
    const db = getAdminClient()
    const activeAccount = await resolveOnlyActiveAccount(db)
    if (!activeAccount.ok) {
      readHealth = 'unavailable'
      errorCode = activeAccountErrorCode(activeAccount.reason)
    } else {
      insights = await getExpertInsightsForRecommendations(activeAccount.account.id, nyToday(), 50)
    }
  } catch {
    readHealth = 'unavailable'
    errorCode = 'ACTIVE_ACCOUNT_UNAVAILABLE'
  }

  const assembled = assembleExpertKnowledge({
    // The source record carries account-fit notes for history; assembleExpertKnowledge withholds them.
    corpus: runtimeCitableCorpus().map((e) => ({
      key: e.key,
      domain: e.domain,
      claim: e.claim,
      source: `${e.source.name}${e.source.url ? ` (${e.source.url})` : ''}`,
      tier: e.source.tier,
      account_relevance: e.account_relevance,
    })),
    insights,
    area: args?.area,
    topic: args?.topic,
    limit,
  })

  return {
    ...assembled,
    read_health: readHealth,
    ...(errorCode ? { error_code: errorCode } : {}),
    note:
      'DIAGNOSTIC ONLY external knowledge. approved_insights = owner-APPROVED external claims only; corpus = cited general context. ' +
      'Historical account-fit prose and fixed account settings are withheld. These claims may inspire a labeled test, but they are not a setup or action prescription. ' +
      'Return prescriptions exactly as empty until a current governed recommendation or approved CampaignPlan supplies authority.',
  }
}
