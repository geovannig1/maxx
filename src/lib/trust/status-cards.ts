import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { TrustScore } from '@/lib/trust/trust'
import type { UtmCoverageStats } from '@/lib/tracking/utm-validator'
import type { SpendIntegrityResult, PlaneConflictResult } from '@/lib/diagnostics/reconcile'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Plain-English status cards — the four "can I trust today's numbers?" tiles that the redesigned
// dashboard AND the diagnostics page both render from the SAME computation, so the two surfaces can
// never tell different stories about the same account. Every judgment reuses an existing constant
// (REC_THRESHOLDS.MIN_ATTRIBUTED_SHARE / MAX_DATA_AGE_HOURS, the trust levels, the 26h freshness bar);
// nothing new is thresholded here. Missing input is answered honestly ("Not measured in this view."),
// never with a fabricated verdict.

export type StatusCardKey = 'tracking' | 'attribution' | 'freshness' | 'roas_trust'
export type StatusCardStatus = 'good' | 'watch' | 'bad' | 'unknown'

export interface StatusCard {
  key: StatusCardKey
  label: string
  status: StatusCardStatus
  /** ONE plain-English sentence a non-analyst understands. */
  headline: string
  detail?: string
  href: string
}

/** Anchor ids on /diagnostics. Exported as consts so the diagnostics page (Wave 4) places the SAME
 *  ids these cards link to. */
export const DIAGNOSTICS_ANCHORS = {
  decisionGate: 'decision-gate',
  reconciliation: 'reconciliation',
  attribution: 'attribution',
  anomalies: 'anomalies',
} as const
export type DiagnosticsAnchor = (typeof DIAGNOSTICS_ANCHORS)[keyof typeof DIAGNOSTICS_ANCHORS]

const DIAGNOSTICS_PATH = '/diagnostics'

/** `/diagnostics#<anchor>`, or the page top (trust) when no anchor is given. */
function anchorHref(anchor?: DiagnosticsAnchor): string {
  return anchor ? `${DIAGNOSTICS_PATH}#${anchor}` : DIAGNOSTICS_PATH
}

/** ALL fields optional so the dashboard and diagnostics can each call with whatever it has computed. */
export interface StatusCardsInput {
  ga4Available?: boolean
  /** Coverage stats over active ads (from computeCoverageStats), or null when there's nothing to judge. */
  utm?: UtmCoverageStats | null
  /** GA share of confirmation events tied to a named campaign (0..1). null = unknown. */
  attributedShare?: number | null
  /** Hours since the last successful sync. null = no successful sync on record; undefined = not checked. */
  dataAgeHours?: number | null
  latestSyncFailed?: boolean
  integrityStatus?: SpendIntegrityResult['status']
  trust?: TrustScore | null
  moneyDirection?: PlaneConflictResult['direction']
  /** What the supplied trust score is allowed to describe. A trust score never upgrades telemetry
   *  into a paid outcome; the caller must name the evidence contract explicitly. */
  outcomeBasis?: 'business_total' | 'exact_paid' | 'telemetry_only'
}

const NOT_MEASURED = 'Not measured in this view.'
const { MIN_ATTRIBUTED_SHARE, MAX_DATA_AGE_HOURS } = REC_THRESHOLDS
const ATTR_FLOOR_PCT = Math.round(MIN_ATTRIBUTED_SHARE * 100)

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

// ── Tracking: is GA4 reporting and are ads carrying UTM tracking at all? ──────────────────────────
function trackingCard(i: StatusCardsInput): StatusCard {
  const base = { key: 'tracking' as const, label: 'Tracking', href: anchorHref(DIAGNOSTICS_ANCHORS.attribution) }
  const ga4 = i.ga4Available
  // "present" = at least one ad carries some url_tags (correct or misconfigured); false = every ad is
  // missing tags; null = no ads / not checked.
  const present = i.utm && i.utm.adsTotal > 0 ? i.utm.adsMissing < i.utm.adsTotal : null

  if (ga4 === undefined && i.utm == null) {
    return { ...base, status: 'unknown', headline: NOT_MEASURED }
  }
  if (ga4 === false) {
    return { ...base, status: 'watch', headline: 'GA4 confirmation-event telemetry is unavailable. Outcome business totals are unaffected; session-channel diagnostics are offline.' }
  }
  if (ga4 === true) {
    if (present === false) {
      return {
        ...base,
        status: 'watch',
        headline: 'GA4 confirmation telemetry is reporting, but observed ads carry no readable UTM fields. This is a diagnostic gap, not a paid-tracking contract.',
      }
    }
    // Healthy when the evidence is COMPLETE: GA4 reporting and every observed ad carrying the readable
    // UTM set. It is still telemetry health, so the paid-contract limit travels in the detail.
    if (i.utm && i.utm.adsTotal > 0 && i.utm.coverage !== null && i.utm.coverage >= 1) {
      return {
        ...base,
        status: 'good',
        headline: 'Tracking is healthy: GA confirmation telemetry is reporting and every observed ad carries readable UTM fields.',
        detail: 'This is telemetry health. A paid-tracking contract still needs a stored, approved CampaignPlan; readable coverage alone never unlocks paid ROAS.',
      }
    }
    return {
      ...base,
      status: 'watch',
      headline: 'GA confirmation telemetry is reporting. A paid-tracking contract remains unavailable until a CampaignPlan is stored and approved.',
      detail: present === true
        ? 'Observed ads carry readable UTM fields; that coverage is diagnostic only and never unlocks paid ROAS.'
        : undefined,
    }
  }
  // GA4 not checked here — judge on UTM presence alone, and stay honest that GA4 wasn't confirmed.
  if (present === false) {
    return { ...base, status: 'watch', headline: 'Observed ads carry no readable UTM fields. This is a diagnostic gap, not a paid-tracking contract.' }
  }
  if (present === true) {
    return { ...base, status: 'watch', headline: 'Observed ads carry readable UTM fields, but GA4 reporting wasn’t checked. Readable coverage alone never unlocks paid ROAS.' }
  }
  return { ...base, status: 'unknown', headline: NOT_MEASURED }
}

// ── Attribution COVERAGE (a telemetry statistic). Share alone NEVER makes per-campaign ROAS valid:
// that additionally needs exact appointment identity, complete campaign mapping and authoritative
// campaign spend (see operating-mode.ts). This card reports coverage, it does not grant authority. ──
function attributionCard(i: StatusCardsInput): StatusCard {
  const base = { key: 'attribution' as const, label: 'Attribution', href: anchorHref(DIAGNOSTICS_ANCHORS.attribution) }
  const share = i.attributedShare
  const coverage = i.utm ? i.utm.coverage : null

  if (share != null) {
    if (share >= MIN_ATTRIBUTED_SHARE) {
      return {
        ...base,
        status: 'good',
        headline: `${pct(share)} of GA confirmation events carry a readable campaign label, meeting the ${ATTR_FLOOR_PCT}% goal.`,
        detail: 'This is diagnostic telemetry; readable coverage alone never unlocks paid ROAS.',
      }
    }
    return {
      ...base,
      status: 'bad',
      headline: `Only ${pct(share)} of GA confirmation events carry a readable campaign label (diagnostic goal ≥ ${ATTR_FLOOR_PCT}%).`,
      detail: `This is a telemetry defect. Readable coverage alone never unlocks paid ROAS; that requires a stored CampaignPlan, immutable Meta IDs, exact ${OW.one} linkage, complete coverage, and authoritative spend.`,
    }
  }
  // Attributed share unknown — lead with UTM coverage as the actionable indicator.
  if (coverage != null) {
    if (coverage >= 1) {
      return {
        ...base,
        status: 'good',
        headline: 'Every observed ad matches the readable-UTM pattern.',
        detail: 'This is diagnostic coverage only and never unlocks paid ROAS.',
      }
    }
    return {
      ...base,
      status: 'bad',
      headline: `Readable UTM coverage is ${pct(coverage)} — an observed campaign-telemetry defect.`,
      detail: `Readable coverage alone never unlocks paid ROAS; that requires a stored CampaignPlan, immutable Meta IDs, exact ${OW.one} linkage, complete coverage, and authoritative spend.`,
    }
  }
  return { ...base, status: 'unknown', headline: NOT_MEASURED }
}

// ── Freshness: is the synced data current? (26h bar + failed-sync flag) ───────────────────────────
function freshnessCard(i: StatusCardsInput): StatusCard {
  const base = { key: 'freshness' as const, label: 'Freshness', href: anchorHref(DIAGNOSTICS_ANCHORS.reconciliation) }
  const age = i.dataAgeHours
  // Spend-source disagreement is a data-currency caveat, never a status flip.
  const integrityNote =
    i.integrityStatus === 'mismatch'
      ? 'Spend sources disagree — re-sync to reconcile them.'
      : i.integrityStatus === 'minor_drift'
        ? 'A small spend-source drift — usually a partial-day gap.'
        : undefined

  if (age === undefined && i.latestSyncFailed === undefined) {
    return { ...base, status: 'unknown', headline: NOT_MEASURED }
  }
  if (i.latestSyncFailed === true) {
    return { ...base, status: 'bad', headline: 'The last sync attempt failed — the numbers may be behind. Re-sync.', detail: integrityNote }
  }
  if (age === null) {
    return { ...base, status: 'bad', headline: 'No successful sync on record — data age is unknown. Re-sync before trusting the numbers.', detail: integrityNote }
  }
  if (age !== undefined && age > MAX_DATA_AGE_HOURS) {
    return { ...base, status: 'watch', headline: `Data is ${Math.round(age)}h old (over the ${MAX_DATA_AGE_HOURS}-hour freshness bar) — re-sync before acting.`, detail: integrityNote }
  }
  if (age !== undefined) {
    const when = age < 1 ? 'less than an hour ago' : `${Math.round(age)}h ago`
    return { ...base, status: 'good', headline: `Data synced ${when}.`, detail: integrityNote }
  }
  // Only latestSyncFailed === false was supplied (age not checked) — sync ran, currency unconfirmed.
  return { ...base, status: 'watch', headline: 'The last sync succeeded, but data age wasn’t checked in this view.', detail: integrityNote }
}

// ── ROAS trust: is the paid-revenue reading safe to act on? (trust level/score) ───────────────────
function roasTrustCard(i: StatusCardsInput): StatusCard {
  const base = { key: 'roas_trust' as const, label: 'Outcome authority', href: anchorHref() }
  if (i.outcomeBasis === 'telemetry_only') {
    const conflict =
      i.moneyDirection === 'meta_over' || i.moneyDirection === 'meta_under'
        ? 'Meta modelled attribution and GA confirmation telemetry disagree; neither plane decides paid money.'
        : undefined
    return {
      ...base,
      label: 'Paid outcome authority',
      status: 'bad',
      headline: 'Paid CPA and ROAS are unavailable from telemetry alone.',
      detail: [
        `A complete exact ${OW.one}-id join plus authoritative mapped spend is required.`,
        conflict,
      ].filter(Boolean).join(' '),
    }
  }
  const trust = i.trust
  if (trust == null) {
    return { ...base, status: 'unknown', headline: NOT_MEASURED }
  }
  const score = `${trust.score}/100`

  if (i.outcomeBasis === 'business_total') {
    const detail = `${trust.headline} Supports the all-source business total and blended MER, not paid CPA or paid ROAS.`
    if (trust.level === 'verified' || trust.level === 'high') {
      return { ...base, label: 'Business totals', status: 'good', headline: `Ledger business totals are trustworthy (${score}).`, detail }
    }
    if (trust.level === 'moderate') {
      return { ...base, label: 'Business totals', status: 'watch', headline: `Ledger business totals are directional (${score}).`, detail }
    }
    return { ...base, label: 'Business totals', status: 'bad', headline: `Ledger business totals need attention (${score}).`, detail }
  }

  const detail = trust.headline || undefined

  if (trust.level === 'verified' || trust.level === 'high') {
    return { ...base, label: 'Paid outcome authority', status: 'good', headline: `Exact paid outcome reads are trustworthy (${score}).`, detail }
  }
  if (trust.level === 'moderate') {
    return { ...base, label: 'Paid outcome authority', status: 'watch', headline: `Exact paid outcome reads are directional (${score}) — owner review required.`, detail }
  }
  return { ...base, label: 'Paid outcome authority', status: 'bad', headline: `Exact paid outcome reads aren’t trustworthy yet (${score}).`, detail }
}

/** The four dashboard/diagnostics status cards, always in a stable order. */
export function computeStatusCards(input: StatusCardsInput): StatusCard[] {
  return [trackingCard(input), attributionCard(input), freshnessCard(input), roasTrustCard(input)]
}
