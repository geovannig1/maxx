import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { SPEND_FLOORS } from '@/config/spend-floors'
// Central, configurable TARGET RANGES for every performance metric — the single source of truth that
// replaces scattered hard-coded single-value targets (CPA=60, MAX=100, etc.). Nothing judges a metric
// against one absolute number any more: a value is classified into a BAND (excellent / healthy / watch
// / critical), but only once minimum-data gates pass — otherwise it's `needs_data`; and revenue/ROAS
// metrics that depend on attribution become `estimate_only` when coverage is low. Every band here is
// PROVISIONAL and configurable (see docs/configuration.md + 05) — not final truth.

export type MetricKey =
  | 'cpa' // cost per booking (AppointmentConfirmed)
  | 'cpl' // cost per lead
  | 'roas' // per-entity return on ad spend (estimate-bound until attribution is real)
  | 'mer' // blended marketing efficiency ratio (account, recorded collected value ÷ ad spend)
  | 'ctr'
  | 'cpc'
  | 'cpm'
  | 'frequency'
  | 'conversion_rate'

export type MetricStatus = 'excellent' | 'healthy' | 'watch' | 'critical' | 'needs_data' | 'estimate_only' | 'no_target' | 'unknown'

export type Direction = 'lower_is_better' | 'higher_is_better'

export type SourceOfTruth = 'outcome_business_total' | 'exact_paid_appointment_join' | 'ga4_confirmation_telemetry' | 'meta_modelled' | 'computed'

export interface MetricRange {
  metric: MetricKey
  label: string
  unit: '$' | '%' | 'x' | '' // display unit
  direction: Direction
  // Band boundaries. lower_is_better: value ≤ excellent → excellent, ≤ healthy → healthy, ≤ watch → watch, else critical.
  // higher_is_better: value ≥ excellent → excellent, ≥ healthy → healthy, ≥ watch → watch, else critical.
  // null on a money metric (MONEY_METRICS) until the owner sets a target: there is no neutral amount.
  // A money target needs healthy (the target) and watch (the maximum); excellent is optional there.
  excellent: number | null
  healthy: number | null
  watch: number | null
  // Minimum data before a band verdict is allowed (else `needs_data`).
  minSpend: number
  minClicks: number
  minBookings: number
  minDays: number
  // Revenue/efficiency metrics whose truth depends on GA4 attribution coverage.
  estimateBound: boolean
  sourceOfTruth: SourceOfTruth
  provisional: boolean
}

// Attribution coverage below this ⇒ per-entity revenue/ROAS is estimate_only / low-confidence.
export const MIN_ATTRIBUTED_SHARE = 0.5

/** Metrics whose bands are amounts of money in the account currency. No amount is a sensible default for
 *  every business and currency, so they have NO built-in target: each is judged only once the owner sets
 *  one in Settings → Performance Targets. Until then their status is `no_target`. */
export const MONEY_METRICS = ['cpa', 'cpl', 'cpc', 'cpm'] as const
export type MoneyMetricKey = (typeof MONEY_METRICS)[number]

/** A range with a target: healthy (the target) and watch (the maximum) set; excellent may be unset. */
export type SetMetricRange = MetricRange & { healthy: number; watch: number }
/** A non-money range: every band edge is set. */
export type FullMetricRange = MetricRange & { excellent: number; healthy: number; watch: number }

export function hasTarget(range: MetricRange): range is SetMetricRange {
  return range.healthy !== null && range.watch !== null
}

// ── Default ranges (configurable in Settings → Performance Targets) ─────────────────────────────────
// Money metrics (CPA, CPL, CPC, CPM) have no default target: their bands are null until the owner sets
// them. The ratio, rate and frequency bands are currency-neutral PROVISIONAL references. The minimum-spend
// gates are amounts in the account currency, fixed multiples of NEXT_PUBLIC_MIN_SPEND_TO_JUDGE.
export const METRIC_RANGES: Record<MetricKey, MetricRange> = {
  cpa: {
    metric: 'cpa', label: 'Cost / Booking', unit: '$', direction: 'lower_is_better',
    excellent: null, healthy: null, watch: null, // owner-set: healthy = target, watch = maximum acceptable
    get minSpend() { return SPEND_FLOORS.costPerOutcomeGate }, minClicks: 0, minBookings: 2, minDays: 3,
    estimateBound: true, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  cpl: {
    metric: 'cpl', label: 'Cost / Lead', unit: '$', direction: 'lower_is_better',
    excellent: null, healthy: null, watch: null, // owner-set
    get minSpend() { return SPEND_FLOORS.judge }, minClicks: 0, minBookings: 0, minDays: 3,
    estimateBound: false, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  roas: {
    metric: 'roas', label: 'ROAS', unit: 'x', direction: 'higher_is_better',
    excellent: 3, healthy: 2, watch: 1, // ≥3 excellent · ≥2 healthy · ≥1 watch · <1 critical
    get minSpend() { return SPEND_FLOORS.costPerOutcomeGate }, minClicks: 0, minBookings: 2, minDays: 3,
    // Provenance belongs to a specific OBSERVATION, not permanently to the metric
    // definition. A ROAS built from an exact appointment-id join and one built from telemetry are the
    // same METRIC with different evidence. This field is the DEFAULT when a caller supplies none;
    // metricProvenance() takes an explicit source and that always wins.
    estimateBound: true, sourceOfTruth: 'exact_paid_appointment_join', provisional: true,
  },
  mer: {
    metric: 'mer', label: 'MER (blended)', unit: 'x', direction: 'higher_is_better',
    excellent: 4, healthy: 2.5, watch: 1.5,
    get minSpend() { return SPEND_FLOORS.costPerOutcomeGate }, minClicks: 0, minBookings: 0, minDays: 3,
    // MER is based on outcome-source checkout revenue (amount_paid / spend), never GA-derived.
    estimateBound: false, sourceOfTruth: 'outcome_business_total', provisional: true,
  },
  ctr: {
    metric: 'ctr', label: 'CTR', unit: '%', direction: 'higher_is_better',
    excellent: 2, healthy: 1, watch: 0.5, // <0.5% critical (matches old MIN_CTR_THRESHOLD)
    minSpend: 0, minClicks: 0, minBookings: 0, minDays: 0, // CTR is impression-gated below
    estimateBound: false, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  cpc: {
    metric: 'cpc', label: 'CPC', unit: '$', direction: 'lower_is_better',
    excellent: null, healthy: null, watch: null, // owner-set
    get minSpend() { return SPEND_FLOORS.judge }, minClicks: 50, minBookings: 0, minDays: 3,
    estimateBound: false, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  cpm: {
    metric: 'cpm', label: 'CPM', unit: '$', direction: 'lower_is_better',
    excellent: null, healthy: null, watch: null, // owner-set
    get minSpend() { return SPEND_FLOORS.judge }, minClicks: 0, minBookings: 0, minDays: 3,
    estimateBound: false, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  frequency: {
    metric: 'frequency', label: 'Frequency', unit: '', direction: 'lower_is_better',
    excellent: 1.5, healthy: 2.5, watch: 3.5, // >3.5 critical (matches old FREQ_CRITICAL)
    minSpend: 0, minClicks: 0, minBookings: 0, minDays: 3,
    estimateBound: false, sourceOfTruth: 'meta_modelled', provisional: true,
  },
  conversion_rate: {
    metric: 'conversion_rate', label: 'Conversion Rate', unit: '%', direction: 'higher_is_better',
    excellent: 5, healthy: 2, watch: 1, // provisional — uncertain
    get minSpend() { return SPEND_FLOORS.judge }, minClicks: 100, minBookings: 0, minDays: 3,
    estimateBound: false, sourceOfTruth: 'computed', provisional: true,
  },
}

export interface EvalContext {
  spend?: number
  clicks?: number
  impressions?: number
  bookings?: number
  windowDays?: number
  /** GA4 share of bookings tied to a named campaign (0..1). null = unknown. */
  attributionCoverage?: number | null
  /** Account is dormant / pre-launch — never emit a performance verdict. */
  dormant?: boolean
}

export interface MetricEvaluation {
  metric: MetricKey
  value: number | null
  status: MetricStatus
  band: MetricStatus | null // the raw band if data were sufficient (excellent/healthy/watch/critical)
  confidence: 'high' | 'medium' | 'low'
  range: MetricRange
  reason: string
  /** OPTIONAL vertical-benchmark CONTEXT (owner-approved on /signals, cited, labeled external_heuristic).
   *  Attached only by consumers via annotateWithBenchmarks — getMetricStatus never sets it and the
   *  band/status NEVER changes because of it. Account targets always win. */
  benchmark?: { range: string; label: 'external_heuristic'; source: string }
}

// ── Editable overrides (Performance-Targets editor) ─────────────────────────────────────────────
// METRIC_RANGES above are the DEFAULTS. The ACTIVE set may be overridden per-metric (band thresholds +
// min-data gates) and persisted to app_settings. Everything that judges a metric reads the ACTIVE set
// via getTargetRange / _active, so an edit re-bands the whole app without changing any call sites.
export type EditableRangeField = 'excellent' | 'healthy' | 'watch' | 'minSpend' | 'minClicks' | 'minBookings' | 'minDays'
export const EDITABLE_RANGE_FIELDS: EditableRangeField[] = ['excellent', 'healthy', 'watch', 'minSpend', 'minClicks', 'minBookings', 'minDays']
export type TargetOverrides = Partial<Record<MetricKey, Partial<Record<EditableRangeField, number>>>>

/** Defaults + per-metric overrides → a complete, effective range set. null/empty → the defaults. */
export function mergeRanges(overrides: TargetOverrides | null | undefined): Record<MetricKey, MetricRange> {
  if (!overrides) return METRIC_RANGES
  const merged = {} as Record<MetricKey, MetricRange>
  for (const key of Object.keys(METRIC_RANGES) as MetricKey[]) {
    merged[key] = { ...METRIC_RANGES[key], ...(overrides[key] ?? {}) }
  }
  return merged
}

/** Validate that an effective range set has sane band ordering. For lower_is_better metrics the
 *  band edges must be non-decreasing (excellent ≤ healthy ≤ watch); for higher_is_better, non-increasing
 *  (excellent ≥ healthy ≥ watch). Inverted edges silently corrupt banding (a bad value reads as good),
 *  so the targets editor must reject them rather than save them. Returns the list of offending metrics. */
export function validateRangeOrdering(ranges: Record<MetricKey, MetricRange>): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  for (const key of Object.keys(ranges) as MetricKey[]) {
    const r = ranges[key]
    if (r.excellent === null && r.healthy === null && r.watch === null) continue // no target set
    if (!hasTarget(r)) {
      errors.push(`${r.label} (${key}): set both the healthy (target) and watch (maximum) edges, or none.`)
      continue
    }
    const excellent = r.excellent ?? r.healthy // no excellent edge: nothing to order against
    const ordered =
      r.direction === 'lower_is_better'
        ? excellent <= r.healthy && r.healthy <= r.watch
        : excellent >= r.healthy && r.healthy >= r.watch
    if (!ordered) {
      const rule = r.direction === 'lower_is_better' ? 'excellent ≤ healthy ≤ watch' : 'excellent ≥ healthy ≥ watch'
      errors.push(`${r.label} (${key}): bands must satisfy ${rule} — got excellent ${r.excellent}, healthy ${r.healthy}, watch ${r.watch}.`)
    }
  }
  return { ok: errors.length === 0, errors }
}

let _active: Record<MetricKey, MetricRange> = METRIC_RANGES

/** Replace the ACTIVE ranges with defaults + overrides. Called server-side per request and client-side
 *  by the TargetRangesProvider / editor. Passing null/empty resets to defaults. */
export function applyTargetOverrides(overrides: TargetOverrides | null | undefined): void {
  _active = mergeRanges(overrides)
}

export function getActiveRanges(): Record<MetricKey, MetricRange> {
  return _active
}

/** The ACTIVE range. A money metric's bands may be null (no target set); every other metric's are set. */
export function getTargetRange<M extends MetricKey>(metric: M): M extends MoneyMetricKey ? MetricRange : FullMetricRange {
  return _active[metric] as M extends MoneyMetricKey ? MetricRange : FullMetricRange
}

/** The owner's CPA target (healthy edge) and maximum acceptable CPA (watch edge), or null when unset. */
export function cpaTarget(): { target: number; max: number } | null {
  const range = _active.cpa
  return hasTarget(range) ? { target: range.healthy, max: range.watch } : null
}

/** Whether there's enough data to emit a band verdict for this metric. */
export function shouldEvaluateMetric(metric: MetricKey, ctx: EvalContext): boolean {
  if (ctx.dormant) return false
  const r = _active[metric]
  if (r.minSpend && (ctx.spend ?? 0) < r.minSpend) return false
  if (r.minClicks && (ctx.clicks ?? 0) < r.minClicks) return false
  if (r.minBookings && (ctx.bookings ?? 0) < r.minBookings) return false
  if (r.minDays && (ctx.windowDays ?? 0) < r.minDays) return false
  // CTR needs impressions to be meaningful.
  if (metric === 'ctr' && (ctx.impressions ?? 0) < 500) return false
  return true
}

function classifyBand(value: number, r: SetMetricRange): Exclude<MetricStatus, 'needs_data' | 'estimate_only' | 'no_target' | 'unknown'> {
  if (r.direction === 'lower_is_better') {
    if (r.excellent !== null && value <= r.excellent) return 'excellent'
    if (value <= r.healthy) return 'healthy'
    if (value <= r.watch) return 'watch'
    return 'critical'
  }
  if (r.excellent !== null && value >= r.excellent) return 'excellent'
  if (value >= r.healthy) return 'healthy'
  if (value >= r.watch) return 'watch'
  return 'critical'
}

/** Confidence given attribution coverage, sample size, and data maturity. */
export function getConfidenceAdjustment(ctx: EvalContext): 'high' | 'medium' | 'low' {
  if (ctx.dormant) return 'low'
  const bookings = ctx.bookings ?? 0
  const attr = ctx.attributionCoverage
  let score = 0
  if (bookings >= 5) score += 2
  else if (bookings >= 2) score += 1
  if ((ctx.spend ?? 0) >= SPEND_FLOORS.confidentSample) score += 1
  if ((ctx.windowDays ?? 0) >= 7) score += 1
  if (attr !== null && attr !== undefined && attr >= MIN_ATTRIBUTED_SHARE) score += 1
  else if (attr !== null && attr !== undefined && attr < MIN_ATTRIBUTED_SHARE) score -= 1
  if (score >= 4) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

/** The main evaluator. Never returns a confident band unless data gates pass; revenue/ROAS metrics
 *  become estimate_only when attribution coverage is low. */
export function getMetricStatus(metric: MetricKey, value: number | null, ctx: EvalContext = {}): MetricEvaluation {
  const range = _active[metric]
  const confidence = getConfidenceAdjustment(ctx)

  if (value === null || value === undefined || !isFinite(value)) {
    return { metric, value, status: 'unknown', band: null, confidence: 'low', range, reason: 'No value available.' }
  }
  if (!hasTarget(range)) {
    return { metric, value, status: 'no_target', band: null, confidence: 'low', range, reason: `No ${range.label} target is set. Set one in Settings → Performance Targets to judge it.` }
  }
  if (!shouldEvaluateMetric(metric, ctx)) {
    const need: string[] = []
    if (range.minSpend && (ctx.spend ?? 0) < range.minSpend) need.push(`≥ ${formatMoneyAmount(range.minSpend)} spend`)
    if (range.minBookings && (ctx.bookings ?? 0) < range.minBookings) need.push(`≥ ${range.minBookings} bookings`)
    if (range.minDays && (ctx.windowDays ?? 0) < range.minDays) need.push(`≥ ${range.minDays} days`)
    if (metric === 'ctr' && (ctx.impressions ?? 0) < 500) need.push('≥ 500 impressions')
    const why = ctx.dormant ? 'account is dormant / pre-launch' : need.length ? `needs ${need.join(', ')}` : 'below the evaluation threshold'
    return { metric, value, status: 'needs_data', band: classifyBand(value, range), confidence: 'low', range, reason: `Not enough data to judge ${range.label} (${why}).` }
  }

  const band = classifyBand(value, range)

  // Estimate-bound revenue/ROAS with low attribution → estimate_only (don't assert per-entity truth).
  // This was keyed on sourceOfTruth === GA telemetry, which broke when ROAS was correctly
  // relabelled to the exact join. The property that matters is whether the metric's evidence DEPENDS
  // ON ATTRIBUTION — GA telemetry and the exact appointment join both do; a Meta modelled CPA and a
  // ledger-derived MER do not. Keying on `estimateBound` alone would have swept CPA in and changed
  // verdicts that have nothing to do with attribution coverage.
  const ATTRIBUTION_DEPENDENT = new Set(['ga4_confirmation_telemetry', 'exact_paid_appointment_join'])
  if (range.estimateBound && ATTRIBUTION_DEPENDENT.has(range.sourceOfTruth)) {
    const attr = ctx.attributionCoverage
    if (attr === null || attr === undefined || attr < MIN_ATTRIBUTED_SHARE) {
      return { metric, value, status: 'estimate_only', band, confidence: 'low', range, reason: `${range.label} is estimate-only — attribution coverage ${attr == null ? 'unknown' : (attr * 100).toFixed(0) + '%'} is below ${(MIN_ATTRIBUTED_SHARE * 100).toFixed(0)}%.` }
    }
  }

  return { metric, value, status: band, band, confidence, range, reason: bandReason(metric, value, band, range) }
}

function fmt(value: number, r: MetricRange): string {
  if (r.unit === '$') return `${formatMoney(value)}`
  if (r.unit === '%') return `${value.toFixed(2)}%`
  if (r.unit === 'x') return `${value.toFixed(2)}x`
  return value.toFixed(2)
}

function bandReason(metric: MetricKey, value: number, band: MetricStatus, r: MetricRange): string {
  const v = fmt(value, r)
  switch (band) {
    case 'excellent': return `${r.label} ${v} is in the excellent range.`
    case 'healthy': return `${r.label} ${v} is in the healthy range.`
    case 'watch': return `${r.label} ${v} is in the watch range — not a failure, keep monitoring.`
    case 'critical': return `${r.label} ${v} is in the critical range.`
    default: return `${r.label} ${v}.`
  }
}

/** Human-readable, range-aware language for reports/recommendations. */
export function getTargetLanguage(metric: MetricKey, evalResult: MetricEvaluation): string {
  const r = evalResult.range
  const governance = r.provisional
    ? 'PROVISIONAL diagnostic reference — not an owner-governed business target. '
    : ''
  if (evalResult.status === 'no_target') return evalResult.reason
  if (evalResult.status === 'needs_data') return `${governance}${evalResult.reason}`
  if (evalResult.status === 'unknown') return `${governance}${r.label} is unavailable.`
  if (evalResult.status === 'estimate_only') return `${governance}${evalResult.reason}`
  if (!hasTarget(r)) return `${r.label} has no target set.`
  const bandText =
    r.direction === 'lower_is_better'
      ? `(${r.excellent === null ? '' : `excellent ≤ ${fmt(r.excellent, r)}, `}healthy ≤ ${fmt(r.healthy, r)}, watch ≤ ${fmt(r.watch, r)}, critical above)`
      : `(${r.excellent === null ? '' : `excellent ≥ ${fmt(r.excellent, r)}, `}healthy ≥ ${fmt(r.healthy, r)}, watch ≥ ${fmt(r.watch, r)}, critical below)`
  return `${governance}${evalResult.reason} ${bandText} · confidence ${evalResult.confidence}.`
}
