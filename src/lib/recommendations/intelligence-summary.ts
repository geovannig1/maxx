import { learningStatus, type LearningStatusInput } from './learning-status'
import { isCausalContributionMetric } from '@/lib/economics/causal-metric'

// Intelligence-status aggregation (dashboard/report surfaces). PURE + tested. Rolls up open
// recommendations + scored outcomes + expert insights + benchmark status into the counts the
// dashboard/report show: confidence & risk distributions, learning posture, what needs review, what is
// learned vs hypothesis, expert-insight freshness, benchmark prior status, and write-mode. Display only.

export interface RecSummaryRow extends LearningStatusInput {
  confidence_label?: string | null
  risk_level?: string | null
}

export interface OutcomeSummaryRow {
  outcome?: string | null
  review_status?: string | null
  estimate_only?: boolean | null
  metric_name?: string | null
}

export interface InsightSummaryRow {
  applies_to_account?: boolean | null
  expires_at?: string | null
  summary?: string | null
  title?: string | null
  published_at?: string | null
  source?: string | null
}

export interface IntelligenceSummary {
  totalOpen: number
  confidence: { high: number; medium: number; low: number; insufficient: number }
  risk: { high: number; medium: number; low: number }
  posture: {
    eligible: number
    hypothesis: number
    external_inspiration: number
    attribution_unclear: number
    not_enough_data: number
    no_outcome_yet: number
  }
  outcomes: { total: number; pending: number; approved: number; rejected: number; worked: number; failed: number; inconclusive: number; needsReview: number }
  expertInsights: { active: number; expired: number; latest: { text: string; source: string | null; published_at: string | null } | null }
  benchmark: 'neutral (no cross-account prior)' | 'seeded (weak, labeled prior)'
  writeMode: 'off' | 'on'
}

export function summarizeIntelligence(input: {
  recs: RecSummaryRow[]
  outcomes: OutcomeSummaryRow[]
  insights: InsightSummaryRow[]
  benchmarkSeeded: boolean
  writeModeEnabled: boolean
  today: string
}): IntelligenceSummary {
  const confidence = { high: 0, medium: 0, low: 0, insufficient: 0 }
  const risk = { high: 0, medium: 0, low: 0 }
  const posture = { eligible: 0, hypothesis: 0, external_inspiration: 0, attribution_unclear: 0, not_enough_data: 0, no_outcome_yet: 0 }

  for (const r of input.recs) {
    if (r.confidence_label && r.confidence_label in confidence) confidence[r.confidence_label as keyof typeof confidence]++
    if (r.risk_level && r.risk_level in risk) risk[r.risk_level as keyof typeof risk]++
    const s = learningStatus(r)
    if (s.state === 'eligible') posture.eligible++
    else if (s.state === 'hypothesis') posture.hypothesis++
    else if (s.state === 'external_inspiration') posture.external_inspiration++
    else if (s.state === 'attribution_unclear') posture.attribution_unclear++
    else if (s.state === 'not_enough_data') posture.not_enough_data++
    else posture.no_outcome_yet++
  }

  const outcomes = { total: input.outcomes.length, pending: 0, approved: 0, rejected: 0, worked: 0, failed: 0, inconclusive: 0, needsReview: 0 }
  for (const o of input.outcomes) {
    const causalCommercialOutcome = isCausalContributionMetric(o.metric_name)
    const rs = o.review_status ?? 'pending'
    if (rs === 'approved') outcomes.approved++
    else if (rs === 'rejected') outcomes.rejected++
    else outcomes.pending++
    if (o.outcome === 'worked' && causalCommercialOutcome) outcomes.worked++
    else if (o.outcome === 'failed' && causalCommercialOutcome) outcomes.failed++
    else if (o.outcome === 'inconclusive') outcomes.inconclusive++
    // A decisive, non-estimate, still-pending outcome is one the owner should review.
    if (rs === 'pending' && causalCommercialOutcome && !o.estimate_only && (o.outcome === 'worked' || o.outcome === 'failed')) outcomes.needsReview++
  }

  let active = 0
  let expired = 0
  let latest: IntelligenceSummary['expertInsights']['latest'] = null
  for (const ins of input.insights) {
    if (ins.applies_to_account !== true) continue
    const isExpired = !!ins.expires_at && ins.expires_at < input.today
    if (isExpired) { expired++; continue }
    active++
    const text = (ins.summary ?? ins.title ?? '').slice(0, 160)
    if (!latest || (ins.published_at ?? '') > (latest.published_at ?? '')) {
      latest = { text, source: ins.source ?? null, published_at: ins.published_at ?? null }
    }
  }

  return {
    totalOpen: input.recs.length,
    confidence,
    risk,
    posture,
    outcomes,
    expertInsights: { active, expired, latest },
    benchmark: input.benchmarkSeeded ? 'seeded (weak, labeled prior)' : 'neutral (no cross-account prior)',
    writeMode: input.writeModeEnabled ? 'on' : 'off',
  }
}
