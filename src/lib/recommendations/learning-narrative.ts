import { outcomeLearningLabel, type LearningTone } from '@/lib/recommendations/learning-status'
import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import { formatMoney } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

const ATTR_FLOOR_PCT = Math.round(REC_THRESHOLDS.MIN_ATTRIBUTED_SHARE * 100)

// Narrative grouping for the learnings page — turns the two raw feeds (scored outcomes + distilled
// patterns) into the four plain-English buckets the redesigned page tells its story with. It does NOT
// invent learning semantics: the outcome gate is exactly the OutcomeReviewList / outcomeLearningLabel
// rule — only an APPROVED, decisive, non-estimate outcome is a trusted learning; estimate-only and
// inconclusive are never trusted; rejected is kept as an informative hypothesis. Pattern verdicts
// (strong/mixed/weak/insufficient) mirror the existing chip semantics.

/** Narrow outcome shape — structurally satisfied by OutcomeReviewItem, so the page passes its rows as-is. */
export interface NarrativeOutcome {
  flag_type?: string | null
  audience_type?: string | null
  recommendation?: string | null
  outcome?: string | null // worked | failed | inconclusive | null
  review_status?: string | null // pending | approved | rejected | inconclusive
  estimate_only?: boolean | null
  metric_name?: string | null
  confidence?: string | null
  baseline_value?: number | null
  observed_value?: number | null
}

/** Narrow pattern shape — structurally satisfied by the learnings page's PatternRow. */
export interface NarrativePattern {
  dimension?: string | null
  segment?: string | null
  recommendation?: string | null
  verdict?: string | null // strong | mixed | weak | insufficient
  confidence?: string | null
  cpa?: number | null
  ctr?: number | null
  win_rate?: number | null
  sample_bookings?: number | null
}

export interface NarrativeEntry {
  kind: 'outcome' | 'pattern'
  /** Plain-English headline for the row. */
  title: string
  detail?: string
  /** Short stat line (CPA move, win rate, sample). */
  meta?: string
  tone: LearningTone
}

export interface LearningNarrative {
  awaitingReview: NarrativeEntry[]
  trusted: NarrativeEntry[]
  hypotheses: NarrativeEntry[]
  excluded: Array<{ item: NarrativeEntry; why: string }>
  headline: string
}

function outcomeTitle(o: NarrativeOutcome): string {
  const head = o.flag_type ?? 'recommendation'
  return o.audience_type ? `${head} · ${o.audience_type}` : head
}

function outcomeMeta(o: NarrativeOutcome): string | undefined {
  const parts: string[] = []
  if (o.outcome) parts.push(o.outcome)
  // Every CPA narrated here is a Meta-attributed estimate (flag-window bookings), never GA4 money
  // truth — say so where the number appears, not just in a footer.
  if (o.baseline_value != null && o.observed_value != null) parts.push(`CPA ${Math.round(o.baseline_value)} → ${Math.round(o.observed_value)} · Meta est.`)
  if (o.confidence) parts.push(`confidence: ${o.confidence}`)
  return parts.length ? parts.join(' · ') : undefined
}

function outcomeEntry(o: NarrativeOutcome): NarrativeEntry {
  const tone = outcomeLearningLabel({ outcome: o.outcome, review_status: o.review_status, estimate_only: o.estimate_only, metric_name: o.metric_name }).tone
  return { kind: 'outcome', title: outcomeTitle(o), detail: o.recommendation ?? undefined, meta: outcomeMeta(o), tone }
}

function patternTitle(p: NarrativePattern): string {
  const head = p.dimension ?? 'pattern'
  return p.segment ? `${head}: ${p.segment}` : head
}

function patternMeta(p: NarrativePattern): string | undefined {
  const parts: string[] = []
  // The verdict word leads so mixed vs weak stay distinguishable (tone color alone can't).
  if (p.verdict) parts.push(p.verdict)
  if (p.cpa != null) parts.push(`CPA ${formatMoney(p.cpa)} · Meta est.`)
  if (p.ctr != null) parts.push(`CTR ${p.ctr.toFixed(2)}%`)
  if (p.win_rate != null) parts.push(`win rate ${Math.round(p.win_rate * 100)}%`)
  if (p.sample_bookings != null) parts.push(`${p.sample_bookings} ${OW.many}`)
  if (p.confidence) parts.push(`confidence: ${p.confidence}`)
  return parts.length ? parts.join(' · ') : undefined
}

const PATTERN_TONE: Record<string, LearningTone> = { strong: 'good', mixed: 'warn', weak: 'warn', insufficient: 'neutral' }

function patternEntry(p: NarrativePattern): NarrativeEntry {
  return { kind: 'pattern', title: patternTitle(p), detail: p.recommendation ?? undefined, meta: patternMeta(p), tone: PATTERN_TONE[p.verdict ?? ''] ?? 'neutral' }
}

/** Group scored outcomes + distilled patterns into the learnings page's four buckets. */
export function groupLearningNarrative(input: { outcomes: NarrativeOutcome[]; patterns: NarrativePattern[] }): LearningNarrative {
  const awaitingReview: NarrativeEntry[] = []
  const trusted: NarrativeEntry[] = []
  const hypotheses: NarrativeEntry[] = []
  const excluded: Array<{ item: NarrativeEntry; why: string }> = []

  for (const o of input.outcomes ?? []) {
    const entry = outcomeEntry(o)
    // The gate, verbatim from OutcomeReviewList: only a decisive, non-estimate outcome can ever be a
    // trusted learning, and only once approved.
    const decisive = o.outcome === 'worked' || o.outcome === 'failed'
    const learnable = decisive && !o.estimate_only && isCausalContributionMetric(o.metric_name)
    if (!learnable) {
      const why = !isCausalContributionMetric(o.metric_name)
        ? 'Diagnostic-only outcome — it was not measured as causal incremental contribution dollars.'
        : o.estimate_only
        ? `Estimate-only (GA4 attribution below ${ATTR_FLOOR_PCT}%) — excluded from trusted win-rates even if approved.`
        : o.outcome === 'inconclusive'
          ? 'Inconclusive — the data was too weak to call worked or failed.'
          : 'No decisive outcome yet — nothing to learn from.'
      excluded.push({ item: entry, why })
      continue
    }
    if (o.review_status === 'approved') {
      trusted.push(entry)
    } else if (o.review_status === 'rejected') {
      const framing = 'You rejected this as a trusted learning; kept as a hypothesis, not counted in win-rates.'
      hypotheses.push({ ...entry, detail: entry.detail ? `${entry.detail} — ${framing}` : framing })
    } else if (o.review_status === 'inconclusive') {
      excluded.push({ item: entry, why: 'You marked this inconclusive — not counted as a win or a loss.' })
    } else {
      awaitingReview.push(entry)
    }
  }

  for (const p of input.patterns ?? []) {
    const entry = patternEntry(p)
    // Only a strong verdict is a trusted learning; every other verdict (mixed / weak / insufficient) is
    // an untrusted, still-to-be-proven pattern — a hypothesis.
    if (p.verdict === 'strong') trusted.push(entry)
    else hypotheses.push(entry)
  }

  const headline = `${trusted.length} trusted learning${trusted.length === 1 ? '' : 's'} · ${hypotheses.length} hypothes${hypotheses.length === 1 ? 'is' : 'es'} · ${awaitingReview.length} awaiting your review`

  return { awaitingReview, trusted, hypotheses, excluded, headline }
}
