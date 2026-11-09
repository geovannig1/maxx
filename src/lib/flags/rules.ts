import type { FlagType, FlagConfidence, AudienceType } from '@/types/db'
import { cpaTarget, getTargetRange } from '@/lib/targets/target-ranges'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { decideActionAuthority, type ActionCandidate, type ActionAuthorityDecision } from '@/lib/authority/action-authority'
import type { AuthorityBasis } from '@/lib/modes/operating-mode'
import { decisiveCpaVsTarget } from '@/lib/learning/model'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'

export interface FlagRule {
  flag_type: FlagType
  confidence: FlagConfidence
  reason: string
  /**
   * This used to hold free-text imperatives — "Pause. Check landing page
   * URL...", "Increase budget by 20%...", "Reduce budget or pause" — computed from Meta-MODELLED
   * conversions and surfaced verbatim through the flags MCP tool and the UI. It therefore bypassed the
   * interaction-cohort authority entirely, letting Maxx instruct a budget change on evidence that
   * cannot tie spend to outcomes.
   *
   * Rules now emit a structured {@link ActionCandidate}. `decideActionAuthority` is the only place
   * that renders owner-facing action language. Read `recommended_action` through
   * `renderFlagAction(rule, basis)`, never directly.
   */
  candidate: ActionCandidate
  watch_next: string
}

/**
 * The owner-facing action text for a flag, decided by the ONE authority layer. Money candidates on
 * Meta-modelled evidence come back as observations with no imperative.
 */
export function renderFlagAction(rule: FlagRule, basis: AuthorityBasis): ActionAuthorityDecision {
  return decideActionAuthority(rule.candidate, basis)
}

export interface FlagInput {
  spend: number
  cpa: number | null        // cost per AppointmentConfirmed
  cpl: number | null        // cost per lead
  ctr: number | null
  frequency: number | null
  impressions: number
  bookings: number
  leads: number
  roas: number | null
  window_days: number
  entity_age_days?: number  // how many days since this ad/adset was created
  audience_type: AudienceType
  peak_ctr?: number | null  // historical peak CTR for this entity (for fatigue detection)
}

// ── Business constants ────────────────────────────────────────
// Read from the central target-range config via getTargetRange, which returns the ACTIVE ranges
// (defaults + Performance-Targets overrides). The flag run hydrates overrides first, so an edited
// target re-bands flags too. The CPA target (healthy edge) and maximum (watch edge) are owner-set: with
// none set, every rule that compares against them is skipped.
const minCtr = () => getTargetRange('ctr').watch              // below this after 500+ impressions = problem
const freqWarning = () => getTargetRange('frequency').healthy
const freqCritical = () => getTargetRange('frequency').watch
const TOO_EARLY_HOURS = 48
const tooEarlySpend = () => REC_THRESHOLDS.MIN_SPEND_TO_JUDGE // account currency; under this, too early to judge
const fmtStop = (n: number) => `${formatMoney((n * REC_THRESHOLDS.ZERO_OUTCOME_STOP_CPA_MULTIPLE), { maximumFractionDigits: 0 })}`

/**
 * Evaluates an ad/adset's metrics for a given window and returns a flag,
 * or null if no flag condition is met.
 */
export function evaluateFlag(input: FlagInput): FlagRule | null {
  const {
    spend,
    cpa,
    ctr,
    frequency,
    impressions,
    bookings,
    window_days,
    entity_age_days,
    peak_ctr,
  } = input
  const cpaT = cpaTarget()

  // ── Too Early ─────────────────────────────────────────────
  const ageDays = entity_age_days ?? window_days
  if (ageDays < (TOO_EARLY_HOURS / 24) || spend < tooEarlySpend()) {
    const shortfalls = [
      ageDays < (TOO_EARLY_HOURS / 24)
        ? `age is ${ageDays} day(s), below the ${TOO_EARLY_HOURS / 24}-day floor`
        : null,
      spend < tooEarlySpend()
        ? `${formatMoneyAmount(tooEarlySpend())} spend floor not met (only ${formatMoney(spend)} so far)`
        : null,
    ].filter((line): line is string => line !== null)
    const shortfallSummary = shortfalls.join('; ')
    return {
      flag_type: 'too_early',
      confidence: 'high',
      reason: `Too early to judge: ${shortfallSummary}.`,
      candidate: { kind: 'observe', plane: 'structural',
        observation: `Too early to judge: ${shortfallSummary}.`,
        investigate: 'CTR direction and the first AppointmentConfirmed event' },
      watch_next: 'CTR direction and first AppointmentConfirmed event',
    }
  }

  // ── Creative Refresh (frequency + CTR fatigue) ────────────
  // Frequency/CTR change is a diagnostic trigger. Booking context stays modelled and cannot establish
  // creative causality, a refresh response, or a spend decision.
  if (frequency !== null && frequency >= freqCritical()) {
    const ctrDrop = peak_ctr && ctr !== null && peak_ctr > 0
      ? ((peak_ctr - ctr) / peak_ctr) * 100
      : null
    // A bare `cpa <= targetCpa()` picked the CAUSE ("the AD works" vs "the audience is
    // saturated") off a comparison that one booking can flip at this volume. decisiveCpaVsTarget
    // widens the count by its Poisson interval and only names a side when even the pessimistic end
    // agrees; otherwise the comparison is reported as not decisive rather than silently resolved.
    const cpaVerdict =
      bookings > 0 && cpa !== null && cpaT !== null ? decisiveCpaVsTarget(spend, bookings, cpaT.target) : null
    const modelledWithoutTarget = cpaT === null && bookings > 0 && cpa !== null

    const bookingContext =
      cpaVerdict === 'better'
        ? ` Meta models ${bookings} conversion(s) at ${formatMoney(cpa!)} CPA, with the count interval below the provisional reference; this does not prove the ad works or that creative wear caused the delivery pattern.`
        : cpaVerdict !== null
          ? ` Meta models ${bookings} conversion(s) at ${formatMoney(cpa!)} CPA — not decisive against the provisional ${formatMoneyAmount(cpaT!.target)} reference at this count, so the cause is not established.`
          : modelledWithoutTarget
            ? ` Meta-modelled conversions arrive at ${formatMoney(cpa!)} CPA; no CPA target is set to compare it with.`
            : ' No Meta-modelled conversions in the window.'

    return {
      flag_type: 'creative_refresh',
      confidence: 'high',
      reason: `Frequency ${frequency.toFixed(2)} — audience has seen this ${frequency.toFixed(1)}x${ctrDrop !== null ? `, CTR dropped ${ctrDrop.toFixed(0)}% from peak` : ''}.${bookingContext}`,
      // Creative refresh is NOT a money action — it changes the asset, not the spend.
      candidate: { kind: 'creative_refresh', plane: 'meta_modelled',
        observation: cpaVerdict === 'better'
          ? `Frequency ${frequency.toFixed(2)} with modelled conversions still arriving at ${formatMoney(cpa!)} modelled CPA. This is consistent with possible creative wear, but neither the cause nor a refresh response is proven.`
          : cpaVerdict !== null
            ? `Frequency ${frequency.toFixed(2)} with ${bookings} modelled conversion(s) at ${formatMoney(cpa!)} modelled CPA — not decisive against the provisional reference at this count, so the cause and response are not established.`
            : modelledWithoutTarget
              ? `Frequency ${frequency.toFixed(2)} at ${formatMoney(cpa!)} modelled CPA and no CPA target set — the cause and response are not established.`
            // Frequency alone is a delivery observation. Naming saturation would require a verified
            // audience definition and size, which is exactly what is unreadable here.
            : `Frequency ${frequency.toFixed(2)} and no modelled conversions in the window — a raw delivery observation; audience size is unverified, so this is not proof of saturation.`,
        investigate: 'whether the longitudinal frequency/CTR pattern persists and exact paid outcomes corroborate it before any asset decision' },
      watch_next: 'Whether the longitudinal delivery pattern persists; creative causality remains unproven',
    }
  }

  if (
    frequency !== null && frequency >= freqWarning() &&
    peak_ctr !== null && peak_ctr !== undefined && ctr !== null &&
    peak_ctr > 0 && ((peak_ctr - ctr) / peak_ctr) * 100 >= 20
  ) {
    return {
      flag_type: 'creative_refresh',
      confidence: 'medium',
      reason: `Frequency ${frequency.toFixed(2)} with CTR declining — delivery pattern consistent with possible creative wear; cause unproven`,
      candidate: { kind: 'creative_refresh', plane: 'meta_modelled',
        observation: 'Frequency is rising while CTR is below its prior peak; this is descriptive delivery evidence, not proof that creative wear caused the change.',
        investigate: 'whether the longitudinal pattern persists and exact paid outcomes corroborate it before any asset decision' },
      watch_next: 'Whether the longitudinal frequency/CTR pattern persists; creative causality remains unproven',
    }
  }

  // ── Loser (hard failures) ─────────────────────────────────
  // Require a ≥3-day window before condemning an entity: AppointmentConfirmed conversions lag
  // (7d-click attribution), so a single bad day is not enough evidence to pause.
  //
  // Zero-outcome tiers (central config: REC_THRESHOLDS.ZERO_OUTCOME_*_CPA_MULTIPLE, expressed as
  // multiples of the ACTIVE max-acceptable CPA — a maximum of M → 2M review / 3M stop):
  //   2x review — spend has reached 2x the worst acceptable cost per booking with nothing to show.
  //   3x stop   — continuing is the risk, not acting.
  // NOTE: the enforced review rule below fires earlier (2x the HEALTHY target), which is the
  // more conservative tier; the stop tier is evaluated first so it always wins when both match.
  // Both tiers need an owner-set CPA target and never fire without one (decision, tested in
  // tests/zero-outcome-tiers-need-target.test.ts): a fallback from the spend floor would invent a
  // commercial threshold. Without a target the owner is asked to set one, and the zero-conversion alert
  // still reports an entity that normally converts spending with none.

  // Stop tier: 3x max-acceptable CPA with zero bookings — the bleed is no longer a review question.
  if (
    window_days >= 3 && bookings === 0 && cpaT !== null &&
    spend >= cpaT.max * REC_THRESHOLDS.ZERO_OUTCOME_STOP_CPA_MULTIPLE &&
    impressions >= 500
  ) {
    return {
      flag_type: 'loser',
      confidence: 'high',
      reason: `${formatMoney(spend)} spent with 0 Meta-modelled AppointmentConfirmed after ${impressions.toLocaleString()} impressions — ${(spend / cpaT.max).toFixed(1)}x the provisional ${formatMoneyAmount(cpaT.max)} max-acceptable CPA (3x stop tier)`,
      candidate: { kind: 'pause', plane: 'meta_modelled',
        observation: `${formatMoney(spend)} spent with zero MODELLED conversions after ${impressions.toLocaleString()} impressions — spend has passed the 3x stop tier (${fmtStop(cpaT.max)}); at this point continued delivery is the risk, not the pause.`,
        investigate: 'landing-page URL, pixel/CAPI firing, and creative angle — a tracking failure still looks identical to a demand failure, but the stop threshold does not wait for that diagnosis' },
      watch_next: 'Whether the owner stops the bleed; diagnosis of the zero continues in parallel, not instead',
    }
  }

  // Review tier: 2x target CPA with zero bookings and meaningful impressions
  if (window_days >= 3 && bookings === 0 && cpaT !== null && spend >= cpaT.target * 2 && impressions >= 500) {
    return {
      flag_type: 'loser',
      confidence: 'high',
      reason: `${formatMoney(spend)} spent with 0 Meta-modelled AppointmentConfirmed after ${impressions.toLocaleString()} impressions`,
      // MONEY candidate on MODELLED evidence: the authority layer will make this an observation.
      candidate: { kind: 'pause', plane: 'meta_modelled',
        observation: `${formatMoney(spend)} spent with zero MODELLED conversions after ${impressions.toLocaleString()} impressions.`,
        investigate: 'landing-page URL, pixel/CAPI firing, and creative angle — a tracking failure looks identical to a demand failure here' },
      watch_next: 'Whether landing-page, pixel/CAPI or creative diagnosis explains the zero — before any spend decision',
    }
  }

  // CTR too low after enough impressions — but never condemn an ad that is actually producing
  // cheap bookings (low CTR + good CPA is fine; the funnel works despite a weak hook). With no CPA target,
  // "cheap" cannot be judged, so any modelled conversion counts as converting.
  const cheaplyConverting = bookings > 0 && cpa !== null && (cpaT === null || cpa <= cpaT.max)
  if (window_days >= 3 && ctr !== null && ctr < minCtr() && impressions >= 500 && !cheaplyConverting) {
    return {
      flag_type: 'loser',
      confidence: 'medium',
      reason: `CTR ${ctr.toFixed(2)}% — below the provisional ${minCtr()}% diagnostic reference after ${impressions.toLocaleString()} impressions`,
      candidate: { kind: 'pause', plane: 'meta_modelled',
        observation: 'CTR is below the provisional diagnostic reference at meaningful volume; this does not prove the hook or audience caused the result.',
        investigate: 'whether a replacement creative recovers CTR before any spend decision' },
      watch_next: 'CTR after exposure to a materially different creative angle',
    }
  }

  // Modelled CPA above the provisional diagnostic watch reference.
  if (window_days >= 3 && cpa !== null && cpaT !== null && cpa > cpaT.max * 1.5 && bookings > 0) {
    return {
      flag_type: 'loser',
      confidence: 'medium',
      reason: `MODELLED CPA ${formatMoney(cpa)} — ${((cpa / cpaT.max - 1) * 100).toFixed(0)}% above the provisional ${formatMoneyAmount(cpaT.max)} diagnostic reference`,
      candidate: { kind: 'budget_cut', plane: 'meta_modelled',
        observation: `Modelled CPA is above the provisional diagnostic reference in this window.`,
        investigate: 'whether settled, causally incremental contribution is negative; exact paid touch alone would remain association' },
      watch_next: 'Whether a governed causal contribution comparison establishes a mature loss',
    }
  }

  // ── Scale Candidate ───────────────────────────────────────
  // Checked BEFORE winner (audit 24L): a strong-enough winner — more bookings (≥5) AND healthy (not just
  // sub-critical) frequency — should surface as a scale PROPOSAL, not merely "keep". Previously the looser
  // winner rule (bookings ≥3, freq < critical) shadowed this, so `scale_candidate` was unreachable and the
  // flag→rec pipeline never produced a `scale`. The scale rec stays approval + write-mode gated, and the
  // grounding gate still requires a stable trend before it's actionable.
  if (
    cpa !== null && cpaT !== null && cpa <= cpaT.target &&
    bookings >= 5 &&
    (frequency === null || frequency < freqWarning()) &&
    window_days >= 7
  ) {
    return {
      flag_type: 'scale_candidate',
      confidence: 'medium',
      reason: `MODELLED CPA ${formatMoney(cpa)} is below the provisional diagnostic reference with frequency ${frequency?.toFixed(2) ?? 'unavailable'}`,
      candidate: { kind: 'budget_scale', plane: 'meta_modelled',
        observation: `Modelled CPA is at or below the provisional diagnostic reference with modelled conversions present in this window.`,
        investigate: 'whether processor-settled causal incremental contribution is positive and its uncertainty interval remains above zero' },
      watch_next: 'Whether a governed causal contribution comparison clears zero; modelled CPA cannot authorise more spend',
    }
  }

  // ── Winner ────────────────────────────────────────────────
  // A good performer that isn't (yet) a scale candidate — fewer bookings, or frequency into the warning
  // band. Keep it running rather than scale.
  if (
    cpa !== null && cpaT !== null && cpa <= cpaT.target &&
    bookings >= 3 &&
    window_days >= 7 &&
    (frequency === null || frequency < freqCritical())
  ) {
    const confidence: FlagConfidence = bookings >= 7 ? 'high' : 'medium'
    return {
      flag_type: 'winner',
      confidence,
      reason: `MODELLED CPA ${formatMoney(cpa)} below the provisional ${formatMoneyAmount(cpaT.target)} diagnostic reference with ${bookings} modelled conversion(s) over ${window_days} days`,
      candidate: { kind: 'observe', plane: 'meta_modelled',
        observation: 'Modelled CPA is below the provisional diagnostic reference in this window.',
        investigate: 'delivery stability and whether governed causal incremental contribution evidence becomes available' },
      watch_next: 'Delivery stability; commercial contribution remains unavailable without settled causal evidence',
    }
  }

  // ── Watchlist (borderline CPA, needs more data) ───────────
  if (cpa !== null && cpaT !== null && cpa > cpaT.target && cpa <= cpaT.max && bookings >= 1) {
    return {
      flag_type: 'watchlist',
      confidence: 'low',
      reason: `MODELLED CPA ${formatMoney(cpa)} — between provisional diagnostic references (${formatMoneyAmount(cpaT.target)}–${formatMoneyAmount(cpaT.max)})`,
      candidate: { kind: 'observe', plane: 'meta_modelled',
        observation: 'Delivery is steady with modelled efficiency neither clearly good nor clearly bad.',
        investigate: 'the modelled CPA trend direction over the next few days' },
      watch_next: `Whether modelled CPA moves below or above the provisional diagnostic references (${formatMoneyAmount(cpaT.target)}–${formatMoneyAmount(cpaT.max)}) over the next 7 days`,
    }
  }

  // No flag — not enough signal yet
  return null
}
