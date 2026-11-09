// Adapters that express EXISTING confidence structures in the unified Trust vocabulary, so the same
// 0–100 score, 95% bar, factor breakdown, and gaps appear everywhere — without re-deriving a different
// number than the subsystem that already judged the data.

import type { GroundingResult } from '@/lib/recommendations/types'
import { TRUST_BAR, trustLevelFor, type TrustScore, type TrustFactor, type TrustCeiling } from './trust'

/** A recommendation already ran the 10-point grounding gate. Keep THAT authoritative — present its
 *  confidence_score as the trust score, its checks as factors, its warnings as integrity ceilings, and
 *  its reasons as gaps. (We don't re-score; the gate the rec passed stays the source of truth.) */
export function trustFromGrounding(g: GroundingResult): TrustScore {
  const factors: TrustFactor[] = g.checks.map((c) => ({
    key: `gate-${c.id}`,
    label: c.question.replace(/\?$/, ''),
    score: c.status === 'pass' ? 1 : c.status === 'na' ? 1 : 0,
    weight: c.status === 'na' ? 0 : 1,
    detail: c.note,
  }))

  // Integrity ceilings from the gate's warnings — and they BIND. The surfaced score is never allowed to
  // sit above a cap shown beside it (mirrors computeTrust's invariant that ceilings always apply),
  // instead of trusting that the gate's confidence_score already reflected every warning.
  const ceilings: TrustCeiling[] = []
  if (g.warnings.estimate) ceilings.push({ reason: g.warnings.estimate, cap: 0.6 })
  if (g.warnings.attribution) ceilings.push({ reason: g.warnings.attribution, cap: 0.4 })
  if (g.warnings.low_data) ceilings.push({ reason: g.warnings.low_data, cap: 0.5 })

  let score01 = Math.max(0, Math.min(1, g.confidence_score))
  for (const c of ceilings) score01 = Math.min(score01, c.cap)
  const score = Math.round(score01 * 100)
  const level = trustLevelFor(score)

  const gaps = [...g.reasons]

  const headline =
    level === 'verified'
      ? `Verified (${score}%) — fully grounded recommendation.`
      : `${level[0].toUpperCase()}${level.slice(1)} (${score}%) — ${g.reasons[0] ?? g.decision}.`

  return { score, level, meetsBar: score >= TRUST_BAR, factors, ceilings, gaps, headline }
}
