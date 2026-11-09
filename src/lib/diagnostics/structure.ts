import { formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'
// STRUCTURE CHECKS — deterministic observations for audience identity, spend allocation and possible
// eligibility overlap. They do not apply a universal retargeting allocation or infer auction harm.

export interface AdsetSpendSlice {
  name: string
  audience_type: string | null // 'professional' | 'consumer' | ... | null
  spend: number
  /**
   * RESOLVED composition from the targeting configuration (src/lib/audience/resolver.ts). When
   * supplied it DECIDES; the name is never consulted. Undefined only for legacy callers that have
   * not been given targeting yet — those degrade to the name hint and are reported as unresolved.
   */
  composition?: 'retargeting_only' | 'lookalike' | 'broad_advantage' | 'mixed' | 'unknown'
}

export interface RetargetingShareResult {
  total_spend: number
  warm_spend: number
  share: number | null // 0..1; null when no spend
  band: 'observed' | 'no_data'
  norm: null
  detail: string
  action_authority: 'diagnostic_only'
  prescriptions: readonly []
}

/**
 * NAME HINT ONLY — display evidence, never authority.
 *
 * This used to be the sole retargeting test, so an ad set named "Warm/Retargeting" was treated as
 * pure retargeting even when its targeting combined website/engagement audiences WITH lookalikes AND
 * Advantage expansion. Callers must pass a RESOLVED `composition` (from
 * src/lib/audience/resolver.ts); this function survives only to surface a name/targeting conflict.
 */
export function isWarmAdset(name: string): boolean {
  return /warm|retarget|remarket/i.test(name)
}

/** PURE: does this slice count as retargeting spend? Targeting decides; the name never does. */
export function isRetargetingSlice(a: AdsetSpendSlice): boolean {
  // Only a RESOLVED pure-retargeting composition counts. 'mixed' deliberately does NOT: spend into
  // mixed inventory is not retargeting spend, and counting it as such was the original error.
  return a.composition === 'retargeting_only'
}

/** PURE: observed share of spend going to resolved strict retargeting. There is no universal optimal
 * share: audience size, recency, funnel job, economics and CampaignPlan constraints own that choice. */
export function retargetingShareOfSpend(slices: AdsetSpendSlice[]): RetargetingShareResult {
  const total = slices.reduce((s, a) => s + a.spend, 0)
  const warm = slices.filter(isRetargetingSlice).reduce((s, a) => s + a.spend, 0)
  if (total <= 0) {
    return {
      total_spend: 0,
      warm_spend: 0,
      share: null,
      band: 'no_data',
      norm: null,
      detail: 'No spend was observed in the window, so no share classification is available.',
      action_authority: 'diagnostic_only',
      prescriptions: [],
    }
  }

  // Spend whose composition is MIXED or UNKNOWN is neither retargeting nor cold. Forcing it into one
  // bucket is what made a name-derived "warm share" look authoritative.
  const unresolved = slices.filter((a) => a.composition === undefined || a.composition === 'unknown' || a.composition === 'mixed')
  if (unresolved.length > 0) {
    const unresolvedSpend = roundMoney(unresolved.reduce((s, a) => s + a.spend, 0))
    return {
      total_spend: roundMoney(total),
      warm_spend: roundMoney(warm),
      share: null,
      band: 'no_data',
      norm: null,
      detail:
        `Retargeting share is NOT computable: ${formatMoneyAmount(unresolvedSpend)} of ${formatMoneyAmount(roundMoney(total))} sits in ad sets whose ` +
        `audience composition is mixed or unresolved (${unresolved.map((a) => a.name).join(', ')}). ` +
        'A share computed by NAME would be a claim about inventory that has not been established.',
      action_authority: 'diagnostic_only',
      prescriptions: [],
    }
  }
  const share = warm / total
  const pct = Math.round(share * 100)
  return {
    total_spend: roundMoney(total),
    warm_spend: roundMoney(warm),
    share: Math.round(share * 1000) / 1000,
    band: 'observed',
    norm: null,
    detail: `Observed strict-retargeting share is ${pct}%. No universal allocation benchmark is applied; the intended funnel job, audience size/recency, economics and approved CampaignPlan are required to judge the split.`,
    action_authority: 'diagnostic_only',
    prescriptions: [],
  }
}

export interface OverlapInference {
  risk: 'possible' | 'not_applicable'
  label: 'ASSUMPTION'
  detail: string
  owner_check: string
  action_authority: 'diagnostic_only'
  prescriptions: readonly []
}

/** PURE: auction-overlap inference — ALWAYS an assumption (Meta's auction benchmarks return nothing at
 *  this account size); gives the owner-side verification path instead of asserting. */
export function auctionOverlapInference(adsetNames: string[]): OverlapInference {
  const hasCold = adsetNames.some((n) => /cold|prospect|advantage/i.test(n))
  const hasWarm = adsetNames.some((n) => isWarmAdset(n))
  if (!(hasCold && hasWarm)) {
    return {
      risk: 'not_applicable',
      label: 'ASSUMPTION',
      detail: 'No simultaneous cold + warm ad sets delivering — overlap between funnel stages is not in play.',
      owner_check: 'Not applicable to the observed structure.',
      action_authority: 'diagnostic_only',
      prescriptions: [],
    }
  }
  return {
    risk: 'possible',
    label: 'ASSUMPTION',
    detail:
      'Cold delivery that may expand beyond suggestions and a separate warm set are live in the same geography. Eligibility may overlap, but this diagnostic has no auction-level overlap observation and cannot infer under-delivery, cost impact, or learning status from coexistence alone.',
    owner_check: 'No auction-level overlap measurement is available in this diagnostic; treat the overlap hypothesis as unconfirmed.',
    action_authority: 'diagnostic_only',
    prescriptions: [],
  }
}

// ── A7: spend concentration ──────────────────────────────────────────────────────────────────────
// "Four ad sets" can mean four, or it can mean one plus rounding. Effective entity count (the
// inverse Herfindahl, 1/Σ share²) says which.
//
// The reading FLIPS on who controls budget, so the control is carried with the number:
//   • CBO (campaign budget) — concentration is Meta allocating toward marginal efficiency. That is
//     the system working, and calling it a defect would contradict the breakdown effect.
//   • ABO (ad-set budgets)  — the owner set the split, so concentration means delivery is not
//     matching the intended allocation.
// Either way this is an observation. It never prescribes a reallocation.

export type BudgetControl = 'campaign' | 'adset' | 'mixed' | 'unknown'

export interface SpendConcentrationResult {
  total_spend: number
  top: { name: string; spend: number; share: number } | null
  /** 1/Σ(share²) — how many ad sets the spend is EFFECTIVELY spread across. */
  effective_entities: number | null
  budget_control: BudgetControl
  detail: string
  action_authority: 'diagnostic_only'
  prescriptions: readonly []
}

export function spendConcentration(
  slices: AdsetSpendSlice[],
  budgetControl: BudgetControl,
): SpendConcentrationResult {
  const round2 = (n: number) => Math.round(n * 100) / 100
  const delivering = slices.filter((s) => s.spend > 0)
  const total = delivering.reduce((sum, s) => sum + s.spend, 0)

  const base = {
    total_spend: roundMoney(total),
    budget_control: budgetControl,
    action_authority: 'diagnostic_only' as const,
    prescriptions: [] as const,
  }

  if (total <= 0) {
    return { ...base, top: null, effective_entities: null, detail: 'No spend in the window — concentration is undefined.' }
  }

  const shares = delivering.map((s) => ({ ...s, share: s.spend / total }))
  const top = shares.reduce((a, b) => (b.share > a.share ? b : a))
  const hhi = shares.reduce((sum, s) => sum + s.share * s.share, 0)
  const effective = round2(1 / hhi)

  const shape =
    `${formatMoneyAmount(roundMoney(total))} across ${delivering.length} delivering ad set(s), effectively ${effective}. ` +
    `Top: "${top.name}" at ${Math.round(top.share * 100)}% (${formatMoneyAmount(roundMoney(top.spend))}).`

  const reading =
    budgetControl === 'campaign'
      ? ' Budget is controlled at the campaign budget level, so this allocation is Meta\'s to make — concentration here is the expected result of optimizing marginal efficiency, not a defect.'
      : budgetControl === 'adset'
        ? ' Budget is controlled by ad-set budgets, so this split was set by the owner; a concentrated result means delivery is not matching the intended allocation.'
        : ' Budget control is mixed or unresolved, so the concentration cannot be attributed to Meta or to the configured split.'

  return { ...base, top: { name: top.name, spend: roundMoney(top.spend), share: round2(top.share) }, effective_entities: effective, detail: shape + reading }
}
