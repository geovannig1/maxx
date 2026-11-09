import type { MetricClaim } from '@/lib/cockpit/contracts'
import { claim, cockpitClaims, type GovernedAuditBuildInput, type GovernedAuditEvidence } from './governed-audit-claim'
import { MAX_UNAVAILABLE_BRIEF_CLAIMS } from './answer-brief'
import {
  audienceReadinessProjections,
  count,
  deliveryStatusProjection,
  finite,
  instantSourceWindow,
  isoInstant,
  nestedSection,
  record,
  safeCode,
  safeId,
  safeName,
  snapshotWindow,
  sourceWindow,
} from './governed-audit-source'
import { metaOutcomeEventName } from '@/config/business-config'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()
// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export type { GovernedAuditBuildInput, GovernedAuditEvidence } from './governed-audit-claim'

/**
 * Project internal read-only diagnostics into a compact MetricClaim packet. No diagnostic prose is
 * promoted: every string value below is selected from a closed server vocabulary, while external
 * names are accepted only through a conservative display-name grammar.
 */
export function buildGovernedAuditEvidence(input: GovernedAuditBuildInput): GovernedAuditEvidence {
  const claims = new Map<string, MetricClaim>()
  const required = new Set<string>()
  const add = (item: MetricClaim, needed = false) => {
    claims.set(item.claimId, item)
    if (needed) required.add(item.claimId)
  }

  const requiredCockpitMetrics = input.focus === 'owner_ads_audit'
    ? new Set([
        'meta.spend', 'meta.appointment_confirmed_results', 'meta.cost_per_result',
        'meta.link_ctr', 'meta.cpm',
      ])
    : input.focus === 'budget_goal'
      ? new Set(['meta.spend', 'meta.current_daily_budget'])
      : input.focus === 'general'
        ? new Set(['meta.spend', 'meta.appointment_confirmed_results', 'meta.cost_per_result'])
        : new Set<string>()
  for (const item of cockpitClaims(input.cockpit)) {
    add(item, item.availability.state === 'available' && requiredCockpitMetrics.has(item.metricKey))
  }

  const diagnosis = record(input.diagnosis)
  const modelledAppointments = finite(record(diagnosis?.conversions)?.meta_modelled_bookings)
  add(claim(input, {
    metricKey: 'appointments',
    label: `Meta-modelled ${EVENT} Results`,
    value: modelledAppointments,
    unit: 'count',
    system: 'meta', role: 'delivery_truth', plane: 'meta_delivery',
    level: 'account', entityId: input.accountId,
    scope: 'meta_platform_modelled', measurementKind: 'modelled',
    ...(modelledAppointments === null ? { blockerCode: 'meta_modelled_results_unavailable' } : {}),
  }), input.focus === 'owner_ads_audit')

  const adsets = Array.isArray(diagnosis?.adsets_detail) ? diagnosis.adsets_detail : []
  const audiences = Array.isArray(diagnosis?.audiences) ? diagnosis.audiences : []
  for (const raw of adsets) {
    const adset = record(raw)
    const entityId = safeId(adset?.id ?? adset?.adset_id)
    if (!adset || !entityId) continue
    const display = safeName(adset.name, `Ad set ${entityId}`)
    const stage = typeof adset.learning_phase === 'string'
      && ['LEARNING', 'LEARNING_LIMITED', 'SUCCESS'].includes(adset.learning_phase)
      ? adset.learning_phase.replaceAll('_', ' ').toLowerCase()
      : null
    const needsAdset = input.focus === 'owner_ads_audit' || input.focus === 'adset_setup'
    add(claim(input, {
      metricKey: 'meta.adset.learning_state',
      label: `${display} learning state`,
      value: stage,
      unit: 'state',
      system: 'meta', role: 'delivery_truth', plane: 'meta_delivery',
      level: 'adset', entityId,
      scope: 'none', measurementKind: 'operational',
      ...(stage === null ? { blockerCode: 'meta_learning_state_unavailable' } : {}),
    }), needsAdset)
    const deliveryStatus = deliveryStatusProjection(adset.delivery_sub_status)
    add(claim(input, {
      metricKey: 'meta.adset.delivery_sub_status',
      label: `${display} delivery sub-status`,
      value: deliveryStatus.value,
      unit: 'state',
      system: 'meta', role: 'delivery_truth', plane: 'meta_delivery',
      level: 'adset', entityId,
      scope: 'none', measurementKind: 'operational',
      sourceHead: 'meta.delivery_sub_status',
      observedAt: deliveryStatus.observedAt,
      window: snapshotWindow(deliveryStatus.observedAt ?? input.asOf),
      ...(deliveryStatus.blockerCode ? { blockerCode: deliveryStatus.blockerCode } : {}),
    }), needsAdset)
    const audience = audiences
      .map(record)
      .find((candidate) => candidate?.adset_id === entityId) ?? null
    const resolution = record(audience?.resolution)
    const composition = resolution?.composition
    const compositionLabel: Record<string, string> = {
      retargeting_only: 'Retargeting only',
      lookalike: 'Lookalike acquisition',
      broad_advantage: 'Broad Advantage+ acquisition',
      mixed: 'Mixed acquisition and retargeting',
      unknown: 'Unknown',
    }
    const audienceValue = typeof composition === 'string' ? compositionLabel[composition] ?? null : null
    add(claim(input, {
      metricKey: 'meta.adset.audience_composition',
      label: `${display} audience composition`,
      value: audienceValue,
      unit: 'state',
      system: 'meta', role: 'measurement_qa', plane: 'meta_delivery',
      level: 'adset', entityId,
      scope: 'none', measurementKind: 'operational',
      ...(audienceValue === null ? { blockerCode: 'audience_composition_unavailable' } : {}),
    }), needsAdset)
    const readiness = audienceReadinessProjections(resolution)
    readiness.items.forEach((item, index) => {
      add(claim(input, {
        metricKey: 'meta.adset.audience_readiness',
        label: `${display} audience readiness`,
        value: item.value,
        unit: 'state',
        system: 'meta', role: 'measurement_qa', plane: 'meta_delivery',
        level: 'adset', entityId,
        scope: 'none', measurementKind: 'operational',
        sourceHead: 'meta.custom_audience_inventory',
        observedAt: item.observedAt,
        window: snapshotWindow(item.observedAt ?? input.asOf),
        authority: item.authority,
        discriminator: `audience-${index + 1}`,
        ...(item.blockerCode ? { blockerCode: item.blockerCode } : {}),
      }), needsAdset)
    })
    if (readiness.incomplete) {
      add(claim(input, {
        metricKey: 'meta.adset.audience_readiness_coverage',
        label: `${display} additional audience readiness evidence`,
        value: null,
        unit: 'state',
        system: 'meta', role: 'measurement_qa', plane: 'meta_delivery',
        level: 'adset', entityId,
        scope: 'none', measurementKind: 'operational',
        sourceHead: 'meta.custom_audience_inventory',
        authority: 'blocked',
        blockerCode: 'audience_readiness_evidence_incomplete',
      }), needsAdset)
    }
  }

  const economics = record(input.economics)
  const economicsWindow = sourceWindow(economics?.window, 'start', 'end')
  const business = record(economics?.business)
  const confirmed = finite(business?.confirmed_appointments)
  add(claim(input, {
    metricKey: 'appointments',
    label: `Outcome source confirmed ${OW.many} — all sources`,
    value: confirmed,
    unit: 'count',
    system: 'outcomes', role: 'business_truth', plane: 'outcome_business',
    level: 'business', entityId: input.accountId,
    scope: 'all_sources', measurementKind: 'measured', basis: 'booking_created_date_et',
    authority: 'authoritative',
    window: economicsWindow,
    ...(confirmed === null ? { blockerCode: 'outcome_appointments_unavailable' } : {}),
  }), input.focus === 'owner_ads_audit' || input.focus === 'budget_goal')
  const checkoutRevenue = finite(business?.outcome_recorded_checkout_revenue)
  add(claim(input, {
    metricKey: 'outcomes.checkout_revenue',
    label: 'recorded collected value — all sources',
    value: checkoutRevenue,
    unit: 'money',
    system: 'outcomes', role: 'business_truth', plane: 'outcome_business',
    level: 'business', entityId: input.accountId,
    scope: 'all_sources', measurementKind: 'measured', basis: 'booking_created_date_et',
    authority: 'authoritative',
    window: economicsWindow,
    ...(checkoutRevenue === null ? { blockerCode: 'outcome_checkout_revenue_unavailable' } : {}),
  }), input.focus === 'budget_goal')

  const paid = record(economics?.paid)
  const paidCpa = finite(paid?.cpa)
  const paidRoas = finite(paid?.revenue_roas)
  for (const [metricKey, label, value, unit] of [
    ['paid.cpa', 'Exact Meta paid CPA', paidCpa, 'money'],
    ['paid.roas', 'Exact Meta paid checkout-revenue ROAS', paidRoas, 'ratio'],
  ] as const) {
    add(claim(input, {
      metricKey, label, value,
      unit,
      system: 'first_party_attribution', role: 'association_truth', plane: 'paid_association',
      level: 'account', entityId: input.accountId,
      scope: 'meta_click_associated_noncausal', measurementKind: 'associated_noncausal',
      window: economicsWindow,
      ...(value === null ? { blockerCode: 'exact_meta_paid_join_unavailable' } : {}),
    }), input.focus === 'owner_ads_audit' || input.focus === 'budget_goal')
  }

  const reconciliation = record(input.reconciliation)
  const reconciliationWindow = sourceWindow(reconciliation?.window, 'from', 'to')
  const ga4Available = reconciliation?.ga4_available === true
  add(claim(input, {
    metricKey: 'ga4.confirmation_telemetry_status',
    label: 'GA4 confirmation-event telemetry',
    value: ga4Available ? `Available — telemetry only, not ${OW.many} or revenue` : null,
    unit: 'state',
    system: 'ga4', role: 'measurement_qa', plane: 'ga4_telemetry',
    level: 'account', entityId: input.accountId,
    scope: 'ga4_session_classified', measurementKind: 'telemetry',
    window: reconciliationWindow,
    ...(ga4Available ? {} : { blockerCode: 'ga4_confirmation_telemetry_unavailable' }),
  }), input.focus === 'owner_ads_audit')
  const utm = record(reconciliation?.utm)
  const adsTotal = count(utm?.ads_total)
  const adsCorrect = count(utm?.ads_correct)
  const adsMissing = count(utm?.ads_missing)
  const adsMisconfigured = count(utm?.ads_misconfigured)
  const adsUnverified = count(utm?.ads_unverified)
  const utmCounts = [adsTotal, adsCorrect, adsMissing, adsMisconfigured, adsUnverified]
  const utmCountsKnown = utmCounts.every((value) => value !== null)
  const utmCountsCoherent = utmCountsKnown
    && adsTotal === adsCorrect! + adsMissing! + adsMisconfigured! + adsUnverified!
  const judgeableAds = utmCountsCoherent ? adsTotal! - adsUnverified! : 0
  const scopeLabel: Record<string, string> = {
    active_ads: 'active ads',
    launch_cohort: 'launch-cohort ads',
    all_non_archived_ads: 'non-archived ads',
  }
  const utmScope = typeof utm?.scope === 'string'
    ? scopeLabel[utm.scope] ?? 'scoped ads'
    : 'scoped ads'
  const utmState = utmCountsCoherent && judgeableAds > 0
    ? `${adsCorrect}/${judgeableAds} judgeable ${utmScope} correct; ${adsMissing} missing; `
      + `${adsMisconfigured} misconfigured; ${adsUnverified} unverified`
    : null
  const utmBlocker = !utmCountsCoherent
    ? 'utm_health_unavailable'
    : judgeableAds === 0
      ? 'utm_health_unverified'
      : null
  add(claim(input, {
    metricKey: 'tracking.utm_health',
    label: 'Synced Meta UTM configuration health',
    value: utmState,
    unit: 'state',
    system: 'meta', role: 'measurement_qa', plane: 'meta_delivery',
    level: 'account', entityId: input.accountId,
    scope: 'none', measurementKind: 'operational',
    sourceHead: 'synced_meta_utm_configuration',
    window: snapshotWindow(input.asOf),
    ...(utmBlocker ? { blockerCode: utmBlocker } : {}),
  }), input.focus === 'owner_ads_audit')
  const quality = record(record(reconciliation?.signals)?.dataset_quality)
  const qualityProvenance = record(quality?.provenance)
  const capiWindow = instantSourceWindow(qualityProvenance, 'windowStart', 'windowEnd')
  const capiObservedAt = isoInstant(qualityProvenance?.respondedAt)
  const capiApiVersion = safeCode(qualityProvenance?.apiVersion)
  const capiAvailable = quality?.available === true
    && capiWindow !== null
    && capiObservedAt !== null
    && capiApiVersion !== null
  add(claim(input, {
    metricKey: 'capi.dataset_quality',
    label: 'CAPI dataset-quality diagnostics',
    value: capiAvailable ? 'Available from supported Meta dataset statistics' : null,
    unit: 'state',
    system: 'capi', role: 'delivery_transport', plane: 'capi_delivery',
    level: 'account', entityId: input.accountId,
    scope: 'capi_event_delivery', measurementKind: 'telemetry',
    sourceHead: capiApiVersion ? `meta.dataset_stats:${capiApiVersion}` : 'meta.dataset_stats',
    observedAt: capiObservedAt,
    window: capiWindow ? { ...capiWindow, basis: 'interaction_date_et' } : null,
    ...(capiAvailable
      ? {}
      : { blockerCode: quality?.available === true
          ? 'capi_dataset_provenance_unavailable'
          : 'capi_dataset_quality_unavailable' }),
  }), input.focus === 'owner_ads_audit')

  const operating = record(input.operatingMode)
  const mode = record(operating?.mode) ?? operating
  const canScale = mode?.canRecommendBudgetScale === true
  const verdict = typeof mode?.budgetVerdict === 'string'
    && ['scale_candidate', 'healthy_signal_review', 'loss_signal_review', 'conflicting_signals_review', 'hold_watch', 'insufficient_evidence'].includes(mode.budgetVerdict)
    ? mode.budgetVerdict.replaceAll('_', ' ')
    : 'insufficient evidence'
  // Descriptive only: the guard reads "— Scale …" (label — value) as an instruction and withholds the answer.
  add(claim(input, {
    metricKey: 'decision.scale_authority',
    label: 'Governed scaling status',
    value: canScale
      ? 'Eligible for scaling — owner approval is still required'
      : `Not authorized for scaling — the budget verdict is ${verdict}`,
    unit: 'state',
    system: 'maxx', role: 'decision_context', plane: 'decision',
    level: 'account', entityId: input.accountId,
    scope: 'none', measurementKind: 'operational', authority: 'authoritative',
  }), ['owner_ads_audit', 'budget_goal', 'general'].includes(input.focus))
  const profit = record(economics?.profit_view)
  const budgetCeiling = finite(profit?.daily_budget_ceiling)
  add(claim(input, {
    metricKey: 'decision.daily_budget_ceiling',
    label: 'Owner-approved account daily ad-spend ceiling',
    value: budgetCeiling,
    unit: 'money',
    system: 'maxx', role: 'decision_context', plane: 'decision',
    level: 'account', entityId: input.accountId,
    scope: 'none', measurementKind: 'operational', authority: 'authoritative',
    ...(budgetCeiling === null ? { blockerCode: 'daily_budget_ceiling_unavailable' } : {}),
  }), input.focus === 'budget_goal')

  const recommendations = record(input.recommendations)
  const recommendationHealth = recommendations?.read_health
  const recommendationCount = finite(recommendations?.count)
  const healthyRecommendations = recommendationHealth === 'healthy' && recommendationCount !== null
  add(claim(input, {
    metricKey: 'decision.current_recommendations',
    label: 'Current governed recommendation feed',
    value: healthyRecommendations
      ? recommendationCount === 0
        ? 'Healthy empty snapshot — no current governed action decision'
        : `${recommendationCount} current governed recommendation${recommendationCount === 1 ? '' : 's'}`
      : null,
    unit: 'state',
    system: 'maxx', role: 'decision_context', plane: 'decision',
    level: 'account', entityId: input.accountId,
    scope: 'none', measurementKind: 'operational', authority: 'authoritative',
    ...(healthyRecommendations ? {} : { blockerCode: 'current_recommendations_unavailable' }),
  }), true)

  const creative = record(input.creative)
  const creativeWindow = sourceWindow(creative?.period, 'start', 'end')
  const mix = record(creative?.format_mix)
  const totalCreatives = finite(mix?.total_creatives)
  const shares = Array.isArray(mix?.shares)
    ? mix.shares.map(record).filter((share): share is Record<string, unknown> => share !== null)
    : []
  const knownFormats = shares.filter((share) => typeof share.format === 'string' && share.format !== 'unknown')
  const formatState = totalCreatives !== null
    ? knownFormats.length === 1
      ? `All ${totalCreatives} observed creatives use ${String(knownFormats[0].format)} format`
      : `${totalCreatives} observed creatives across ${knownFormats.length} known formats`
    : null
  add(claim(input, {
    metricKey: 'meta.creative.format_mix',
    label: 'Creative format mix',
    value: formatState,
    unit: 'state',
    system: 'meta', role: 'delivery_truth', plane: 'meta_delivery',
    level: 'account', entityId: input.accountId,
    scope: 'none', measurementKind: 'operational',
    window: creativeWindow,
    ...(formatState === null ? { blockerCode: 'creative_format_mix_unavailable' } : {}),
  }), input.focus === 'creative_quality')
  const adStatuses = Array.isArray(creative?.ad_delivery_sub_statuses)
    ? creative.ad_delivery_sub_statuses : []
  for (const raw of adStatuses) {
    const ad = record(raw)
    const entityId = safeId(ad?.ad_id)
    if (!ad || !entityId) continue
    const deliveryStatus = deliveryStatusProjection(ad.delivery_sub_status)
    add(claim(input, {
      metricKey: 'meta.ad.delivery_sub_status',
      label: `${safeName(ad.ad_name, `Ad ${entityId}`)} delivery sub-status`,
      value: deliveryStatus.value,
      unit: 'state',
      system: 'meta', role: 'delivery_truth', plane: 'meta_delivery',
      level: 'ad', entityId,
      scope: 'none', measurementKind: 'operational',
      sourceHead: 'meta.delivery_sub_status',
      observedAt: deliveryStatus.observedAt,
      window: snapshotWindow(deliveryStatus.observedAt ?? input.asOf),
      ...(deliveryStatus.blockerCode ? { blockerCode: deliveryStatus.blockerCode } : {}),
    }), input.focus === 'creative_quality')
  }

  const decisions = Array.isArray(recommendations?.persisted_final_action_decisions)
    ? recommendations.persisted_final_action_decisions : []

  // BOUND THE REQUIRED PACKET TO THE SURFACE THAT RENDERS IT.
  //
  // `normalizeAnswerBriefValue` force-selects every id below and throws past
  // MAX_UNAVAILABLE_BRIEF_CLAIMS unavailable ones — a bound sized for a two-ad-set audit. The ad set
  // loop above marks three claims required for EVERY row of `adsets_detail` under an
  // `owner_ads_audit` / `adset_setup` focus, and each is unavailable when Meta has not synced that ad
  // set. An account with ten ad sets makes the server declare 37 against a budget of 16, and the
  // renderer threw. The chat caught that throw and returned `brief: null`, which the owner
  // read as "the answer was withheld" and the eval reported as `no governed brief produced` — for
  // every ad set question, on every trial, since the packet was introduced. `q3-creative-quality`
  // passed alone because a creative focus marks no ad set claims required.
  //
  // Account-level requirements are kept and the ad set term is demoted, because the ad set term is
  // the one that grows without bound. A demoted claim is still published and still citable — it is
  // only no longer FORCED into every brief. Silence about that would be the same defect one level
  // down, so the count of ad sets it covers is published as its own claim.
  const requiredIds = [...required].filter((id) => claims.has(id))
  const unavailable = (id: string) => claims.get(id)?.availability.state === 'unavailable'
  const adsetLevel = (id: string) => claims.get(id)?.metricKey.startsWith('meta.adset.') === true
  // +1: the coverage claim published below is itself required and unavailable, so it needs a slot.
  const overBudget = requiredIds.filter(unavailable).length - MAX_UNAVAILABLE_BRIEF_CLAIMS + 1
  const demoted = new Set<string>()
  if (overBudget > 0) {
    // Last ad set first, so a stable prefix of ad sets keeps its forced evidence run to run.
    for (const id of requiredIds.filter((candidate) => unavailable(candidate) && adsetLevel(candidate)).reverse()) {
      if (demoted.size >= overBudget) break
      demoted.add(id)
    }
  }
  if (demoted.size > 0) {
    const entities = new Set([...demoted].map((id) => claims.get(id)?.entity.id).filter(Boolean))
    add(claim(input, {
      metricKey: 'meta.adset.required_evidence_coverage',
      label: 'Ad sets whose setup evidence is published but not forced into every answer',
      value: null,
      unit: 'state',
      system: 'meta', role: 'measurement_qa', plane: 'meta_delivery',
      level: 'account', entityId: input.accountId,
      scope: 'none', measurementKind: 'operational',
      authority: 'blocked',
      blockerCode: `adset_required_evidence_demoted:${entities.size}`,
    }), true)
  }

  return {
    claims: [...claims.values()],
    required_claim_ids: [...required].filter((id) => claims.has(id) && !demoted.has(id)),
    persisted_final_action_decisions: decisions,
  }
}

/** Pull a named section from the one-round diagnosis bundle without promoting its prose. */
export function diagnosisBundleSection(bundle: unknown, name: string): unknown {
  return nestedSection(bundle, name)
}
