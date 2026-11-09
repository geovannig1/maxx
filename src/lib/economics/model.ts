import { formatMoney, formatMoneyAmount, roundMoney } from '@/lib/utils/format-currency'
// LEGACY UNIT-ECONOMICS SCENARIO — deterministic arithmetic over explicit planning assumptions.
// This is not a settled-cash view, not causal incrementality evidence, and has no money authority.
// The old export names remain temporarily for compatibility with offline diagnostic callers.

export interface EconomicsInputs {
  /** Explicit average booking value ($). */
  aov: number
  /** Gross/contribution margin rate 0..1; null = unknown. */
  gross_margin_rate: number | null
  /** Repeat-booking rate 0..1 within the declared horizon; null = unknown. */
  repeat_rate: number | null
  /** Human-readable provenance supplied with the value. */
  source_note: string
}

/** @deprecated Scenario math only. Do not use as observed profit or action evidence. */
export interface ProfitView {
  cpa: number | null
  bookings: number
  aov: number
  /** CPA as a share of AOV (revenue-multiple framing; works without margin). */
  cpa_share_of_aov: number | null
  /** Modeled margin-value scenario per assumed booking. Not incremental contribution. */
  contribution_per_booking: number | null
  /** Breakeven CPA = contribution_per_booking. null while margin unknown. */
  breakeven_cpa: number | null
  /** Modeled remainder after attributed booking CPA. Not causal profit. */
  profit_per_booking: number | null
  /** Every explicit assumption in play. */
  assumptions: string[]
  read: string
}

/** @deprecated PURE planning scenario. Never pass its output into money authority. */
export function buildProfitView(args: { cpa: number | null; bookings: number; inputs: EconomicsInputs }): ProfitView {
  const { cpa, bookings, inputs } = args
  const assumptions: string[] = [inputs.source_note]
  const cpa_share_of_aov = cpa !== null && isFinite(cpa) && inputs.aov > 0 ? cpa / inputs.aov : null

  let contribution_per_booking: number | null = null
  let breakeven_cpa: number | null = null
  let profit_per_booking: number | null = null

  if (inputs.gross_margin_rate !== null) {
    const repeat = inputs.repeat_rate ?? 0
    if (inputs.repeat_rate === null) assumptions.push('Repeat rate unknown — treated as 0 for this diagnostic estimate.')
    contribution_per_booking = inputs.aov * inputs.gross_margin_rate * (1 + repeat)
    breakeven_cpa = contribution_per_booking
    profit_per_booking = cpa !== null && isFinite(cpa) ? contribution_per_booking - cpa : null
  } else {
    assumptions.push('BREAKEVEN UNKNOWN — gross margin is not present in the explicit economics inputs.')
  }

  const parts: string[] = []
  if (cpa !== null && isFinite(cpa)) {
    parts.push(`CPA ${formatMoney(cpa)} on ${bookings} booking(s)`)
    if (cpa_share_of_aov !== null) parts.push(`= ${(cpa_share_of_aov * 100).toFixed(0)}% of the ${formatMoneyAmount(inputs.aov)} AOV input`)
  } else {
    parts.push(`No attributable CPA yet (${bookings} booking(s))`)
  }
  if (breakeven_cpa !== null) {
    parts.push(`Scenario breakeven CPA ≈ ${formatMoney(breakeven_cpa, { maximumFractionDigits: 0 })} (assumption-based)${profit_per_booking !== null ? `; modeled remainder/booking ≈ ${formatMoney(profit_per_booking, { maximumFractionDigits: 0 })}` : ''}. Not settled cash or incremental contribution.`)
  } else {
    parts.push('Breakeven is UNKNOWN until gross margin is explicitly supplied.')
  }

  return {
    cpa: cpa !== null && isFinite(cpa) ? roundMoney(cpa) : null,
    bookings,
    aov: inputs.aov,
    cpa_share_of_aov: cpa_share_of_aov !== null ? Math.round(cpa_share_of_aov * 1000) / 1000 : null,
    contribution_per_booking: contribution_per_booking !== null ? Math.round(contribution_per_booking) : null,
    breakeven_cpa: breakeven_cpa !== null ? Math.round(breakeven_cpa) : null,
    profit_per_booking: profit_per_booking !== null ? Math.round(profit_per_booking) : null,
    assumptions,
    read: parts.join(' · '),
  }
}

/**
 * PURE proposal derived only from explicit unit-economics inputs. The returned numbers have no action
 * authority and must pass through a separately governed target-approval surface before use.
 */
export function proposeCpaBands(inputs: EconomicsInputs): { excellent: number; healthy: number; watch: number; rationale: string } | null {
  if (inputs.gross_margin_rate === null) return null
  const repeat = inputs.repeat_rate ?? 0
  const breakeven = inputs.aov * inputs.gross_margin_rate * (1 + repeat)
  return {
    excellent: Math.round(breakeven * 0.4),
    healthy: Math.round(breakeven * 0.6),
    watch: Math.round(breakeven * 0.85),
    rationale: `Derived only from explicit breakeven inputs (≈ ${formatMoney(breakeven, { maximumFractionDigits: 0 })} = margin × AOV × (1+repeat)). PROPOSAL ONLY, with no action authority — approval in the governed target editor is required before use.`,
  }
}
