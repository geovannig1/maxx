// TRUTHFUL VIDEO METRICS — denominator contracts, honest naming, and no silent clamping.
//
// THE DEFECT THIS REPLACES
//   const video3sViews = videoP25            // "nearest available early-retention signal"
//   hookRate = video3sViews / impressions
//   holdRate = thruplays / video3sViews
// video_p25_watched_actions is 25% OF THE VIDEO LENGTH. On a 60-120 second creative that is roughly
// 15-30 seconds of watch time — deep engagement, reported as scroll-stopping power. And because
// ThruPlay counts a 15-second view, thruplays/p25 could legitimately exceed 100% on a long video.
//
// WHAT META ACTUALLY EXPOSES (Ads Insights field reference, v25.0, verified 2026-07-26)
//   video_play_actions                      video STARTS (Meta labels the field "in development")
//   video_continuous_2_sec_watched_actions  continuous 2-second views
//   video_p25/p50/p75/p100_watched_actions  RETENTION MILESTONES (% of video length)
//   video_thruplay_watched_actions          ThruPlay: 15s, or a full play if shorter than 15s
//   video_avg_time_watched_actions          average watch time
// There is NO three-second-view field. So there is no honest "3s hook rate" from this edge, and p25
// is never a stand-in for one.

/** Which real Meta field an early-view rate was computed from. p25 is deliberately not an option. */
export type EarlyViewSource = 'video_play_actions' | 'video_continuous_2_sec' | 'unavailable'

/** Every derived video rate declares what it divides by. Stated once, in one place, on purpose. */
export const DENOMINATOR_CONTRACTS = {
  early_view_rate: 'video starts (video_play_actions) or continuous 2s views ÷ impressions',
  retention_p25_rate: 'viewers reaching 25% of video length ÷ video starts (falls back to impressions, which is then labelled)',
  retention_p50_rate: 'viewers reaching 50% of video length ÷ video starts (falls back to impressions, which is then labelled)',
  retention_p75_rate: 'viewers reaching 75% of video length ÷ video starts (falls back to impressions, which is then labelled)',
  completion_rate: 'viewers reaching 100% of video length ÷ video starts (falls back to impressions, which is then labelled)',
  thruplay_rate: 'ThruPlays ÷ impressions',
} as const

export type VideoRateKey = keyof typeof DENOMINATOR_CONTRACTS

/** A derived rate that always carries its own provenance and reliability. */
export interface DerivedRate {
  /** Percentage 0..100, or null when the inputs do not support one. NEVER a substituted proxy. */
  value: number | null
  /** The raw ratio BEFORE any clamp, preserved even when impossible. */
  rawValue: number | null
  rawNumerator: number | null
  rawDenominator: number | null
  denominatorContract: string
  /** True when the raw relationship could not be true (e.g. above 100% for a bounded rate). */
  unreliable: boolean
  /** Populated only when unreliable — states what was impossible about the raw inputs. */
  warning: string | null
  /** Human label when there is no value at all. */
  unavailableReason: string | null
}

export interface DerivedMetricWarning {
  metric: VideoRateKey
  rawNumerator: number | null
  rawDenominator: number | null
  rawRate: number | null
  reason: string
  unreliable: true
}

function unavailable(metric: VideoRateKey, reason: string): DerivedRate {
  return {
    value: null,
    rawValue: null,
    rawNumerator: null,
    rawDenominator: null,
    denominatorContract: DENOMINATOR_CONTRACTS[metric],
    unreliable: false,
    warning: null,
    unavailableReason: reason,
  }
}

/**
 * PURE: build a bounded percentage rate.
 *
 * Clamping is NOT silent. When the raw relationship exceeds the bound, the raw inputs are preserved,
 * the rate is marked `unreliable`, and a warning states what was impossible. A caller that only reads
 * `.value` still sees a sane number; a caller that reports it is obliged to see the flag.
 */
export function boundedRate(
  metric: VideoRateKey,
  numerator: number | null,
  denominator: number | null,
  opts: { maxPercent?: number | null } = {},
): DerivedRate {
  const contract = DENOMINATOR_CONTRACTS[metric]
  if (numerator === null || denominator === null) {
    return unavailable(metric, 'inputs unavailable')
  }
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return unavailable(metric, 'inputs were not finite numbers')
  }
  if (denominator <= 0) {
    return unavailable(metric, 'denominator is zero — a rate would be undefined, not zero')
  }

  const raw = (numerator / denominator) * 100
  const max = opts.maxPercent === undefined ? 100 : opts.maxPercent

  if (numerator < 0) {
    return {
      value: null, rawValue: raw, rawNumerator: numerator, rawDenominator: denominator,
      denominatorContract: contract, unreliable: true,
      warning: `negative numerator (${numerator}) — the raw counts are inconsistent`,
      unavailableReason: 'raw inputs are inconsistent',
    }
  }

  if (max !== null && raw > max) {
    // The invalid relationship is DETECTED and LOGGED, the raw inputs are kept, and the derived
    // metric is marked unreliable. Clamping alone would hide a real data problem.
    return {
      value: max,
      rawValue: raw,
      rawNumerator: numerator,
      rawDenominator: denominator,
      denominatorContract: contract,
      unreliable: true,
      warning:
        `raw rate ${raw.toFixed(1)}% exceeds ${max}% (${numerator} ÷ ${denominator}) — impossible for this ` +
        `contract, so the value is clamped AND marked unreliable; do not report it as a measurement`,
      unavailableReason: null,
    }
  }

  return {
    value: raw, rawValue: raw, rawNumerator: numerator, rawDenominator: denominator,
    denominatorContract: contract, unreliable: false, warning: null, unavailableReason: null,
  }
}

export interface VideoInputs {
  impressions: number | null
  /** video_play_actions — video STARTS. Null when Meta did not return the field. */
  videoPlays: number | null
  /** video_continuous_2_sec_watched_actions. Null when absent. */
  continuous2sViews: number | null
  /** RETENTION MILESTONES — % of video length reached. Never an early-view signal. */
  p25: number | null
  p50: number | null
  p75: number | null
  p100: number | null
  thruplays: number | null
  avgWatchSeconds: number | null
  /** Creative length. NULL is a first-class state that lowers confidence — never assumed. */
  durationSeconds: number | null
}

export interface VideoMetrics {
  earlyView: DerivedRate
  earlyViewSource: EarlyViewSource
  retentionP25: DerivedRate
  retentionP50: DerivedRate
  retentionP75: DerivedRate
  completion: DerivedRate
  thruplayRate: DerivedRate
  /** Kept SEPARATE from retention and from ThruPlay — three different things. */
  avgWatchSeconds: number | null
  /** True when the retention denominators fell back to impressions (no video-start count). */
  retentionDenominatorIsImpressions: boolean
  warnings: DerivedMetricWarning[]
}

/**
 * PURE: pick the honest early-view field, or declare it unavailable. p25 is NEVER selected.
 *
 * ABSENT (null) and ZERO are different facts. A present 0 is a real measurement — "the video started
 * zero times" — and yields a genuine 0% rate. Only an ABSENT field makes the rate unavailable.
 * Collapsing the two is how "we don't know" silently becomes "it's zero".
 */
export function resolveEarlyViewSource(inputs: Pick<VideoInputs, 'videoPlays' | 'continuous2sViews'>): EarlyViewSource {
  if (inputs.videoPlays !== null) return 'video_play_actions'
  if (inputs.continuous2sViews !== null) return 'video_continuous_2_sec'
  return 'unavailable'
}

const EARLY_VIEW_UNAVAILABLE =
  'no early-view field in the Meta response (video_play_actions / video_continuous_2_sec). ' +
  'p25 is a retention milestone (25% of video length), NOT an early view, and is never substituted'

/** PURE: derive every video rate with its contract, provenance, and reliability. */
export function computeVideoMetrics(
  inputs: VideoInputs,
  /**
   * Start count usable as the RETENTION denominator, when the caller has verified it covers every
   * row it is dividing. `undefined` = use inputs.videoPlays (single-row case); `null` = coverage is
   * partial or absent, so fall back to impressions and label it.
   */
  retentionStarts?: number | null,
): VideoMetrics {
  const warnings: DerivedMetricWarning[] = []
  const record = (metric: VideoRateKey, r: DerivedRate) => {
    if (r.unreliable) {
      warnings.push({
        metric,
        rawNumerator: r.rawNumerator,
        rawDenominator: r.rawDenominator,
        rawRate: r.rawValue,
        reason: r.warning ?? 'unreliable',
        unreliable: true,
      })
    }
    return r
  }

  const source = resolveEarlyViewSource(inputs)
  const earlyViewCount =
    source === 'video_play_actions' ? inputs.videoPlays
    : source === 'video_continuous_2_sec' ? inputs.continuous2sViews
    : null

  const earlyView =
    source === 'unavailable'
      ? unavailable('early_view_rate', EARLY_VIEW_UNAVAILABLE)
      : record('early_view_rate', boundedRate('early_view_rate', earlyViewCount, inputs.impressions))

  // Retention is share OF PLAYS. Without a play count the only available denominator is impressions,
  // which is a different question ("of everyone who saw it") — flagged so it is never conflated.
  const startsForRetention = retentionStarts === undefined ? inputs.videoPlays : retentionStarts
  const plays = startsForRetention !== null && startsForRetention > 0 ? startsForRetention : null
  const retentionDenominator = plays ?? inputs.impressions
  const retentionDenominatorIsImpressions = plays === null

  return {
    earlyView,
    earlyViewSource: source,
    retentionP25: record('retention_p25_rate', boundedRate('retention_p25_rate', inputs.p25, retentionDenominator)),
    retentionP50: record('retention_p50_rate', boundedRate('retention_p50_rate', inputs.p50, retentionDenominator)),
    retentionP75: record('retention_p75_rate', boundedRate('retention_p75_rate', inputs.p75, retentionDenominator)),
    completion: record('completion_rate', boundedRate('completion_rate', inputs.p100, retentionDenominator)),
    // ThruPlay is measured against impressions, NOT against a retention milestone — the old
    // thruplays/p25 "hold rate" is exactly the ratio that could exceed 100% on a long video.
    thruplayRate: record('thruplay_rate', boundedRate('thruplay_rate', inputs.thruplays, inputs.impressions)),
    avgWatchSeconds: inputs.avgWatchSeconds,
    retentionDenominatorIsImpressions,
    warnings,
  }
}

// ── LENGTH-AWARE INTERPRETATION ────────────────────────────────────────────────────────────────
// A 25%-milestone rate means ~4 seconds of watch time on a 15s video and ~31 seconds on a 125s one.
// Comparing them as if they were the same metric is the error that produced the original defect.

export type VideoLengthClass = 'short' | 'medium' | 'long' | 'unknown'

/** PURE: bucket a creative by length. Unknown is its own class — never defaulted to short. */
export function classifyVideoLength(durationSeconds: number | null): VideoLengthClass {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'unknown'
  if (durationSeconds <= 20) return 'short'
  if (durationSeconds <= 60) return 'medium'
  return 'long'
}

/** PURE: seconds of watch time a milestone represents, or null when the length is unknown. */
export function milestoneSeconds(durationSeconds: number | null, percent: 25 | 50 | 75 | 100): number | null {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  return (durationSeconds * percent) / 100
}

export interface LengthAwareScore {
  /** 0-10, or null when the evidence does not support a score. */
  score: number | null
  lengthClass: VideoLengthClass
  /** 0..1. Reduced when the duration is unknown or a derived input is unreliable. */
  confidence: number
  reasons: string[]
}

// Milestone expectations differ by length: reaching 25% of a 125-second video is a far higher bar
// than 25% of a 15-second one, so the same raw rate must not earn the same score.
const P25_BANDS: Record<Exclude<VideoLengthClass, 'unknown'>, [number, number, number]> = {
  // [good, ok, weak] as percentages of the retention denominator
  short: [45, 30, 15],
  medium: [30, 18, 8],
  long: [18, 10, 4],
}

/**
 * PURE: length-aware creative-health contribution from the 25% retention milestone.
 * Deliberately NOT called a hook score — it measures retention, not scroll-stopping.
 *
 * NO PRODUCTION CALLER (verified by AST call-graph). health-score.ts implements the same
 * length-aware banding inline via RETENTION_BANDS; this function is the tested reference
 * implementation and is currently unused in production. Recorded as a limitation rather than
 * presented as an enforced contract.
 */
export function scoreRetentionForLength(
  retention: DerivedRate,
  durationSeconds: number | null,
  opts: { retentionDenominatorIsImpressions?: boolean } = {},
): LengthAwareScore {
  const lengthClass = classifyVideoLength(durationSeconds)
  const reasons: string[] = []
  let confidence = 1

  if (lengthClass === 'unknown') {
    // Length-sensitive judgement without a length is a guess. Score is withheld, not invented.
    return {
      score: null,
      lengthClass,
      confidence: 0.3,
      reasons: ['video duration is unknown — a length-sensitive retention score cannot be computed, and confidence is reduced rather than a default length assumed'],
    }
  }

  if (retention.value === null) {
    return {
      score: null,
      lengthClass,
      confidence: 0.3,
      reasons: [retention.unavailableReason ?? 'retention rate unavailable'],
    }
  }

  if (retention.unreliable) {
    confidence *= 0.4
    reasons.push(retention.warning ?? 'retention rate is unreliable')
  }
  if (opts.retentionDenominatorIsImpressions) {
    confidence *= 0.7
    reasons.push('retention measured against impressions, not video starts — a different denominator than the contract prefers')
  }

  const [good, ok, weak] = P25_BANDS[lengthClass]
  const v = retention.value
  const score = v >= good ? 10 : v >= ok ? 7 : v >= weak ? 4 : 1
  const secs = milestoneSeconds(durationSeconds, 25)
  reasons.push(
    `${v.toFixed(1)}% reached the 25% milestone` +
    (secs !== null ? ` (~${secs.toFixed(0)}s of watch time on a ${durationSeconds!.toFixed(0)}s ${lengthClass} video)` : ''),
  )
  return { score, lengthClass, confidence, reasons }
}
