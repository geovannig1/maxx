import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAudience, type AudienceRef, type AudienceResolution } from '@/lib/audience/resolver'
import {
  conversionActionability, deliveryFactActionability, resolveOptimizationEventEvidence,
  type ConversionActionability, type SignalReading, type OptimizationEventEvidence,
} from '@/lib/trust/conversion-actionability'
import { analyzeCreativeDiversity, type DiversityReport, type CreativeMetadata } from '@/lib/creative/identity'
import { getGa4ConfirmationTelemetryBySource, isMetaPaidChannel } from '@/lib/ga4/client'
import { buildGa4ReconciliationBlock, exactPaidEvidence } from '@/lib/ga4/booking-reconciliation'
import { decideRecommendation, type DecisionResult, type DecisionInputs, type RecommendationKind, type TestBrief, type ScopedOutcomeEvidence } from './decision-policy'
import type { RecommendationType } from './types'
import {
  applicableCausalEvidence, applicableConflicts, type ExperimentRecord, type CausalEvidenceResult,
} from './causal-evidence'
import { formatMoney, fromMinorUnits, toMinorUnits } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// THE PRODUCTION WIRING for the evidence brain.
//
// The real defect: decideRecommendation, conversionActionability,
// resolveOptimizationEventEvidence, analyzeCreativeDiversity and the audience resolver had ZERO
// callers in src/. Their unit tests passed while the daily pipeline reached none of them, so the
// recommendation engine kept emitting money-moving actions on exactly the evidence the policy was
// written to reject. This module is the bridge, and `generateRecommendationsFromFlags` calls it.
//
// Everything degrades to a FROZEN / unresolved state on a read failure, never to a permissive one.

/** Recommendation types that move money and therefore require the full decision gate. */
export const MONEY_MOVING_TYPES: ReadonlySet<RecommendationType> = new Set<RecommendationType>([
  'scale', 'reduce_budget', 'scale_proposal', 'pause', 'activate',
])

/** Map an app recommendation type onto the policy's recommendation kind. */
export function kindForRecommendationType(t: RecommendationType): RecommendationKind | null {
  if (t === 'scale' || t === 'scale_proposal') return 'scale'
  if (t === 'reduce_budget') return 'budget'
  if (t === 'pause' || t === 'activate') return 'pause'
  if (t === 'refresh_creative' || t === 'creative_test') return 'refresh'
  return null
}

export interface AccountEvidence {
  /** Resolved audience per ad set DB id. Missing entries mean unresolved -> frozen. */
  audienceByAdset: Map<string, AudienceResolution>
  conversions: ConversionActionability
  delivery: ConversionActionability
  optimizationEvents: OptimizationEventEvidence
  /** Creative diversity per ad set DB id, plus an account-wide view. */
  diversityByAdset: Map<string, DiversityReport>
  accountDiversity: DiversityReport
  /** changed_variable values of currently RUNNING experiments. */
  runningExperimentVariables: string[]
  /** Full experiment records; the decision gate scopes them per entity + changed variable. */
  experiments: ExperimentRecord[]
  /** Ad-set budget structure: 'cbo' when the parent campaign carries a budget. */
  budgetStructureByAdset: Map<string, 'cbo' | 'abo' | 'unknown'>
  dailyBudgetByAdset: Map<string, number | null>
  /** Campaign DB id -> its member ad-set DB ids, for conservative campaign-level roll-up. */
  adsetIdsByCampaign: Map<string, string[]>
  /** Campaign DB id -> its own budget structure and daily budget. A CAMPAIGN flag has no adset_id,
   *  so without these its decision context could only ever resolve to unknown/frozen. */
  budgetStructureByCampaign: Map<string, 'cbo' | 'abo' | 'unknown'>
  dailyBudgetByCampaign: Map<string, number | null>
  windowDays: number
  /** Non-fatal problems encountered while gathering. Surfaced, never swallowed. */
  gatherWarnings: string[]
}

/** An unresolved account: every conclusion frozen. Used when gathering fails. */
export function frozenEvidence(windowDays: number, reason: string): AccountEvidence {
  const emptyDiversity: DiversityReport = {
    totalAds: 0, distinctAssets: 0, duplicates: [], distinctConcepts: null, distinctCreators: null,
    distinctHookStyles: null, distinctAspectRatios: 0, weakIdentityAds: [], notes: [reason],
  }
  return {
    audienceByAdset: new Map(),
    conversions: conversionActionability({
      metaConversions: null, viewThroughConversions: null, firstPartyBookings: null,
      ga4PaidConfirmationEvents: null, firstPartyClickCoverage: null, inLearning: null,
      audienceComposition: 'unknown', hasCausalEvidence: false,
    }),
    delivery: deliveryFactActionability(false, null),
    optimizationEvents: resolveOptimizationEventEvidence([]),
    diversityByAdset: new Map(),
    accountDiversity: emptyDiversity,
    runningExperimentVariables: [],
    experiments: [],
    budgetStructureByAdset: new Map(),
    dailyBudgetByAdset: new Map(),
    adsetIdsByCampaign: new Map(),
    budgetStructureByCampaign: new Map(),
    dailyBudgetByCampaign: new Map(),
    windowDays,
    gatherWarnings: [reason],
  }
}

interface AdsetRow {
  id: string
  adset_id: string | null
  adset_name: string | null
  targeting: Record<string, unknown> | null
  targeting_last_synced_at: string | null
  last_synced_at: string | null
  campaign_id: string | null
  daily_budget: number | null
  learning_stage: string | null
}

/**
 * Gather every evidence plane the decision policy needs, for one account and window.
 * Read failures produce FROZEN evidence, never permissive defaults.
 */
export async function gatherAccountEvidence(
  db: SupabaseClient,
  adAccountDbId: string,
  metaAccountId: string,
  opts: { today: string; windowDays: number; nowMs?: number },
): Promise<AccountEvidence> {
  const warnings: string[] = []
  const nowMs = opts.nowMs ?? Date.now()
  const since = subDays(opts.today, opts.windowDays - 1)

  // ── Ad sets + targeting freshness ──────────────────────────────────────────────────────────────
  const audienceByAdset = new Map<string, AudienceResolution>()
  const budgetStructureByAdset = new Map<string, 'cbo' | 'abo' | 'unknown'>()
  const dailyBudgetByAdset = new Map<string, number | null>()
  const adsetIdsByCampaign = new Map<string, string[]>()
  const budgetStructureByCampaign = new Map<string, 'cbo' | 'abo' | 'unknown'>()
  const dailyBudgetByCampaign = new Map<string, number | null>()
  let adsets: AdsetRow[] = []
  try {
    const { data, error } = await db
      .from('adsets')
      .select('id, adset_id, adset_name, targeting, targeting_last_synced_at, last_synced_at, campaign_id, daily_budget, learning_stage')
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(error.message)
    adsets = (data ?? []) as AdsetRow[]
  } catch (e) {
    warnings.push(`ad set read failed (${msg(e)}) — audience conclusions frozen`)
  }

  // Campaign budgets decide CBO vs ABO. An unreadable campaign means an UNKNOWN unit, not ABO.
  const campaignBudget = new Map<string, { daily: number | null; lifetime: number | null }>()
  try {
    // PostgREST reports a permission/schema failure in `error` rather than throwing, so destructuring
    // only `data` produced EMPTY campaign maps with no warning: decisions still failed closed, but the
    // operator was never told WHY campaign/CBO context had disappeared.
    const { data, error } = await db
      .from('campaigns')
      .select('id, daily_budget, lifetime_budget')
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(error.message)
    for (const c of (data ?? []) as Array<{ id: string; daily_budget: number | null; lifetime_budget: number | null }>) {
      campaignBudget.set(c.id, { daily: c.daily_budget, lifetime: c.lifetime_budget })
      // A campaign carrying a budget IS the CBO unit; one without is ABO (its ad sets hold budgets).
      budgetStructureByCampaign.set(c.id, c.daily_budget !== null || c.lifetime_budget !== null ? 'cbo' : 'abo')
      dailyBudgetByCampaign.set(c.id, c.daily_budget)
    }
  } catch (e) {
    warnings.push(`campaign budget read failed (${msg(e)}) — campaign/CBO context is UNAVAILABLE, so the optimization unit and any campaign-level decision resolve to unknown and freeze`)
  }

  // Custom-audience metadata: subtype + owning account. Missing metadata must FREEZE material
  // conclusions rather than let an unresolved audience read as benign.
  const audiencesById = await fetchAudienceMetadata(db, adAccountDbId, warnings)

  for (const a of adsets) {
    // targeting_last_synced_at is the targeting-specific stamp; fall back to the row's own sync time.
    const syncedAt = a.targeting_last_synced_at ?? a.last_synced_at ?? null
    const resolved = resolveAudience(
      {
        adsetName: a.adset_name,
        targeting: a.targeting,
        targetingSyncedAt: syncedAt,
        accountId: metaAccountId, // the REAL Meta account id, not a placeholder
        audiencesById,
      },
      nowMs,
    )
    audienceByAdset.set(a.id, resolved)
    dailyBudgetByAdset.set(a.id, a.daily_budget)
    if (a.campaign_id) {
      adsetIdsByCampaign.set(a.campaign_id, [...(adsetIdsByCampaign.get(a.campaign_id) ?? []), a.id])
    }
    const cb = a.campaign_id ? campaignBudget.get(a.campaign_id) : undefined
    budgetStructureByAdset.set(
      a.id,
      cb === undefined ? 'unknown' : cb.daily !== null || cb.lifetime !== null ? 'cbo' : 'abo',
    )
  }

  // ── Experiments (full records; scoping happens per decision) ───────────────────────────────────
  // A single account-global "any successful experiment" boolean let a CREATIVE test unlock an
  // unrelated BUDGET move. The records are loaded once and matched per decision by entity AND
  // changed variable.
  let experiments: ExperimentRecord[] = []
  try {
    const { data, error } = await db
      .from('experiments')
      .select('id, status, outcome, entity_level, entity_ref, changed_variable, control_ref, challenger_ref, started_at, ended_at, owner_decision, owner_decided_at, result_provenance')
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(error.message)
    experiments = (data ?? []) as ExperimentRecord[]
  } catch (e) {
    // Fail closed: no experiments means no causal evidence AND no known conflicts, and the warning
    // says conflicts are UNKNOWN rather than absent.
    warnings.push(`experiment read failed (${msg(e)}) — causal evidence treated as ABSENT and conflicts UNKNOWN`)
  }

  // ── Conversion + delivery evidence ─────────────────────────────────────────────────────────────
  let conversions = frozenEvidence(opts.windowDays, 'not gathered').conversions
  let delivery = deliveryFactActionability(false, null)
  const readings: SignalReading[] = []
  try {
    const { data: insights } = await db
      .from('daily_insights')
      .select('bookings, bookings_view_through, spend, impressions')
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'account')
      .gte('date_start', since)
      .lte('date_start', opts.today)

    const rows = (insights ?? []) as Array<{ bookings: number | null; bookings_view_through: number | null; spend: number | null; impressions: number | null }>
    const metaConversions = rows.length ? rows.reduce((s, r) => s + Number(r.bookings ?? 0), 0) : null
    // ABSENT stays absent: a window with no view-through breakdown is UNKNOWN, not zero.
    const anyBreakdown = rows.some((r) => r.bookings_view_through !== null)
    const viewThrough = anyBreakdown ? rows.reduce((s, r) => s + Number(r.bookings_view_through ?? 0), 0) : null
    const impressions = rows.reduce((s, r) => s + Number(r.impressions ?? 0), 0)

    // First-party business truth + click-attribution coverage from the outcome ledger.
    const { firstPartyBookings, clickCoverage, acceptedCapi } = await fetchFirstPartyEvidence(db, adAccountDbId, since, opts.today, warnings)
    const ga4 = await fetchGa4MetaPaidTelemetry(since, opts.today, warnings)
    const ga4PaidConfirmationEvents = ga4.confirmationEvents

    // EXACT paid evidence: value-bearing ledger appointments joined to a paid channel by appointment
    // id. This is the only GA-derived reading that may CONFIRM a paid outcome. It is null until the
    // custom dimension exists, and a null here must never be read as zero.
    let exactPaid: { valueBearingBookings: number; bookedValue: number } | null = null
    try {
      const { reconciliation } = await buildGa4ReconciliationBlock(adAccountDbId, since, opts.today, db)
      exactPaid = exactPaidEvidence(reconciliation, isMetaPaidChannel)
      if (exactPaid === null) {
        warnings.push(`exact paid ${OW.one} evidence is UNAVAILABLE (${reconciliation.scope}${reconciliation.scopeReason ? `: ${reconciliation.scopeReason}` : ''}) — GA confirmation events are NOT a substitute, and this is not evidence of zero paid ${OW.many}`)
      }
    } catch (e) {
      warnings.push(`exact paid ${OW.one} evidence read failed (${msg(e)}) — treated as UNAVAILABLE, not zero`)
    }

    // Learning state: any ad set still learning makes the account-level claim directional.
    const anyLearning = adsets.length === 0 ? null : adsets.some((a) => /LEARNING/i.test(a.learning_stage ?? ''))

    conversions = conversionActionability({
      metaConversions,
      viewThroughConversions: viewThrough,
      firstPartyBookings,
      ga4PaidConfirmationEvents,
      firstPartyClickCoverage: clickCoverage,
      inLearning: anyLearning,
      audienceComposition: dominantComposition(audienceByAdset),
      // Account-level actionability still asks "is there ANY completed successful experiment", but
      // the DECISION gate uses the entity+variable-scoped matcher below. This one only softens an
      // account-wide caveat; it never authorises a unit action.
      hasCausalEvidence: experiments.some((e) => e.status === 'complete' && e.outcome === 'success'),
    })
    delivery = deliveryFactActionability(rows.length > 0 && impressions >= 0, rows.length > 0 ? 24 : null)

    // Optimization-event evidence, strongest first. GA4 is included but can never outrank an
    // accepted server CAPI reading.
    if (acceptedCapi !== null) {
      readings.push({ tier: 'accepted_server_capi', count: acceptedCapi, windowDays: opts.windowDays, provenance: 'conversion_deliveries.accepted_at' })
    }
    if (firstPartyBookings !== null) {
      readings.push({ tier: 'first_party_outcomes', count: firstPartyBookings, windowDays: opts.windowDays, provenance: 'outcomes' })
    }
    if (exactPaid !== null) {
      readings.push({ tier: 'exact_paid_outcomes', count: exactPaid.valueBearingBookings, windowDays: opts.windowDays, provenance: `exact ${OW.one}-id join, paid channels only (ledger booked value ${formatMoney(exactPaid.bookedValue)})` })
    }
    if (ga4PaidConfirmationEvents !== null) {
      // TELEMETRY, not a booking count: no appointment identity, so it may contain duplicates,
      // canceled appointments and nominal-priced comps. Usable to DEMOTE confidence on a plane
      // conflict; never sufficient to CONFIRM a unit outcome or unlock a money action.
      readings.push({ tier: 'ga4_web_observed', count: ga4PaidConfirmationEvents, windowDays: opts.windowDays, provenance: `ga4 ${ga4.scope} (Meta-scoped Paid Social CONFIRMATION EVENTS, no ${OW.one} identity — not exact ${OW.many})` })
    }
    if (metaConversions !== null) {
      readings.push({ tier: 'meta_modeled_attribution', count: metaConversions, windowDays: opts.windowDays, provenance: 'daily_insights.bookings' })
    }
  } catch (e) {
    warnings.push(`conversion evidence read failed (${msg(e)}) — conversion claims frozen`)
  }

  // ── Creative diversity ─────────────────────────────────────────────────────────────────────────
  const { byAdset: diversityByAdset, account: accountDiversity } = await fetchCreativeDiversity(db, adAccountDbId, warnings)

  const runningExperimentVariables = experiments
    .filter((e) => e.status === 'running')
    .map((e) => e.changed_variable)

  return {
    audienceByAdset, conversions, delivery,
    optimizationEvents: resolveOptimizationEventEvidence(readings),
    diversityByAdset, accountDiversity,
    runningExperimentVariables, experiments, budgetStructureByAdset, dailyBudgetByAdset, adsetIdsByCampaign,
    budgetStructureByCampaign, dailyBudgetByCampaign,
    windowDays: opts.windowDays, gatherWarnings: warnings,
  }
}

/** The scale rule's step, kept as a NUMBER so a proposal is derived, never parsed out of prose. */
export const SCALE_STEP_SHARE = 0.2

/**
 * PURE: the structured budget proposal for a scale recommendation.
 *
 * The flag rule's guidance lives in prose ("Increase budget by 20% ..."). Reading a
 * number out of that sentence would make the money decision depend on copy-editing. The proposal is
 * instead DERIVED from the verified current budget, and is null when that budget is unknown — which
 * the budget gate then rejects rather than guessing a target.
 */
export function proposedScaleBudget(currentBudget: number | null): number | null {
  if (currentBudget === null || !Number.isFinite(currentBudget) || currentBudget <= 0) return null
  // Rounded to the account currency's minor unit (cents, whole yen, fils), the precision Meta takes.
  return fromMinorUnits(toMinorUnits(currentBudget * (1 + SCALE_STEP_SHARE)))
}

export interface GatedDecision {
  decision: DecisionResult
  /** Scoped causal evidence for this decision, including why each experiment was rejected. */
  causal: CausalEvidenceResult
  testBrief: TestBrief | null
  /** The type the recommendation must be downgraded to, or null to keep it as-is. */
  downgradeTo: RecommendationType | null
}

/**
 * PURE: run the decision policy for one recommendation. Money-moving types REQUIRE a passing
 * verdict; anything else is downgraded and reports the missing evidence without inventing either a
 * direct action or a test contract.
 */
export function gateRecommendation(
  type: RecommendationType,
  ctx: {
    adsetDbId: string | null
    /** Required for a CAMPAIGN-level decision — the campaign owns the budget and the roll-up. */
    campaignDbId?: string | null
    entityLevel: 'campaign' | 'adset' | 'ad'
    evidence: AccountEvidence
    proposedBudget: number | null
    /** Member ad-set audiences, required for a campaign-level decision. */
    memberAudiences?: AudienceResolution[] | null
    /** Stable entity key and display name, used to match experiment control/challenger references. */
    entityKey?: string | null
    entityName?: string | null
    /** Complete, immutable paid-interaction outcomes for this exact Meta unit and decision window.
     *  When absent, the account ledger remains context only and is never relabelled as unit proof. */
    paidCohortOutcomes?: ScopedOutcomeEvidence | null
  },
): GatedDecision | null {
  const kind = kindForRecommendationType(type)
  if (kind === null) return null // not a gated class (keep/investigate/hold/…)

  // A CAMPAIGN flag deliberately carries adset_id = null (engine.ts), so deriving
  // budget structure, budget, audience and diversity ONLY through adsetDbId meant every campaign /
  // CBO decision resolved to unknown + frozen — the campaign roll-up was never operational. Context
  // is now resolved at the level the decision actually belongs to.
  const isCampaignLevel = ctx.entityLevel === 'campaign'
  const memberIds = isCampaignLevel && ctx.campaignDbId
    ? (ctx.evidence.adsetIdsByCampaign.get(ctx.campaignDbId) ?? [])
    : []
  const members = memberIds
    .map((id) => ctx.evidence.audienceByAdset.get(id))
    .filter((a): a is AudienceResolution => a !== undefined)

  const audience = isCampaignLevel
    // A campaign has no targeting of its own; its primary audience is the conservative roll-up of
    // its members. With no usable member, it stays frozen — which is correct, not a bug.
    ? conservativeCampaignAudience(members)
    : (ctx.adsetDbId ? ctx.evidence.audienceByAdset.get(ctx.adsetDbId) : undefined) ??
      resolveAudience({ adsetName: null, targeting: null, targetingSyncedAt: null, accountId: 'unknown' }, Date.now())

  const budgetStructure = isCampaignLevel
    ? (ctx.campaignDbId ? ctx.evidence.budgetStructureByCampaign.get(ctx.campaignDbId) : undefined) ?? 'unknown'
    : (ctx.adsetDbId ? ctx.evidence.budgetStructureByAdset.get(ctx.adsetDbId) : undefined) ?? 'unknown'

  const currentBudget = isCampaignLevel
    ? (ctx.campaignDbId ? ctx.evidence.dailyBudgetByCampaign.get(ctx.campaignDbId) : undefined) ?? null
    : (ctx.adsetDbId ? ctx.evidence.dailyBudgetByAdset.get(ctx.adsetDbId) : undefined) ?? null

  const diversity = isCampaignLevel
    // Campaign diversity is the union of its members' creatives; fall back to the account view.
    ? mergeDiversity(memberIds.map((id) => ctx.evidence.diversityByAdset.get(id)).filter((d): d is DiversityReport => d !== undefined)) ?? ctx.evidence.accountDiversity
    : (ctx.adsetDbId ? ctx.evidence.diversityByAdset.get(ctx.adsetDbId) : undefined) ?? ctx.evidence.accountDiversity

  // A scale proposal is DERIVED from the verified current budget. For every other kind the proposal
  // is whatever the caller supplied (null for non-money kinds, which the gate ignores).
  const proposedBudget =
    kind === 'scale' ? proposedScaleBudget(currentBudget) : ctx.proposedBudget

  const entityRefs = [ctx.adsetDbId, ctx.entityKey, ctx.entityName].filter((x): x is string => !!x)
  const causal = applicableCausalEvidence(ctx.evidence.experiments, { entityRefs, entityLevel: ctx.entityLevel, kind, nowMs: Date.now() })

  const inputs: DecisionInputs = {
    kind,
    budgetStructure,
    entityLevel: ctx.entityLevel,
    audience,
    conversions: ctx.evidence.conversions,
    firstPartyOutcomes: ctx.paidCohortOutcomes ?? firstPartyFromEvidence(ctx.evidence),
    webAttributedOutcomes: ga4FromEvidence(ctx.evidence),
    deliveryMeasured: ctx.evidence.delivery.level !== 'insufficient',
    inLearning: inLearningFromEvidence(ctx.evidence),
    diversity,
    // SCOPED by entity AND changed variable, so a running creative test on another ad set cannot
    // block this budget decision, and a creative result cannot unlock it.
    conflictingExperiments: applicableConflicts(ctx.evidence.experiments, { entityRefs, entityLevel: ctx.entityLevel, kind }),
    windowDays: ctx.evidence.windowDays,
    currentBudget,
    proposedBudget,
    memberAudiences: isCampaignLevel ? (ctx.memberAudiences ?? members) : (ctx.memberAudiences ?? null),
    hasCausalEvidence: causal.applicable.length > 0 && causal.unlocksDirectAction,
  }

  const decision = decideRecommendation(inputs)
  if (decision.verdict === 'ready_for_authority') return { decision, testBrief: null, downgradeTo: null, causal }

  // A failed preflight identifies missing evidence; it does not own a test contract. The legacy
  // buildTestBrief path invented sample/spend floors without a CampaignPlan or owner loss ceiling.
  // Keep the production response fail-closed until a governed CampaignPlan supplies those inputs.
  const testBrief = null
  const downgradeTo: RecommendationType =
    decision.verdict === 'test' ? 'investigate'
    : decision.verdict === 'freeze' ? 'hold'
    : decision.verdict === 'owner_review' ? 'investigate'
    : 'budget_watch'
  return { decision, testBrief, downgradeTo, causal }
}


// ── helpers ────────────────────────────────────────────────────────────────────────────────────

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * PURE: a campaign's audience context = the CONSERVATIVE roll-up of its member ad sets. Any frozen,
 * unknown or divergent member makes the campaign unresolved; a campaign with no members is frozen.
 */
function conservativeCampaignAudience(members: AudienceResolution[]): AudienceResolution {
  const frozen = resolveAudience({ adsetName: null, targeting: null, targetingSyncedAt: null, accountId: 'unknown' }, Date.now())
  if (members.length === 0) return frozen
  if (members.some((m) => m.frozen)) return frozen
  const kinds = [...new Set(members.map((m) => m.composition))]
  const composition = kinds.includes('unknown') ? 'unknown' : kinds.length > 1 ? 'mixed' : kinds[0]
  const worst = members.reduce((a, b) => (a.confidence <= b.confidence ? a : b))
  return {
    ...worst,
    composition,
    frozen: false,
    unknownReason: composition === 'unknown' ? 'a member ad set has unresolved composition' : null,
    evidence: [
      `campaign context rolled up from ${members.length} member ad set(s): ${kinds.join(', ')} -> ${composition}`,
      ...members.flatMap((m) => m.evidence),
    ],
  }
}

/** PURE: union member diversity reports into one campaign-level view. Null when there are none. */
function mergeDiversity(reports: DiversityReport[]): DiversityReport | null {
  if (reports.length === 0) return null
  return {
    totalAds: reports.reduce((s, r) => s + r.totalAds, 0),
    distinctAssets: reports.reduce((s, r) => s + r.distinctAssets, 0),
    duplicates: reports.flatMap((r) => r.duplicates),
    distinctConcepts: null, distinctCreators: null, distinctHookStyles: null,
    distinctAspectRatios: Math.max(0, ...reports.map((r) => r.distinctAspectRatios)),
    weakIdentityAds: reports.flatMap((r) => r.weakIdentityAds),
    notes: reports.flatMap((r) => r.notes),
  }
}

function subDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** The composition to judge account-level conversion claims against. Mixed/unknown dominates. */
function dominantComposition(byAdset: Map<string, AudienceResolution>): DecisionInputs['audience']['composition'] {
  const values = [...byAdset.values()]
  if (values.length === 0) return 'unknown'
  if (values.some((v) => v.composition === 'unknown')) return 'unknown'
  if (values.some((v) => v.composition === 'mixed')) return 'mixed'
  const distinct = new Set(values.map((v) => v.composition))
  return distinct.size === 1 ? values[0].composition : 'mixed'
}

async function fetchAudienceMetadata(
  db: SupabaseClient,
  adAccountDbId: string,
  warnings: string[],
): Promise<Record<string, AudienceRef>> {
  try {
    // EVERY field `resolveAudience` reads must be selected here. It previously took four columns and
    // built a ref without `lastSyncedAt`, `operationStatus` or `deliveryStatus` — all three of which
    // the resolver requires. `typeof undefined === 'string'` is false, so `syncedMs` became NaN and
    // resolveAudience returned `unresolved` for EVERY audience, unconditionally, with the message
    // "inventory age is UNKNOWN". That froze preflight on every money recommendation in the account
    // while targeting metadata was in fact 0.1h old.
    //
    // TypeScript could not catch it: these fields are optional on AudienceRef, so a ref missing them
    // is a valid AudienceRef. Typing the return as AudienceRef (rather than a structural subset that
    // silently satisfies nothing) is what keeps the two ends honest from here on.
    const { data, error } = await db
      .from('custom_audiences')
      .select('audience_id, name, subtype, meta_account_id, last_synced_at, operation_status, delivery_status')
      .eq('ad_account_id', adAccountDbId)
    if (error) {
      // The table may not exist yet. Missing metadata must FREEZE material conclusions, and it does:
      // resolveAudience leaves subtypes null, which lowers confidence and (with unknown expansion)
      // yields composition 'unknown'.
      warnings.push(`custom-audience metadata unavailable (${error.message}) — audience subtypes and ownership unresolved; material conclusions freeze`)
      return {}
    }
    const out: Record<string, AudienceRef> = {}
    for (const a of (data ?? []) as Array<{
      audience_id: string
      name: string | null
      subtype: string | null
      meta_account_id: string | null
      last_synced_at: string | null
      operation_status: unknown
      delivery_status: unknown
    }>) {
      out[a.audience_id] = {
        id: a.audience_id,
        name: a.name,
        subtype: a.subtype,
        accountId: a.meta_account_id,
        lastSyncedAt: a.last_synced_at,
        operationStatus: a.operation_status,
        deliveryStatus: a.delivery_status,
      }
    }
    return out
  } catch (e) {
    warnings.push(`custom-audience metadata read threw (${msg(e)}) — audience subtypes unresolved`)
    return {}
  }
}

async function fetchFirstPartyEvidence(
  db: SupabaseClient,
  adAccountDbId: string,
  since: string,
  today: string,
  warnings: string[],
): Promise<{ firstPartyBookings: number | null; clickCoverage: number | null; acceptedCapi: number | null }> {
  try {
    // ACCOUNT-SCOPED. The ledger is account-agnostic by table design, so an unscoped read counted
    // every account's bookings as this account's business truth.
    // Enabled outcome sources only (src/lib/outcomes/aggregation.ts).
    const { data, error } = await db
      .from('v_business_outcomes')
      .select('id, fbclid, status')
      .eq('ad_account_id', adAccountDbId)
      .eq('source_enabled', true)
      .gte('business_date', since)
      .lte('business_date', today)
    if (error) throw new Error(error.message)
    // `id` is the outcome uuid, the join key to conversion_deliveries.outcome_id.
    const rows = (data ?? []) as Array<{ id: string; fbclid: string | null; status: string }>
    const live = rows.filter((r) => r.status !== 'cancelled' && r.status !== 'refunded')
    const firstPartyBookings = live.length
    const clickCoverage = live.length === 0 ? null : live.filter((r) => (r.fbclid ?? '') !== '').length / live.length

    // A FAILED delivery read is UNKNOWN, not "zero accepted". The previous try/catch only caught a
    // thrown error; a PostgREST error object was returned in `error` and ignored, so a broken read
    // produced `acceptedCapi = 0` and looked like a real measurement of no deliveries.
    let acceptedCapi: number | null = null
    const ids = live.map((r) => r.id)
    if (ids.length === 0) {
      acceptedCapi = 0
    } else {
      try {
        const { data: dels, error: delErr } = await db
          .from('conversion_deliveries')
          .select('outcome_id, live_accepted_at')
          .in('outcome_id', ids)
          // LIVE acceptances only (`live_accepted_at`). A test-mode acceptance is quarantined by Meta and
          // is never delivery evidence for the optimizer.
          .not('live_accepted_at', 'is', null)
        if (delErr) throw new Error(delErr.message)
        acceptedCapi = (dels ?? []).length
      } catch (e) {
        warnings.push(`CAPI delivery read failed (${msg(e)}) — accepted-delivery evidence is UNKNOWN, not zero`)
        acceptedCapi = null
      }
    }
    return { firstPartyBookings, clickCoverage, acceptedCapi }
  } catch (e) {
    warnings.push(`first-party ledger read failed (${msg(e)}) — business truth unavailable`)
    return { firstPartyBookings: null, clickCoverage: null, acceptedCapi: null }
  }
}

/**
 * GA Meta-paid-channel confirmation telemetry for the window.
 *
 * WHAT WAS WRONG: this read `report_json.ga4.paidBookings`, a field NO writer ever
 * produces — generator.ts stores `todayPaidBookings` / `paidBookings30`. So it returned null on every
 * production run, and `ga4PaidConfirmationEvents: null` silently disabled the plane-conflict cap that exists to
 * catch a modelled/web disagreement. Naively "fixing" the field name would have been worse: the
 * stored `paidBookings30` is a ROLLING 30-day total repeated on every daily row, so summing it across
 * the window multiplies the real figure by the number of days.
 *
 * It now reads GA4 DIRECTLY, once, and uses the META-SCOPED paid bucket — blending Google or other
 * paid channels into the comparison would mix other platforms into the Meta telemetry diagnostic.
 */
/** This returned GA eventCount under the name `ga4PaidConfirmationEvents` and fed it into the
 *  evidence tiers as an observed booking count. Those events carry no appointment identity, so the
 *  number could contain duplicates, canceled appointments and nominal-priced comps.
 *
 *  It is now returned as what it is — a confirmation-EVENT count — and the caller records it at a
 *  tier that can DEMOTE confidence (a plane conflict) but can never CONFIRM a unit outcome. Exact
 *  paid booking evidence requires an appointment-id join and is a separate reading. */
async function fetchGa4MetaPaidTelemetry(
  since: string, today: string, warnings: string[],
): Promise<{ confirmationEvents: number | null; scope: 'ga4_meta_paid_telemetry' | 'unavailable' }> {
  try {
    const r = await getGa4ConfirmationTelemetryBySource(since, today)
    if (!r.available) {
      warnings.push(`GA4 unavailable for ${since}..${today} (${r.reason ?? 'no reason given'}) — web-attributed evidence is UNKNOWN, not zero`)
      return { confirmationEvents: null, scope: 'unavailable' }
    }
    // metaPaid is the Paid Social subset — the only honest comparator for Meta-attributed claims.
    return { confirmationEvents: r.metaPaid.confirmationEvents, scope: 'ga4_meta_paid_telemetry' }
  } catch (e) {
    warnings.push(`GA4 read threw (${msg(e)}) — web-attributed evidence is UNKNOWN, not zero`)
    return { confirmationEvents: null, scope: 'unavailable' }
  }
}

async function fetchCreativeDiversity(
  db: SupabaseClient, adAccountDbId: string, warnings: string[],
): Promise<{ byAdset: Map<string, DiversityReport>; account: DiversityReport }> {
  const byAdset = new Map<string, DiversityReport>()
  try {
    const { data, error } = await db
      .from('creatives')
      .select('id, creative_id, video_id, asset_type, video_duration_seconds')
      .eq('ad_account_id', adAccountDbId)
    if (error) throw new Error(error.message)
    const creatives = (data ?? []) as Array<{ id: string; creative_id: string | null; video_id: string | null; asset_type: string | null; video_duration_seconds: number | null }>
    const creativeById = new Map(creatives.map((c) => [c.id, c]))

    // Ads own the link: ads.creative_id -> creatives.id. An ad with no creative row contributes
    // nothing rather than being counted as a distinct asset.
    const { data: adRows } = await db.from('ads').select('id, adset_id, creative_id').eq('ad_account_id', adAccountDbId)
    const ads = (adRows ?? []) as Array<{ id: string; adset_id: string | null; creative_id: string | null }>

    const metas: CreativeMetadata[] = ads
      .map((a) => {
        const c = a.creative_id ? creativeById.get(a.creative_id) : undefined
        return { ad: a, c }
      })
      .filter((x): x is { ad: { id: string; adset_id: string | null; creative_id: string | null }; c: typeof creatives[number] } => x.c !== undefined)
      .map(({ ad: a, c }) => ({
        adId: a.id,
        adsetId: a.adset_id,
        creativeId: c.creative_id,
        mediaId: c.video_id,
        mediaKind: c.video_id ? 'video' : c.asset_type === 'image' ? 'image' : 'unknown',
        mediaBytes: null,
        mediaChecksum: null,
        durationSeconds: c.video_duration_seconds,
        width: null, height: null, placements: [],
        conceptId: null, creatorId: null, hookStyle: null,
        offerTags: [], proofTags: [], ctaTags: [], safeZoneOk: null,
      }))

    const groups = new Map<string, CreativeMetadata[]>()
    for (const m of metas) {
      const key = m.adsetId ?? '__none__'
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    for (const [adsetId, list] of groups) {
      if (adsetId !== '__none__') byAdset.set(adsetId, analyzeCreativeDiversity(list))
    }
    return { byAdset, account: analyzeCreativeDiversity(metas) }
  } catch (e) {
    warnings.push(`creative read failed (${msg(e)}) — diversity unknown`)
    return { byAdset, account: frozenEvidence(0, `creative read failed: ${msg(e)}`).accountDiversity }
  }
}

// These read back the values gatherAccountEvidence already computed into `conversions`, so the
// decision inputs and the actionability score can never disagree about the same fact.
// Both first-party and GA evidence are gathered at ACCOUNT scope in this pass: the outcome ledger has
// no ad-set linkage and the GA read is account-wide. They are therefore labelled 'account', which the
// decision policy treats as CONTEXT and refuses to accept as proof that a particular unit produced
// them. Unit-scoped attribution is deferred (see the record's limitations); until it exists, unit-level
// money actions correctly fail closed to owner review.
function firstPartyFromEvidence(e: AccountEvidence): ScopedOutcomeEvidence {
  const r = e.optimizationEvents.readings.find((x) => x.tier === 'exact_paid_outcomes')
    ?? e.optimizationEvents.readings.find((x) => x.tier === 'first_party_outcomes')
  return {
    value: r?.count ?? null,
    scope: 'account',
    provenance: r?.provenance ?? 'outcomes (account-scoped); no per-unit linkage exists',
  }
}
function ga4FromEvidence(e: AccountEvidence): ScopedOutcomeEvidence {
  const r = e.optimizationEvents.readings.find((x) => x.tier === 'ga4_web_observed')
  return {
    value: r?.count ?? null,
    scope: 'account',
    provenance: r?.provenance ?? 'GA account-wide Meta-paid confirmation telemetry; no per-unit linkage in this pass',
  }
}
function inLearningFromEvidence(e: AccountEvidence): boolean | null {
  const cap = e.conversions.caps.find((c) => /learning/.test(c.reason))
  if (!cap) return false
  return /state is unknown/.test(cap.reason) ? null : true
}
