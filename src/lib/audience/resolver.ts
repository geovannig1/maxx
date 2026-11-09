// ACCOUNT-SCOPED AUDIENCE RESOLVER — targeting configuration decides composition, never the name.
//
// THE DEFECT THIS REPLACES
//   export function isWarmAdset(name: string) { return /warm|retarget|remarket/i.test(name) }
// An ad set called "Warm/Retargeting" was therefore treated as pure retargeting for spend-share
// checks, overlap inference, and budget recommendations — even when its actual targeting combined
// website/engagement custom audiences WITH lookalikes AND Advantage audience expansion. That is a
// MIXED inventory, and a "shift budget into warm" recommendation built on the name is a
// recommendation about something that does not exist.
//
// RULES (binding)
//   • Names are DISPLAY-ONLY evidence. They may corroborate, never override, targeting JSON.
//   • Any combination of retargeting-style custom audiences with lookalikes or expansion is MIXED.
//   • Missing or stale targeting FREEZES budget and audience conclusions — it does not default to a
//     benign guess.
//   • Cross-account relationships FAIL CLOSED: an audience whose owning account cannot be confirmed
//     as this account is not counted as evidence of composition.

import {
  audienceReadinessFinding,
  resolveAudienceReference,
  type AudienceReadinessFinding,
  type AudienceRef,
} from './reference-readiness'

export type { AudienceReadinessFinding, AudienceRef } from './reference-readiness'

export type AudienceComposition =
  | 'retargeting_only'
  | 'lookalike'
  | 'broad_advantage'
  | 'mixed'
  | 'unknown'

export type Tri = 'enabled' | 'disabled' | 'unknown'

export interface TargetingEvidence {
  /** Ad set display name — evidence, never authority. */
  adsetName: string | null
  /** Raw Meta targeting spec. NULL means unavailable -> conclusions freeze. */
  targeting: Record<string, unknown> | null
  /** When the targeting snapshot was taken. NULL = unknown age -> treated as stale. */
  targetingSyncedAt: string | null
  /** The account this ad set belongs to, for cross-account fail-closed checks. */
  accountId: string
  /** Resolved audience metadata by id, when the app has it. Missing entries stay unknown. */
  audiencesById?: Record<string, AudienceRef>
}

export interface AudienceResolution {
  composition: AudienceComposition
  expansion: Tri
  includedCustomAudiences: AudienceRef[]
  includedLookalikes: AudienceRef[]
  excludedAudiences: AudienceRef[]
  /**
   * INCLUDED audience ids the targeting REFERENCES but whose subtype could not be established
   * (no custom_audiences metadata). Their presence makes composition unknown and freezes material
   * conclusions — an audience of unknown kind cannot be classified as retargeting or lookalike.
   */
  unresolvedIncludedAudienceIds: string[]
  /**
   * INCLUDED audience ids REJECTED as cross-account. They are not evidence about this account, but
   * they are also not absent: the ad set still delivers against them, so their presence must FREEZE
   * rather than silently reduce the inclusion count toward "broad".
   */
  rejectedIncludedAudienceIds: string[]
  /** Exclusions whose identity, ownership, or freshness could not be established. */
  unresolvedExcludedAudienceIds: string[]
  /** Exclusions that belong to another account. */
  rejectedExcludedAudienceIds: string[]
  /**
   * Audiences whose IDENTITY is fully established but whose Meta-side operation or delivery status
   * is not ready (e.g. a lookalike that failed to build, operation_status 433). They are classified
   * normally — a known kind is a known kind — and reported here as an account HEALTH finding. They
   * never freeze composition: "your audience is broken" is an answer, not an absence of one.
   */
  unhealthyIncludedAudienceIds: string[]
  unhealthyExcludedAudienceIds: string[]
  /** Structured source status retained for unhealthy and status-unknown referenced audiences. */
  audienceReadinessFindings: AudienceReadinessFinding[]
  /** One human-readable line per unhealthy audience, ready to surface to the owner. */
  audienceHealthFindings: string[]
  /** Total INCLUDED references the targeting actually listed, before any resolution or rejection. */
  referencedIncludedAudienceCount: number
  locations: { countries: string[]; regions: string[]; cities: string[]; radiusMiles: number | null }
  ageMin: number | null
  ageMax: number | null
  /** Every fact the verdict rests on, in evaluation order. */
  evidence: string[]
  /** 0..1. Reduced by staleness, unresolved audience metadata, and cross-account uncertainty. */
  confidence: number
  /** Populated whenever composition is 'unknown'. */
  unknownReason: string | null
  /** True when budget/audience conclusions must be withheld. */
  frozen: boolean
  /** What the NAME suggested, recorded purely so a name/targeting conflict is visible. */
  nameSuggests: 'warm' | 'cold' | 'none'
  nameConflictsWithTargeting: boolean
  /** Age of the targeting snapshot in hours; null when unknown. */
  targetingAgeHours: number | null
}

/** Targeting older than this is not a safe basis for a budget move. */
export const TARGETING_STALE_HOURS = 48

const RETARGETING_SUBTYPES = new Set(['WEBSITE', 'ENGAGEMENT', 'CUSTOM', 'APP', 'OFFLINE_CONVERSION', 'VIDEO', 'IG_BUSINESS', 'FB_EVENT'])
const LOOKALIKE_SUBTYPES = new Set(['LOOKALIKE'])

/** PURE: what the NAME hints at. Display-only — recorded, never decisive. */
export function readNameHint(name: string | null): 'warm' | 'cold' | 'none' {
  if (!name) return 'none'
  if (/warm|retarget|remarket|rtg/i.test(name)) return 'warm'
  if (/cold|prospect|broad|acquisition/i.test(name)) return 'cold'
  return 'none'
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** PURE: is Advantage audience expansion on? Meta exposes several spellings across versions. */
export function readExpansion(t: Record<string, unknown>): Tri {
  const keys = ['targeting_automation', 'targeting_optimization', 'advantage_audience']
  for (const k of keys) {
    const v = t[k]
    if (typeof v === 'object' && v !== null) {
      const inner = v as Record<string, unknown>
      const flag = inner.advantage_audience ?? inner.value
      if (flag === 1 || flag === true || flag === '1') return 'enabled'
      if (flag === 0 || flag === false || flag === '0') return 'disabled'
    }
    if (v === 1 || v === true) return 'enabled'
    if (v === 0 || v === false) return 'disabled'
  }
  // Older/alternate flags.
  const expansion = t.audience_expansion ?? t.lookalike_expansion_enabled
  if (expansion === true || expansion === 1) return 'enabled'
  if (expansion === false || expansion === 0) return 'disabled'
  return 'unknown'
}

/**
 * PURE: resolve an ad set's real audience composition from its targeting configuration.
 * Names never reach the verdict — only `nameSuggests` / `nameConflictsWithTargeting`.
 */
export function resolveAudience(input: TargetingEvidence, nowMs: number = Date.now()): AudienceResolution {
  const evidence: string[] = []
  const nameSuggests = readNameHint(input.adsetName)
  if (nameSuggests !== 'none') {
    evidence.push(`name suggests "${nameSuggests}" (DISPLAY ONLY — cannot override targeting)`)
  }

  const ageHours =
    input.targetingSyncedAt === null
      ? null
      : Math.max(0, (nowMs - Date.parse(input.targetingSyncedAt)) / 3_600_000)

  const base = {
    includedCustomAudiences: [] as AudienceRef[],
    includedLookalikes: [] as AudienceRef[],
    excludedAudiences: [] as AudienceRef[],
    locations: { countries: [] as string[], regions: [] as string[], cities: [] as string[], radiusMiles: null as number | null },
    ageMin: null as number | null,
    ageMax: null as number | null,
    unresolvedIncludedAudienceIds: [] as string[],
    rejectedIncludedAudienceIds: [] as string[],
    unresolvedExcludedAudienceIds: [] as string[],
    rejectedExcludedAudienceIds: [] as string[],
    unhealthyIncludedAudienceIds: [] as string[],
    unhealthyExcludedAudienceIds: [] as string[],
    audienceReadinessFindings: [] as AudienceReadinessFinding[],
    audienceHealthFindings: [] as string[],
    referencedIncludedAudienceCount: 0,
    nameSuggests,
    targetingAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
  }

  // MISSING targeting => freeze. Never a benign default.
  if (input.targeting === null || typeof input.targeting !== 'object') {
    evidence.push('targeting configuration is UNAVAILABLE — audience and budget conclusions are frozen')
    return {
      ...base, composition: 'unknown', expansion: 'unknown', evidence, confidence: 0,
      unknownReason: 'targeting configuration unavailable', frozen: true, nameConflictsWithTargeting: false,
    }
  }

  // STALE targeting => freeze. A budget move on a stale snapshot is a move on a guess.
  if (ageHours === null || ageHours > TARGETING_STALE_HOURS) {
    evidence.push(
      ageHours === null
        ? 'targeting snapshot age is UNKNOWN — treated as stale; conclusions frozen'
        : `targeting snapshot is ${ageHours.toFixed(1)}h old (> ${TARGETING_STALE_HOURS}h) — stale; conclusions frozen`,
    )
    return {
      ...base, composition: 'unknown', expansion: 'unknown', evidence, confidence: 0,
      unknownReason: ageHours === null ? 'targeting snapshot age unknown' : 'targeting snapshot is stale',
      frozen: true, nameConflictsWithTargeting: false,
    }
  }

  const t = input.targeting
  const lookup = input.audiencesById

  const includedRaw = asArray(t.custom_audiences)
  base.referencedIncludedAudienceCount = includedRaw.length
  for (const raw of includedRaw) {
    const out = resolveAudienceReference(
      raw, lookup, input.accountId, evidence, nowMs, TARGETING_STALE_HOURS,
    )
    if (out.kind === 'empty') continue
    const readiness = audienceReadinessFinding(out, 'included')
    if (readiness) base.audienceReadinessFindings.push(readiness)
    if (out.kind === 'rejected') { base.rejectedIncludedAudienceIds.push(out.ref.id); continue }
    if (out.kind === 'unresolved') { base.unresolvedIncludedAudienceIds.push(out.ref.id); continue }
    if (out.kind === 'unhealthy') {
      base.unhealthyIncludedAudienceIds.push(out.ref.id)
      base.audienceHealthFindings.push(out.detail)
    }
    if (LOOKALIKE_SUBTYPES.has(out.ref.subtype!)) base.includedLookalikes.push(out.ref)
    else base.includedCustomAudiences.push(out.ref)
  }
  // Segment purity depends on exclusions being present and healthy. An unverified exclusion can turn
  // intended Cold inventory into overlap, so it freezes the same material conclusions as an inclusion.
  for (const raw of asArray(t.excluded_custom_audiences)) {
    const out = resolveAudienceReference(
      raw, lookup, input.accountId, evidence, nowMs, TARGETING_STALE_HOURS,
    )
    if (out.kind === 'empty') continue
    const readiness = audienceReadinessFinding(out, 'excluded')
    if (readiness) base.audienceReadinessFindings.push(readiness)
    base.excludedAudiences.push(out.ref)
    if (out.kind === 'unresolved') base.unresolvedExcludedAudienceIds.push(out.ref.id)
    if (out.kind === 'rejected') base.rejectedExcludedAudienceIds.push(out.ref.id)
    if (out.kind === 'unhealthy') {
      base.unhealthyExcludedAudienceIds.push(out.ref.id)
      // A broken EXCLUSION is the sharper finding of the two: the people it was meant to suppress
      // are being shown ads. It is surfaced, not frozen — freezing hides it.
      base.audienceHealthFindings.push(`${out.detail} — this exclusion is NOT suppressing anyone`)
      // `refFor` already put the audience's own status line into `evidence`; what it CANNOT know
      // there is which side of the targeting the audience sits on. An unbuilt INCLUSION contributes
      // nobody; an unbuilt EXCLUSION suppresses nobody, and those are opposite consequences. Only
      // the second one means the ad set is reaching people it was configured not to.
      evidence.push(`audience ${out.ref.id} is an EXCLUSION Meta could not build — it is suppressing nobody, so this ad set is reaching people it was configured to exclude`)
    }
  }

  const geo = (typeof t.geo_locations === 'object' && t.geo_locations !== null ? t.geo_locations : {}) as Record<string, unknown>
  base.locations.countries = asArray(geo.countries).map(String)
  base.locations.regions = asArray(geo.regions).map((r) => String((r as Record<string, unknown>)?.name ?? (r as Record<string, unknown>)?.key ?? r))
  const cities = asArray(geo.cities)
  base.locations.cities = cities.map((c) => String((c as Record<string, unknown>)?.name ?? (c as Record<string, unknown>)?.key ?? c))
  const firstRadius = cities.map((c) => (c as Record<string, unknown>)?.radius).find((r) => typeof r === 'number')
  base.locations.radiusMiles = typeof firstRadius === 'number' ? firstRadius : null

  base.ageMin = typeof t.age_min === 'number' ? t.age_min : null
  base.ageMax = typeof t.age_max === 'number' ? t.age_max : null

  const expansion = readExpansion(t)
  // Every entry here has a RESOLVED subtype — an unknown-kind audience never reaches this list.
  const hasRetargeting = base.includedCustomAudiences.some((a) => RETARGETING_SUBTYPES.has(a.subtype!))
  const hasLookalike = base.includedLookalikes.length > 0

  evidence.push(`included custom audiences: ${base.includedCustomAudiences.length}, lookalikes: ${base.includedLookalikes.length}, exclusions: ${base.excludedAudiences.length}`)
  evidence.push(`Advantage audience expansion: ${expansion}`)

  let composition: AudienceComposition
  let unknownReason: string | null = null

  // FREEZE on any INCLUDED reference we could not establish. A referenced audience still delivers
  // whether or not we can classify it, so an unresolved or cross-account inclusion makes the whole
  // composition unknowable — it must never be dropped and then read as "broad".
  const unestablished = [...base.unresolvedIncludedAudienceIds, ...base.rejectedIncludedAudienceIds]
  if (unestablished.length > 0) {
    // The counts and the wording must match what actually happened. This message previously said
    // "have no resolved subtype" for every unresolved cause — including audiences whose subtype was
    // perfectly resolved and whose Meta build had simply failed — and that single wrong sentence is
    // what sent three separate investigations after a non-existent sync bug.
    unknownReason =
      `${base.unresolvedIncludedAudienceIds.length} included audience(s) could not be identified (unknown subtype, unconfirmed owner, or unknown/stale inventory age) and ` +
      `${base.rejectedIncludedAudienceIds.length} are owned by another account ` +
      `(${unestablished.join(', ')}) — composition cannot be established and material conclusions are frozen`
    evidence.push(unknownReason)
    return {
      ...base, composition: 'unknown', expansion, evidence, confidence: 0,
      unknownReason, frozen: true, nameConflictsWithTargeting: false,
    }
  }

  const unestablishedExclusions = [
    ...base.unresolvedExcludedAudienceIds,
    ...base.rejectedExcludedAudienceIds,
  ]
  if (unestablishedExclusions.length > 0) {
    unknownReason =
      `${base.unresolvedExcludedAudienceIds.length} excluded audience(s) could not be identified and ` +
      `${base.rejectedExcludedAudienceIds.length} are owned by another account ` +
      `(${unestablishedExclusions.join(', ')}) — segment purity cannot be established and material conclusions are frozen`
    evidence.push(unknownReason)
    return {
      ...base, composition: 'unknown', expansion, evidence, confidence: 0,
      unknownReason, frozen: true, nameConflictsWithTargeting: false,
    }
  }

  if (base.referencedIncludedAudienceCount === 0) {
    // The targeting listed NO inclusion references at all. Only this may resolve broad — a set whose
    // references were dropped by resolution has already frozen above.
    composition = 'broad_advantage'
    evidence.push('targeting references no custom audiences or lookalikes at all — broad targeting')
  } else if (hasRetargeting && (hasLookalike || expansion === 'enabled')) {
    // THE CASE THE NAME HID: retargeting-style audiences PLUS lookalikes and/or expansion.
    composition = 'mixed'
    evidence.push(
      `retargeting-style custom audience(s) combined with ${hasLookalike ? 'lookalike(s)' : ''}${hasLookalike && expansion === 'enabled' ? ' and ' : ''}${expansion === 'enabled' ? 'Advantage expansion' : ''} — this is MIXED inventory, not pure warm`,
    )
  } else if (hasRetargeting && !hasLookalike && expansion === 'disabled') {
    composition = 'retargeting_only'
    evidence.push('only retargeting-style custom audiences, no lookalikes, expansion disabled')
  } else if (!hasRetargeting && hasLookalike && expansion !== 'enabled') {
    composition = 'lookalike'
    evidence.push('lookalike-only inclusion')
  } else if (expansion === 'unknown') {
    // Expansion state decides between pure and mixed here, so not knowing it makes the verdict unknown.
    composition = 'unknown'
    unknownReason = 'Advantage audience expansion state is unknown, and it determines whether this set is pure or mixed'
    evidence.push(unknownReason)
  } else {
    composition = 'mixed'
    evidence.push('inclusion lists combine more than one audience kind — mixed')
  }

  // Confidence: start at 1 and subtract for every unresolved fact.
  // Every included audience that reaches here has a RESOLVED subtype (unresolved ones froze above),
  // so confidence now reflects only expansion certainty and snapshot age.
  let confidence = 1
  if (expansion === 'unknown') confidence *= 0.5
  if (ageHours > TARGETING_STALE_HOURS / 2) confidence *= 0.85
  // The configuration is known; how much of it is actually delivering is not. That is a confidence
  // cost, not a freeze.
  if (base.unhealthyIncludedAudienceIds.length > 0 || base.unhealthyExcludedAudienceIds.length > 0) {
    confidence *= 0.7
    evidence.push(
      `${base.unhealthyIncludedAudienceIds.length} included and ${base.unhealthyExcludedAudienceIds.length} excluded audience(s) are configured but NOT ready on Meta's side — the composition below describes the configuration, not the reachable inventory`,
    )
  }
  if (composition === 'unknown') confidence = Math.min(confidence, 0.3)

  // A name/targeting conflict is surfaced, never silently resolved either way.
  const nameConflictsWithTargeting =
    (nameSuggests === 'warm' && composition !== 'retargeting_only' && composition !== 'unknown') ||
    (nameSuggests === 'cold' && composition === 'retargeting_only')
  if (nameConflictsWithTargeting) {
    evidence.push(`CONFLICT: the name suggests "${nameSuggests}" but the targeting resolves to "${composition}". Targeting wins.`)
  }

  return {
    ...base,
    composition,
    expansion,
    evidence,
    confidence: Math.round(confidence * 100) / 100,
    unknownReason,
    frozen: false,
    nameConflictsWithTargeting,
  }
}

/**
 * PURE: may a budget move be prescribed into this inventory?
 * Mixed and unknown composition block a material budget move — the recommendation would be about
 * inventory whose actual makeup is not established.
 */
export interface BudgetMoveGate {
  allowed: boolean
  reason: string
  /** What to do instead when a direct move is not supported. */
  fallback: 'proceed' | 'test' | 'monitor' | 'freeze' | 'owner_review'
}

/** A move at or above this share of the current budget counts as material. */
export const MATERIAL_BUDGET_MOVE_SHARE = 0.2

export function gateBudgetMove(
  res: AudienceResolution,
  opts: { currentBudget: number | null; proposedBudget: number | null },
): BudgetMoveGate {
  if (res.frozen) {
    return { allowed: false, reason: `audience conclusions are frozen: ${res.unknownReason ?? 'targeting unavailable or stale'}`, fallback: 'freeze' }
  }
  // A NULL proposedBudget must never pass. It previously fell into `material = true`,
  // which is correct for the size test — but a move with no stated target is not a decidable move at
  // all: there is nothing to evaluate, approve, or roll back. It is rejected outright.
  if (opts.proposedBudget === null) {
    return {
      allowed: false,
      reason: 'no proposed budget was supplied — a budget move with no stated target cannot be evaluated, approved, or reversed',
      fallback: 'owner_review',
    }
  }
  if (opts.currentBudget === null) {
    return {
      allowed: false,
      reason: 'the current budget is unknown — a move cannot be sized against an unverified baseline',
      fallback: 'owner_review',
    }
  }

  const material =
    opts.currentBudget <= 0
      ? true // a zero/negative baseline is treated as material
      : Math.abs(opts.proposedBudget - opts.currentBudget) / opts.currentBudget >= MATERIAL_BUDGET_MOVE_SHARE

  if (!material) {
    return { allowed: true, reason: 'the proposed change is below the material-move threshold', fallback: 'proceed' }
  }
  if (res.composition === 'unknown') {
    return { allowed: false, reason: `audience composition is unknown (${res.unknownReason ?? 'unresolved'}) — a large budget move into unresolved inventory is not supported`, fallback: 'owner_review' }
  }
  if (res.composition === 'mixed') {
    return {
      allowed: false,
      reason: 'audience composition is MIXED (retargeting combined with lookalikes and/or Advantage expansion) — a large budget move would be prescribed into inventory whose makeup is not established',
      fallback: 'test',
    }
  }
  return { allowed: true, reason: `composition resolved as ${res.composition} with confidence ${res.confidence}`, fallback: 'proceed' }
}
