import { getAdminClient } from '@/lib/supabase/admin'
import { renderFlagAction, evaluateFlag } from './rules'
import { campaignIsCbo, suppressAdsetBudgetFlagUnderCbo, BUDGET_DECISION_FLAGS } from './optimization-unit'
import { readCurrentGeneration, replaceFlagGeneration, type EvaluatedScope, type ProvenKey, type FrozenScopes, type FlagGenerationResult } from './generations'
import { randomUUID } from 'node:crypto'
import type { AudienceType } from '@/types/db'

const WINDOWS = [1, 3, 7, 30] as const

interface InsightRow {
  ad_id: string | null
  adset_id: string | null
  campaign_id: string | null
  meta_ad_id: string | null
  meta_adset_id: string | null
  meta_campaign_id: string | null
  spend: number
  bookings: number
  leads: number
  ctr: number | null
  frequency: number | null
  cost_per_booking: number | null
  cost_per_lead: number | null
  roas: number | null
  impressions: number
  clicks: number
  reach: number
}

interface EntityMeta {
  audience_type: AudienceType
  created_at: string | null
}

// Fallback for an entity whose row is absent from the batched lookup — identical to what the former
// per-entity `.maybeSingle()` returned when it found no row (`data` null → unknown / null).
const DEFAULT_ENTITY_META: EntityMeta = { audience_type: 'unknown', created_at: null }

/**
 * Batched entity-metadata lookup. Fetches audience_type + created_at for many entities of one level
 * in a SINGLE `.in()` query and returns an id→meta Map — replacing the former per-entity
 * `.maybeSingle()` call that ran once per entity per window (O(entities × windows) round trips).
 *
 * Entity metadata is window-independent, so the caller builds one Map per level and reuses it across
 * every window. An id with no matching row is simply omitted; the caller resolves it to
 * DEFAULT_ENTITY_META, matching the per-entity lookup's missing-row behavior.
 */
export async function getEntityMetaBatch(
  supabase: ReturnType<typeof getAdminClient>,
  level: 'ad' | 'adset',
  dbIds: string[]
): Promise<Map<string, EntityMeta>> {
  const map = new Map<string, EntityMeta>()
  if (dbIds.length === 0) return map

  // audience_type lives on adsets, NOT ads — selecting it from `ads` errored the WHOLE query, silently
  // dropping created_at too (every ad → unknown audience + age-from-window). Query each level for the
  // columns it actually has (literal selects keep supabase-js's column typing); ad-level audience_type is
  // resolved from the parent ad set by the caller.
  if (level === 'ad') {
    const { data } = await supabase.from('ads').select('id, created_at').in('id', dbIds)
    for (const row of data ?? []) map.set(row.id as string, { audience_type: 'unknown', created_at: (row.created_at as string) ?? null })
  } else {
    const { data } = await supabase.from('adsets').select('id, audience_type, created_at').in('id', dbIds)
    for (const row of data ?? []) map.set(row.id as string, { audience_type: (row.audience_type as AudienceType) ?? 'unknown', created_at: (row.created_at as string) ?? null })
  }

  return map
}

function daysSince(dateStr: string | null): number | undefined {
  if (!dateStr) return undefined
  const ms = Date.now() - new Date(dateStr).getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

/** A still-active flag the engine should resolve. */
interface ActiveFlagKey {
  id: string
  entity_level: 'ad' | 'adset' | 'campaign'
  campaign_id: string | null
  ad_id: string | null
  adset_id: string | null
  window_days: number
  flag_type: string
}

/**
 * PURE run-scoped stale-flag resolution — the TEST-ONLY reference model for the RPC's
 * evaluated-not-proven closure dimension (replace_flag_generation step 6). It intentionally knows
 * nothing of the RPC's OTHER closure dimensions (structural unit change 6b, orphaned entity 6c),
 * which are judged in-database from commit-time metadata. Production closure lives in the RPC.
 *
 * Given this run's evaluated `${level}:${id}:${window}` keys and re-proven
 * `${level}:${id}:${window}:${flag_type}` keys, return the ids of still-active flags to close:
 * those whose entity+window WAS evaluated this run but whose type was NOT re-proven — i.e. the entity
 * became healthy, or flipped to a different flag type. Flags for entities ABSENT from this run's data are
 * left active: without fresh data the engine cannot assert the condition stopped holding.
 */
export function selectStaleFlagIds(
  activeFlags: ActiveFlagKey[],
  evaluatedKeys: Set<string>,
  provenKeys: Set<string>,
  isBudgetFrozen: (f: ActiveFlagKey) => boolean = () => false
): string[] {
  const ids: string[] = []
  for (const f of activeFlags) {
    const entityId = f.entity_level === 'ad' ? f.ad_id : f.entity_level === 'adset' ? f.adset_id : f.campaign_id
    if (!entityId) continue
    // Never CLOSE a budget-decision flag whose optimization unit is frozen this run — the engine
    // refused to re-create it (CBO state unknown), so it must not resolve it either, even when the entity
    // now reads healthy or flipped type. (Ad-level scale flags are NOT frozen — see isBudgetFrozen.)
    if (isBudgetFrozen(f)) continue
    const evalKey = `${f.entity_level}:${entityId}:${f.window_days}`
    if (evaluatedKeys.has(evalKey) && !provenKeys.has(`${evalKey}:${f.flag_type}`)) ids.push(f.id)
  }
  return ids
}

/** A campaigns-table row as the engine's metadata query returns it. */
export interface CampaignMetaRow {
  id: string
  daily_budget: number | null
  lifetime_budget: number | null
  last_synced_at: string | null
}

/**
 * PURE freshness-gated CBO/ABO classification. A campaign's budget structure is trusted ONLY
 * when its row was refreshed by the current sync (last_synced_at >= boundary): fetchCampaigns filters to
 * ACTIVE/PAUSED, so an archived/deleted campaign keeps a stale row forever — classifying from it could
 * generate or suppress budget decisions off dead data. Stale or missing REFERENCED campaigns land in
 * `unknown` (frozen: preserve existing budget flags, create none). A null OR unparseable boundary means
 * budget evaluation is DISABLED entirely (fail closed).
 *
 * Timestamps are compared as PARSED epoch values, never lexically ('Z' vs '+00:00' vs fractional
 * precision are the same instant); an unparseable last_synced_at is treated as stale. unresolvedReferenced
 * lists EVERY referenced campaign whose CBO state could not be resolved — stale row AND missing row alike —
 * so a suppressed budget evaluation can never report a green sync (the RPC counts the active-flag half).
 */
export function classifyCampaignMetadata(
  rows: CampaignMetaRow[],
  referencedIds: ReadonlySet<string>,
  boundary: string | null
): { cbo: Set<string>; unknown: Set<string>; unresolvedReferenced: string[] } {
  const cbo = new Set<string>()
  const unknown = new Set<string>(referencedIds) // start all-unknown; delete as fresh rows resolve
  const boundaryMs = boundary === null ? NaN : Date.parse(boundary)
  if (!Number.isFinite(boundaryMs)) {
    // Budget evaluation disabled — every referenced campaign is unresolved by definition.
    return { cbo, unknown, unresolvedReferenced: [...referencedIds] }
  }
  for (const r of rows) {
    const syncedMs = r.last_synced_at === null ? NaN : Date.parse(r.last_synced_at)
    const fresh = Number.isFinite(syncedMs) && syncedMs >= boundaryMs
    if (!fresh) continue // stays unknown (stale, or unparseable = stale)
    if (campaignIsCbo(r)) cbo.add(r.id)
    unknown.delete(r.id) // fresh metadata → CBO state known (CBO or ABO)
  }
  // Whatever is still unknown AND referenced — stale rows and missing rows alike — is unresolved.
  return { cbo, unknown, unresolvedReferenced: [...unknown].filter((id) => referencedIds.has(id)) }
}

/**
 * Runs the flag engine for all ads and ad sets for a given account. Evaluates each entity across
 * multiple date windows, then publishes the complete flag set ONCE through replace_flag_generation
 * — insert + supersede + stale-close + structural/orphan closure in one locked,
 * CAS-guarded transaction. Returns the committed flag generation (id + row_count + closure telemetry +
 * the resulting active snapshot the rec builder consumes).
 *
 * opts.metadataNotBefore: the sync's metadata-freshness boundary (its start instant). Campaign
 * budget structure is classified ONLY from rows refreshed at/after it, and the RPC's structural closure
 * is gated on the same boundary. OMITTED/NULL = budget evaluation disabled (global freeze, no structural
 * closure) — the safe default for standalone callers (e.g. scripts/generate-recs.ts).
 * opts.insightNotBefore: when supplied by the lifecycle sync, every performance row evaluated by this
 * run must have been refreshed after that same boundary. Retained warehouse rows cannot create a new
 * flag or recommendation merely because their entity metadata was refreshed.
 */
export async function runFlagEngine(
  adAccountDbId: string,
  referenceDate: string,
  opts?: { metadataNotBefore?: string | null; insightNotBefore?: string | null }
): Promise<FlagGenerationResult> {
  const supabase = getAdminClient()
  // Validate the boundary ONCE. An unparseable value must behave exactly like no boundary —
  // budget evaluation disabled (fail closed) — and must never reach the RPC, whose ::timestamptz cast
  // would otherwise fail the whole flag commit (contradicting the tested invalid=disabled contract).
  const rawBoundary = opts?.metadataNotBefore ?? null
  const metadataNotBefore = rawBoundary !== null && Number.isFinite(Date.parse(rawBoundary)) ? rawBoundary : null
  if (rawBoundary !== null && metadataNotBefore === null)
    console.warn(`[Flags] invalid metadataNotBefore ${JSON.stringify(rawBoundary)} — budget evaluation disabled (fail closed)`)
  const rawInsightBoundary = opts?.insightNotBefore ?? null
  const insightNotBefore = rawInsightBoundary !== null && Number.isFinite(Date.parse(rawInsightBoundary))
    ? rawInsightBoundary
    : null
  if (rawInsightBoundary !== null && insightNotBefore === null) {
    throw new Error(`invalid insightNotBefore ${JSON.stringify(rawInsightBoundary)}`)
  }

  // ── Phase 1 — Fetch + aggregate each window; retain the per-window aggregations ──
  // The daily_insights queries (one per level per window) are unchanged. Entity-metadata lookups and
  // flag writes are deferred so the metadata can be fetched in a single batched query per level below.
  const windows: {
    windowDays: number
    adAgg: Map<string, InsightRow>
    adsetAgg: Map<string, InsightRow>
    campaignAgg: Map<string, InsightRow>
  }[] = []
  // FAIL-CLOSED signal for budget decisions: when campaign insights or campaign metadata can't be read,
  // CBO-vs-ABO is UNKNOWN — emitting a pause/scale at a possibly-wrong level is worse than emitting
  // nothing for a run, so budget-decision evaluation is frozen (existing flags preserved) instead of
  // silently treating every campaign as ABO.
  let campaignDataError = false

  for (const windowDays of WINDOWS) {
    const since = new Date(referenceDate)
    since.setUTCDate(since.getUTCDate() - windowDays + 1)
    const sinceStr = since.toISOString().slice(0, 10)

    // ── Ad-level rows ──────────────────────────────────────
    let adQuery = supabase
      .from('daily_insights')
      .select(`
        ad_id, adset_id, campaign_id,
        meta_ad_id, meta_adset_id, meta_campaign_id,
        spend, bookings, leads, ctr, frequency,
        cost_per_booking, cost_per_lead, roas, impressions, clicks, reach
      `)
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'ad')
      .gte('date_start', sinceStr)
      .lte('date_start', referenceDate)
      .not('ad_id', 'is', null)
    if (insightNotBefore) adQuery = adQuery.gte('synced_at', insightNotBefore)
    const { data: adRows, error: adErr } = await adQuery

    if (adErr) {
      console.error('[Flags] ad-level query failed:', adErr.message)
      continue
    }

    // Aggregate per ad across the window
    const adAgg = aggregateByKey(adRows ?? [], 'ad_id')

    // ── Ad set-level rows ──────────────────────────────────
    let adsetQuery = supabase
      .from('daily_insights')
      .select(`
        adset_id, campaign_id,
        meta_adset_id, meta_campaign_id,
        spend, bookings, leads, ctr, frequency,
        cost_per_booking, cost_per_lead, roas, impressions, clicks, reach
      `)
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'adset')
      .gte('date_start', sinceStr)
      .lte('date_start', referenceDate)
      .not('adset_id', 'is', null)
    if (insightNotBefore) adsetQuery = adsetQuery.gte('synced_at', insightNotBefore)
    const { data: adsetRows, error: adsetErr } = await adsetQuery

    if (adsetErr) {
      console.error('[Flags] adset-level query failed:', adsetErr.message)
      // Ad-level rows for this window were fetched cleanly — retain them; skip only the ad sets,
      // exactly as the original did (ad-level writes had already run before the adset query).
      windows.push({ windowDays, adAgg, adsetAgg: new Map(), campaignAgg: new Map() })
      continue
    }

    const adsetAgg = aggregateByKey(adsetRows ?? [], 'adset_id')

    // ── Campaign-level rows (evaluated only for CBO campaigns in Phase 3) ──
    let campaignQuery = supabase
      .from('daily_insights')
      .select(`
        campaign_id, meta_campaign_id,
        spend, bookings, leads, ctr, frequency,
        cost_per_booking, cost_per_lead, roas, impressions, clicks, reach
      `)
      .eq('ad_account_id', adAccountDbId)
      .eq('entity_level', 'campaign')
      .gte('date_start', sinceStr)
      .lte('date_start', referenceDate)
      .not('campaign_id', 'is', null)
    if (insightNotBefore) campaignQuery = campaignQuery.gte('synced_at', insightNotBefore)
    const { data: campRows, error: campRowsErr } = await campaignQuery
    if (campRowsErr) {
      console.error('[Flags] campaign-level query failed:', campRowsErr.message)
      campaignDataError = true
    }
    const campaignAgg = aggregateByKey(campRows ?? [], 'campaign_id')

    windows.push({ windowDays, adAgg, adsetAgg, campaignAgg })
  }

  // ── Phase 2 — Batch-fetch entity metadata: ONE query per level, reused across all windows ──
  // audience_type / created_at do not change per window, so the former per-entity/per-window lookups
  // were pure waste. Collect the distinct ids across every window and resolve each level in one query.
  const adIds = new Set<string>()
  const adsetIds = new Set<string>()
  for (const w of windows) {
    for (const id of w.adAgg.keys()) adIds.add(id)
    for (const id of w.adsetAgg.keys()) adsetIds.add(id)
  }

  const adMetaMap = await getEntityMetaBatch(supabase, 'ad', [...adIds])
  const adsetMetaMap = await getEntityMetaBatch(supabase, 'adset', [...adsetIds])

  // CBO detection + campaign age for campaign-level evaluation. A campaign is CBO when its budget is set
  // at the campaign level (Meta puts the budget at exactly one level); under CBO the campaign — not each
  // ad set — is the optimization unit for budget decisions.
  // Collect EVERY campaign referenced this run — from each aggregate ROW's campaign_id (ad-level
  // and ad-set rows carry it), NOT just the campaign-level insight keys. A campaign with ad-set delivery
  // but no campaign-level insight row must still have its CBO state resolved; otherwise its absence from
  // the campaign map would silently read as ABO. Any referenced campaign whose metadata row is ABSENT is
  // CBO-UNKNOWN (unknownCbo) and its budget flags freeze — the engine never infers ABO from a missing row.
  const campaignIds = new Set<string>()
  for (const w of windows) {
    for (const r of w.adAgg.values()) if (r.campaign_id) campaignIds.add(r.campaign_id)
    for (const r of w.adsetAgg.values()) if (r.campaign_id) campaignIds.add(r.campaign_id)
    for (const r of w.campaignAgg.values()) if (r.campaign_id) campaignIds.add(r.campaign_id)
  }
  const campaignCreatedAt = new Map<string, string | null>()
  let campaignMetaRows: (CampaignMetaRow & { meta_created_time: string | null; created_at: string | null })[] = []
  if (campaignIds.size > 0) {
    const { data: campMeta, error: campMetaErr } = await supabase
      .from('campaigns')
      .select('id, daily_budget, lifetime_budget, last_synced_at, meta_created_time, created_at')
      .in('id', [...campaignIds])
    if (campMetaErr) {
      console.error('[Flags] campaign metadata query failed:', campMetaErr.message)
      campaignDataError = true
    }
    campaignMetaRows = (campMeta ?? []) as typeof campaignMetaRows
    for (const c of campaignMetaRows) campaignCreatedAt.set(c.id, c.meta_created_time ?? c.created_at ?? null)
  }
  // Freshness-gated classification: only rows refreshed by THIS sync (>= boundary) resolve a
  // campaign's CBO state; stale/missing referenced campaigns stay unknown (frozen). A null boundary
  // disables budget evaluation outright.
  const { cbo: cboCampaigns, unknown: unknownCbo, unresolvedReferenced } =
    classifyCampaignMetadata(campaignMetaRows, campaignIds, metadataNotBefore)
  const budgetDecisionsEnabled = !campaignDataError && metadataNotBefore !== null
  if (!budgetDecisionsEnabled) console.warn('[Flags] budget evaluation disabled this run — ' +
    (campaignDataError ? 'campaign data unreadable' : 'no metadata-freshness boundary') + ' (fail closed)')
  if (unresolvedReferenced.length > 0) console.warn(`[Flags] ${unresolvedReferenced.length} referenced campaign(s) have UNRESOLVED (stale or missing) metadata — frozen (not refreshed by this sync)`)

  // ── Phase 3 — Evaluate flags IN MEMORY ──
  // Accumulate the complete new flag set + the evaluated/proven scopes + the frozen scopes, then publish
  // ONCE via replace_flag_generation (insert + supersede + stale-close in one locked, CAS-guarded txn).
  // No per-entity writes and no separate Phase 4 that could erase a flag on a failed insert.
  const newRows: Record<string, unknown>[] = []
  const evaluatedScopes: EvaluatedScope[] = []
  const provenKeys: ProvenKey[] = []
  const frozen: FrozenScopes = {
    global: !budgetDecisionsEnabled,
    campaign_ids: [...unknownCbo],
    // The RPC's structural closure (6b) judges campaign metadata ONLY at/after this instant;
    // null disables it (fail closed). Same boundary the classifier above used.
    campaign_metadata_not_before: metadataNotBefore,
  }
  const pushFlag = (entity_level: 'ad' | 'adset' | 'campaign', row: InsightRow, windowDays: number, flagRule: NonNullable<ReturnType<typeof evaluateFlag>>, audienceType: AudienceType) => {
    newRows.push({
      id: randomUUID(), flag_date: referenceDate, window_days: windowDays, entity_level,
      campaign_id: row.campaign_id, adset_id: entity_level === 'campaign' ? null : row.adset_id, ad_id: entity_level === 'ad' ? row.ad_id : null,
      meta_campaign_id: row.meta_campaign_id, meta_adset_id: entity_level === 'campaign' ? null : row.meta_adset_id, meta_ad_id: entity_level === 'ad' ? row.meta_ad_id : null,
      flag_type: flagRule.flag_type, confidence: flagRule.confidence, audience_type: audienceType, reason: flagRule.reason,
      evidence: { spend: row.spend, bookings: row.bookings, leads: row.leads, cpa: row.cost_per_booking, ctr: row.ctr, frequency: row.frequency, impressions: row.impressions, roas: row.roas, window_days: windowDays },
      // The flag's owner-facing action text is decided by the ONE authority layer,
      // never authored by the rule. Flag candidates rest on Meta-MODELLED conversions, so a money
      // candidate can never reach execution_eligible here and is persisted as an observation with no
      // imperative. The basis is stated as calendar_period_signal because that is what modelled
      // evidence is — passing the account basis would not change the tier (a candidate must itself be
      // on the interaction_cohort plane to qualify), only the label.
      recommended_action: renderFlagAction(flagRule, 'calendar_period_signal').copy,
      watch_next: flagRule.watch_next,
      spend_in_window: row.spend, cpa_in_window: row.cost_per_booking, ctr_in_window: row.ctr, frequency_in_window: row.frequency,
    })
  }
  for (const { windowDays, adAgg, adsetAgg, campaignAgg } of windows) {
    // ── Ad-level flags ─────────────────────────────────────
    for (const [adDbId, metrics] of adAgg.entries()) {
      evaluatedScopes.push({ entity_level: 'ad', entity_id: adDbId, window_days: windowDays })
      const meta = adMetaMap.get(adDbId) ?? DEFAULT_ENTITY_META
      const ageDays = daysSince(meta.created_at)

      const row = metrics
      // An ad's audience type is its parent ad set's (ads carry no audience_type column) — resolve from
      // the ad-set meta map, not the ad's own (now always-'unknown') meta.
      const audienceType = adsetMetaMap.get(row.adset_id ?? '')?.audience_type ?? 'unknown'
      const flagRule = evaluateFlag({
        spend: row.spend,
        cpa: row.cost_per_booking,
        cpl: row.cost_per_lead,
        ctr: row.ctr,
        frequency: row.frequency,
        impressions: row.impressions,
        bookings: row.bookings,
        leads: row.leads,
        roas: row.roas,
        window_days: windowDays,
        entity_age_days: ageDays,
        audience_type: audienceType,
      })

      if (!flagRule) continue
      // scale_candidate is a BUDGET decision and an AD never owns a budget (the unit is the CBO
      // campaign or ABO ad set). Suppress it universally at the ad level — don't add a proven key, so any
      // existing ad-level scale flag closes via stale resolution (the freeze never covers ad-level scale).
      if (flagRule.flag_type === 'scale_candidate') continue
      provenKeys.push({ entity_level: 'ad', entity_id: adDbId, window_days: windowDays, flag_type: flagRule.flag_type })
      pushFlag('ad', row, windowDays, flagRule, audienceType)
    }

    // ── Ad set-level flags ─────────────────────────────────
    for (const [adsetDbId, metrics] of adsetAgg.entries()) {
      evaluatedScopes.push({ entity_level: 'adset', entity_id: adsetDbId, window_days: windowDays })
      const meta = adsetMetaMap.get(adsetDbId) ?? DEFAULT_ENTITY_META
      const ageDays = daysSince(meta.created_at)

      const row = metrics
      const flagRule = evaluateFlag({
        spend: row.spend,
        cpa: row.cost_per_booking,
        cpl: row.cost_per_lead,
        ctr: row.ctr,
        frequency: row.frequency,
        impressions: row.impressions,
        bookings: row.bookings,
        leads: row.leads,
        roas: row.roas,
        window_days: windowDays,
        entity_age_days: ageDays,
        audience_type: meta.audience_type,
      })

      if (!flagRule) continue
      if (BUDGET_DECISION_FLAGS.has(flagRule.flag_type)) {
        const campId = row.campaign_id ?? ''
        // CBO state unknown (fail closed): FREEZE this ad-set budget decision when either the WHOLE run
        // couldn't read campaign data, OR this specific campaign's metadata row was absent (
        // unknownCbo). Mark the type proven so the RPC's stale-closure preserves an existing valid flag,
        // but write NO new row. The p_frozen scope also preserves it in the healthy/flip case.
        if (!budgetDecisionsEnabled || unknownCbo.has(campId)) {
          provenKeys.push({ entity_level: 'adset', entity_id: adsetDbId, window_days: windowDays, flag_type: flagRule.flag_type })
          continue
        }
        // Under CBO the campaign owns the budget decision — a per-ad-set pause/scale fights the
        // optimizer, so skip it here (the campaign loop below evaluates it) and let Phase 4 close any
        // stale ad-set budget flag left from before the campaign switched to CBO. Non-budget flags
        // (creative fatigue, watchlist, winner) stay at the ad-set level.
        if (suppressAdsetBudgetFlagUnderCbo(flagRule.flag_type, cboCampaigns.has(campId))) continue
      }
      provenKeys.push({ entity_level: 'adset', entity_id: adsetDbId, window_days: windowDays, flag_type: flagRule.flag_type })
      pushFlag('adset', row, windowDays, flagRule, meta.audience_type)
    }

    // ── Campaign-level flags — the optimization unit for CBO campaigns, BUDGET DECISIONS ONLY ─────
    // Non-budget signals (winner/watchlist/too_early/creative fatigue) stay at the ad-set/ad level;
    // emitting them here too would duplicate the same optimization narrative at two levels.
    for (const [campDbId, metrics] of campaignAgg.entries()) {
      if (!budgetDecisionsEnabled) continue // CBO state unknown — frozen (see fail-closed note above)
      // ABO campaigns are judged at the ad-set level. Their leftover campaign-level budget flags are closed
      // by the METADATA-driven CBO→ABO pass after this loop (not here — that pass doesn't need a campaign
      // insight row this window, so the closure survives a campaign that stopped reporting campaign-level).
      if (!cboCampaigns.has(campDbId)) continue
      evaluatedScopes.push({ entity_level: 'campaign', entity_id: campDbId, window_days: windowDays })
      const ageDays = daysSince(campaignCreatedAt.get(campDbId) ?? null)

      const row = metrics
      const flagRule = evaluateFlag({
        spend: row.spend,
        cpa: row.cost_per_booking,
        cpl: row.cost_per_lead,
        ctr: row.ctr,
        frequency: row.frequency,
        impressions: row.impressions,
        bookings: row.bookings,
        leads: row.leads,
        roas: row.roas,
        window_days: windowDays,
        entity_age_days: ageDays,
        audience_type: 'unknown', // campaigns are not audience-typed; that lives on ad sets/ads
      })

      if (!flagRule || !BUDGET_DECISION_FLAGS.has(flagRule.flag_type)) continue
      provenKeys.push({ entity_level: 'campaign', entity_id: campDbId, window_days: windowDays, flag_type: flagRule.flag_type })
      pushFlag('campaign', row, windowDays, flagRule, 'unknown')
    }

    // (Unit-transition closure — CBO→ABO campaign flags AND ABO→CBO ad-set flags, incl. fully-dormant
    // entities — lives in replace_flag_generation step 6b: judged from COMMIT-TIME campaigns metadata
    // through the real entity relationship, freshness-gated by frozen.campaign_metadata_not_before.
    // The engine no longer emits transition scopes.)
  }

  // ── Phase 4 — Publish the complete generation ATOMICALLY ──
  // ONE locked, CAS-guarded transaction does insert + per-row supersede + stale-closure + STRUCTURAL
  // unit closure + orphan closure + head rotation. Stale-closure (an entity that returned to health or
  // flipped type) and per-row supersede live inside replace_flag_generation, so a failed insert can no
  // longer erase a flag mid-run, and an overlapping/stale run fails the CAS instead of half-writing.
  // The frozen scopes tell the RPC which optimization-unit budget flags to preserve rather than close
  // and carry the freshness boundary for its structural judgment.
  const expectedPrev = await readCurrentGeneration(supabase, adAccountDbId, 'flag')
  const result = await replaceFlagGeneration(supabase, {
    adAccountId: adAccountDbId,
    generationId: randomUUID(),
    expectedPrev,
    referenceDate,
    newRows,
    evaluatedScopes,
    provenKeys,
    frozen,
  })
  // Merge the engine-side degradation signal: EVERY referenced campaign whose CBO state could not be
  // resolved this sync — stale AND missing alike (a missing row must not report green either).
  // The RPC's unknown_metadata_flags covers the active-flag half; together they define an honest
  // 'partial' run for the orchestrator.
  return { ...result, unresolved_referenced_campaigns: unresolvedReferenced.length }
}

// ── Aggregation helper ─────────────────────────────────────────
export function aggregateByKey(
  rows: Partial<InsightRow>[],
  key: keyof InsightRow
): Map<string, InsightRow> {
  const map = new Map<string, InsightRow>()

  for (const row of rows) {
    const id = row[key] as string | null
    if (!id) continue

    if (!map.has(id)) {
      map.set(id, {
        ad_id: row.ad_id ?? null,
        adset_id: row.adset_id ?? null,
        campaign_id: row.campaign_id ?? null,
        meta_ad_id: row.meta_ad_id ?? null,
        meta_adset_id: row.meta_adset_id ?? null,
        meta_campaign_id: row.meta_campaign_id ?? null,
        spend: 0,
        bookings: 0,
        leads: 0,
        ctr: null,
        frequency: null,
        cost_per_booking: null,
        cost_per_lead: null,
        roas: null,
        impressions: 0,
        clicks: 0,
        reach: 0,
      })
    }

    const agg = map.get(id)!
    agg.spend += Number(row.spend ?? 0)
    agg.bookings += Number(row.bookings ?? 0)
    agg.leads += Number(row.leads ?? 0)
    agg.impressions += Number(row.impressions ?? 0)
    agg.clicks += Number(row.clicks ?? 0)
    agg.reach += Number(row.reach ?? 0)

    // Recompute additive-derived rates from SUMMED totals — never average daily rates.
    agg.ctr = agg.impressions > 0 ? (agg.clicks / agg.impressions) * 100 : null
    // Reach is non-additive across days. A sum of daily reach therefore cannot establish a period
    // frequency, and it must never become a fatigue or action input. The sole safe case in this
    // daily warehouse is one row: Meta's native single-day period insight. Multi-day native
    // period frequency would need a distinct source contract before it can be used here.
    agg.frequency = mapFrequencyForSingleInsight(agg.frequency, row.frequency, agg.impressions, Number(row.impressions ?? 0))
    agg.cost_per_booking = agg.bookings > 0 ? agg.spend / agg.bookings : null
    agg.cost_per_lead = agg.leads > 0 ? agg.spend / agg.leads : null
  }

  return map
}

function mapFrequencyForSingleInsight(
  priorFrequency: number | null,
  rowFrequency: number | null | undefined,
  aggregateImpressions: number,
  rowImpressions: number,
): number | null {
  if (aggregateImpressions !== rowImpressions || priorFrequency !== null) return null
  return typeof rowFrequency === 'number' && Number.isFinite(rowFrequency) && rowFrequency >= 0
    ? rowFrequency
    : null
}
