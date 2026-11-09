// A single, reusable provenance vocabulary for every revenue/ROAS/MER figure, so a number is never
// shown (to a human OR an LLM) without saying WHAT it is. Derives from data the call site already has —
// the metric's sourceOfTruth, its attribution coverage, and its granularity — so labels can't drift.

import { MIN_ATTRIBUTED_SHARE, type SourceOfTruth } from '@/lib/targets/target-ranges'

export type Provenance = 'actual' | 'estimated' | 'blended' | 'attribution_limited' | 'unknown'
export type Granularity = 'account' | 'campaign' | 'adset' | 'ad' | null

export interface ProvenanceLabel {
  provenance: Provenance
  granularity: Granularity
  /** Compact chip text, e.g. "ledger booked value", "Meta est.", "GA telemetry". */
  short: string
  /** Tooltip / one-line explanation. */
  long: string
  /** Mirrors the SourceBadge tones so visuals don't diverge. */
  tone: 'success' | 'neutral' | 'warning'
}

/** "account-level" / "campaign-level" / "" — the granularity half of the seven-label vocabulary. */
export function granularityLabel(g: Granularity): string {
  return g ? `${g}-level` : ''
}

/** Resolve a provenance label. Precedence: blended (MER) → attribution-limited → source-of-truth. */
export function metricProvenance(
  source: SourceOfTruth | undefined,
  opts: { attributionCoverage?: number | null; granularity?: Granularity; blended?: boolean } = {},
): ProvenanceLabel {
  const granularity = opts.granularity ?? null
  const cov = opts.attributionCoverage

  if (opts.blended) {
    return {
      provenance: 'blended', granularity,
      short: 'blended (incl. organic)',
      long: 'Blended account figure: recorded collected value checkout revenue from ALL sources ÷ ad spend. Includes organic — NOT a paid campaign ROAS.',
      tone: 'warning',
    }
  }
  if (cov != null && cov < MIN_ATTRIBUTED_SHARE) {
    const pct = Math.round(cov * 100)
    return {
      provenance: 'attribution_limited', granularity,
      short: `attribution-limited (${pct}%)`,
      long: `Attribution coverage ${pct}% is below ${MIN_ATTRIBUTED_SHARE * 100}% — treat as an estimate, not a confident actual.`,
      tone: 'warning',
    }
  }
  // This used to receive `ga4_actual` and return "ledger booked value · actual · success" —
  // relabelling the evidence instead of describing it. Each source now maps to ITSELF. No branch may
  // translate one source into another; if a caller passes GA telemetry, the label says GA telemetry.
  switch (source) {
    case 'outcome_business_total':
      return { provenance: 'actual', granularity, short: 'Outcome ledger', long: 'Outcome ledger business total — canonical booking counts, scheduled booked value, and amount_paid checkout revenue across ALL sources (paid, organic, phone, manual).', tone: 'success' }
    case 'exact_paid_appointment_join':
      return { provenance: 'actual', granularity, short: 'exact paid join', long: 'A ledger appointment joined to a paid GA session by EXACT appointment id, over a window with complete identity coverage. The only GA-derived source that may back a paid money figure.', tone: 'success' }
    case 'ga4_confirmation_telemetry':
      return { provenance: 'estimated', granularity, short: 'GA telemetry', long: 'GA confirmation-event telemetry: event counts and GA event VALUE with no appointment identity. May double-count one booking, include canceled appointments, and carry a comp at its NOMINAL price. NOT bookings, NOT revenue, and NOT a basis for CPA, ROAS or MER.', tone: 'warning' }
    case 'meta_modelled':
      return { provenance: 'estimated', granularity, short: 'Meta est.', long: 'Meta modelled attribution (7-day click / 1-day view). Can UNDER- or OVER-attribute relative to business truth; direction is not fixed.', tone: 'neutral' }
    case 'computed':
      return { provenance: 'blended', granularity, short: 'computed', long: 'Computed/derived value.', tone: 'neutral' }
    default:
      return { provenance: 'unknown', granularity, short: 'unknown source', long: 'Provenance unknown — do not treat as confirmed.', tone: 'warning' }
  }
}

/** Compact one-liner combining provenance + granularity, e.g. "ledger booked value · campaign-level". */
export function provenanceSummary(label: ProvenanceLabel): string {
  const g = granularityLabel(label.granularity)
  return g ? `${label.short} · ${g}` : label.short
}
