import { formatMoney } from '@/lib/utils/format-currency'
// Spend & money reconciliation — the "prove the numbers" layer. Three honest checks, each grounded in
// data we actually hold:
//
//   1. Spend integrity (Meta-internal): does the account-level insight spend agree with the rolled-up
//      daily_reports figure the dashboard shows, and with the sum of campaign-level rows? Divergence =
//      a sync/rollup gap (missing days, a level that didn't sync), NOT a real performance signal.
//   2. Plane conflict (Meta modelled estimate vs GA confirmation-event telemetry): NEITHER is money, so
//      this surfaces how far Meta's modelled figure sat from GA4 IN THIS WINDOW — plus attribution coverage.
//   3. Billed context (lifetime): Meta's lifetime amount_spent vs everything we've tracked. Honest
//      caveat baked in — we track a rolling window, so lifetime billed legitimately exceeds it; this is
//      a coverage gauge, never an alarm.
//
// All pure functions. The Trust Engine scores the whole reconciliation separately (via the variance).

const EPS = 1e-9

/** Signed percent change of `a` vs reference `ref`. null when it can't be computed. */
export function signedPct(a: number | null, ref: number | null): number | null {
  if (a == null || ref == null || !isFinite(a) || !isFinite(ref) || Math.abs(ref) < EPS) return null
  return ((a - ref) / ref) * 100
}

function absPct(a: number | null, ref: number | null): number | null {
  const p = signedPct(a, ref)
  return p == null ? null : Math.abs(p)
}

// ── 1. Spend integrity ─────────────────────────────────────────────────────────────────────────
export type IntegrityStatus = 'aligned' | 'minor_drift' | 'mismatch' | 'unknown'

export interface SpendIntegrityInput {
  accountInsightsSpend: number // Σ daily_insights (account level) over the window — the reference
  reportSpend: number | null // Σ daily_reports.total_spend over the window (what the dashboard shows)
  campaignInsightsSpend: number | null // Σ daily_insights (campaign level) over the window
  days: number
}

export interface SpendIntegrityResult {
  windowSpend: number
  reportSpend: number | null
  campaignSpend: number | null
  reportVariancePct: number | null
  campaignVariancePct: number | null
  worstVariancePct: number
  status: IntegrityStatus
  note: string
}

function integrityStatus(worst: number): IntegrityStatus {
  if (worst <= 1) return 'aligned'
  if (worst <= 5) return 'minor_drift'
  return 'mismatch'
}

export function reconcileSpendIntegrity(i: SpendIntegrityInput): SpendIntegrityResult {
  const reportVariancePct = absPct(i.reportSpend, i.accountInsightsSpend)
  const campaignVariancePct = absPct(i.campaignInsightsSpend, i.accountInsightsSpend)
  // "Comparable" only if at least one cross-source figure actually exists. If both are absent we have
  // NOTHING to compare — that is `unknown`, NOT `aligned`. (Calling it aligned both lies to the user and
  // feeds a fabricated 0% variance into the Trust Engine as if the numbers had been corroborated.)
  const comparable = reportVariancePct != null || campaignVariancePct != null
  const worst = Math.max(reportVariancePct ?? 0, campaignVariancePct ?? 0)
  const status: IntegrityStatus = i.accountInsightsSpend < EPS || !comparable ? 'unknown' : integrityStatus(worst)

  let note: string
  if (i.accountInsightsSpend < EPS) {
    note = 'No account-level spend tracked in this window — nothing to reconcile yet.'
  } else if (!comparable) {
    note = `Account spend ${formatMoney(i.accountInsightsSpend, { maximumFractionDigits: 0 })} is tracked, but neither the rolled-up report nor campaign-level rows are synced for this window — there is nothing to cross-check it against yet. Treat as UNVERIFIED, not "consistent".`
  } else if (status === 'aligned') {
    // Name only the sources that were actually compared: a window with no stored report agrees on two.
    const compared = [reportVariancePct != null && 'the rolled-up report', campaignVariancePct != null && 'campaign-level rows'].filter(Boolean)
    note = `Account insights and ${compared.join(' and ')} agree — spend is internally consistent.`
  } else if (status === 'minor_drift') {
    note = `A small ${worst.toFixed(1)}% gap between sources — usually a partial-day or rounding difference; re-sync to close it.`
  } else {
    note = `Sources disagree by ${worst.toFixed(1)}% — likely a missing sync day or a level that didn't fully sync. Treat windowed spend as approximate until re-synced.`
  }
  return {
    windowSpend: i.accountInsightsSpend,
    reportSpend: i.reportSpend,
    campaignSpend: i.campaignInsightsSpend,
    reportVariancePct,
    campaignVariancePct,
    worstVariancePct: worst,
    status,
    note,
  }
}

// ── 2. PLANE CONFLICT: Meta's modelled estimate vs GA confirmation-event telemetry ───────────────
//
// This once claimed to reconcile business money and took GA eventValue as revenue. NEITHER side is
// money. Meta's figure is modelled attribution; GA's is the value the SCHEDULER DISPLAYED on events
// with no appointment identity (so a comp reports its nominal price and a double-fired confirmation
// counts twice). A disagreement here is a signal to investigate two estimates, never a statement
// about business revenue — that lives only in the outcome ledger.
export type PlaneConflictDirection = 'meta_over' | 'meta_under' | 'aligned' | 'unknown'

export interface PlaneConflictInput {
  metaEstimatedValue: number | null // Meta appointment/action value (a PAID estimate — Meta only tracks ad-driven conversions)
  ga4PaidEventValue: number | null // GA PAID-channel event VALUE — telemetry, not revenue
  metaBookings: number | null
  ga4Purchases: number | null // GA PAID-channel confirmation EVENTS — not purchases, not bookings
  attributionCoverage: number | null // share of GA confirmation EVENTS tied to a named campaign (0..1)
  ga4OrganicEventValue?: number | null // GA organic event value, context only (NOT part of the comparison)
}

export interface PlaneConflictResult {
  metaEstimatedValue: number | null
  ga4PaidEventValue: number | null
  variancePct: number | null // signed; +ve ⇒ Meta counted MORE than GA4 in this window
  direction: PlaneConflictDirection
  bookingsVariancePct: number | null
  attributionCoverage: number | null
  ga4OrganicEventValue: number | null // context only — the non-paid telemetry we deliberately exclude
  available: boolean // false when GA telemetry is missing — we won't pretend to reconcile
  note: string
}

// Compares LIKE WITH LIKE: Meta's paid modelled estimate against GA's PAID-channel telemetry. Both are
// estimates of the same ad-driven subset. Organic is carried only as context, never folded in.
export function reconcilePlaneConflict(i: PlaneConflictInput): PlaneConflictResult {
  // ZERO is an answer, NOT an absence: a window whose paid confirmation events all carried $0 has
  // ga4PaidEventValue = 0 — an observed telemetry value, distinct from null (GA unavailable).
  const available = i.ga4PaidEventValue != null
  const comparable = i.ga4PaidEventValue != null && i.ga4PaidEventValue > EPS
  const variancePct = comparable ? signedPct(i.metaEstimatedValue, i.ga4PaidEventValue) : null
  const bookingsVariancePct = i.ga4Purchases != null && i.ga4Purchases > EPS ? signedPct(i.metaBookings, i.ga4Purchases) : null

  let direction: PlaneConflictDirection = 'unknown'
  if (variancePct != null) {
    if (Math.abs(variancePct) <= 5) direction = 'aligned'
    else direction = variancePct > 0 ? 'meta_over' : 'meta_under'
  }

  let note: string
  if (!available) {
    note = 'GA paid-channel event value is unavailable for this window, so the two planes cannot be compared. NEITHER is business truth: the outcome ledger is. The Meta figure is a modelled estimate.'
  } else if (!comparable) {
    note = 'GA paid-channel event value is zero for this window (e.g. every confirmation carried no value) — a variance % is undefined against zero. This says nothing about business revenue, which comes from the outcome ledger.'
  } else if (direction === 'aligned') {
    note = `Meta's modelled estimate and GA telemetry agree within ${Math.abs(variancePct!).toFixed(1)}%. Two estimates agreeing is a weak positive signal, NOT a verified money figure — neither plane has appointment identity.`
  } else if (direction === 'meta_over') {
    note = `Meta's modelled conversion value is ${variancePct!.toFixed(0)}% ABOVE GA paid-channel event value in this window. De-duplication and view-through attribution are possible explanations; neither is confirmed here. Investigate the telemetry gap; neither plane is business money. A paid figure needs the complete exact appointment-id join.`
  } else {
    note = `Meta's modelled conversion value is ${Math.abs(variancePct!).toFixed(0)}% BELOW GA paid-channel event value in this window. A delivery gap or channel-classification difference are possible explanations; neither is confirmed here. Investigate the telemetry gap; neither plane is business money. A paid figure needs the complete exact appointment-id join.`
  }
  return {
    metaEstimatedValue: i.metaEstimatedValue,
    ga4PaidEventValue: i.ga4PaidEventValue,
    variancePct,
    direction,
    bookingsVariancePct,
    attributionCoverage: i.attributionCoverage,
    ga4OrganicEventValue: i.ga4OrganicEventValue ?? null,
    available,
    note,
  }
}

// ── 3. Billed context (lifetime) ─────────────────────────────────────────────────────────────────
export interface BilledContextInput {
  lifetimeBilled: number | null // ad_accounts.amount_spent (Meta lifetime, all history)
  lifetimeTracked: number | null // Σ ALL daily_insights (account level), all dates we hold
  spendCap: number | null
}

export interface BilledContextResult {
  lifetimeBilled: number | null
  lifetimeTracked: number | null
  coveragePct: number | null // tracked ÷ billed (how much of lifetime billing we have insight rows for)
  spendCap: number | null
  note: string
}

export function reconcileBilledContext(i: BilledContextInput): BilledContextResult {
  const coveragePct =
    i.lifetimeBilled != null && i.lifetimeBilled > EPS && i.lifetimeTracked != null
      ? Math.min(100, (i.lifetimeTracked / i.lifetimeBilled) * 100)
      : null
  let note: string
  if (i.lifetimeBilled == null) {
    note = 'Meta lifetime billed (amount_spent) not synced yet.'
  } else if (coveragePct == null) {
    note = `Meta has billed ${formatMoney(i.lifetimeBilled, { maximumFractionDigits: 0 })} lifetime; tracked-insight coverage is unknown.`
  } else {
    note = `We hold daily-insight rows for ${coveragePct.toFixed(0)}% of Meta's ${formatMoney(i.lifetimeBilled, { maximumFractionDigits: 0 })} lifetime billing. The rest predates our rolling sync window — this is a coverage gauge, not a discrepancy.`
  }
  return { lifetimeBilled: i.lifetimeBilled, lifetimeTracked: i.lifetimeTracked, coveragePct, spendCap: i.spendCap, note }
}

/** The single variance the Trust Engine should score the reconciliation on: the worst disagreement
 *  across the integrity check and the money-truth check (billed coverage is context, not a variance).
 *  Returns null when NOTHING could actually be compared — so the Trust Engine marks cross-source
 *  agreement as N/A rather than treating an un-run comparison as perfect (0%) agreement. */
export function reconciliationVariancePct(integrity: SpendIntegrityResult, money: PlaneConflictResult): number | null {
  const integrityComparable = integrity.status !== 'unknown'
  const moneyComparable = money.available && money.variancePct != null
  if (!integrityComparable && !moneyComparable) return null
  const integrityV = integrityComparable ? integrity.worstVariancePct : 0
  const moneyV = moneyComparable ? Math.abs(money.variancePct as number) : 0
  return Math.max(integrityV, moneyV)
}
