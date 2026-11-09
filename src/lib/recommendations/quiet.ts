import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { DataMode } from '@/lib/modes/operating-mode'
import { formatMoney, formatMoneyAmount } from '@/lib/utils/format-currency'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// "Why is Maxx quiet?" — the honest explanation the recommendations surface shows when there are no
// (or few) recommendations. Instead of an empty panel, it names what's holding Maxx back and what
// would supply missing evidence. Every number quoted comes from REC_THRESHOLDS (the same bar the
// grounding gate and operating-mode detector use), never a fresh literal.

export interface QuietInput {
  dataMode: DataMode
  /** Trailing-30d Meta spend. */
  spend30d?: number
  /** Data older than the freshness bar. */
  stale?: boolean
  /** GA4 share of confirmation events carrying a readable campaign label (0..1). */
  attributionCoverage?: number | null
  /** Open recommendations already surfaced — when > 0, Maxx isn't quiet at all. */
  openCount?: number
}

export interface QuietExplanation {
  title: string
  /** Plain-English reasons Maxx is holding back, most-limiting first. */
  reasons: string[]
  /** Evidence or governance prerequisites that fill each gap. */
  unlocks: string[]
}

const {
  DORMANT_SPEND_30D,
  MIN_ATTRIBUTED_SHARE,
  MAX_DATA_AGE_HOURS,
} = REC_THRESHOLDS
const ATTR_FLOOR_PCT = Math.round(MIN_ATTRIBUTED_SHARE * 100)

export function explainQuiet(input: QuietInput): QuietExplanation {
  const { dataMode, spend30d, stale, attributionCoverage, openCount } = input
  const reasons: string[] = []
  const unlocks: string[] = []
  const spendLabel = spend30d != null ? `${formatMoney(spend30d, { maximumFractionDigits: 0 })}` : null
  const lowAttribution = attributionCoverage != null && attributionCoverage < MIN_ATTRIBUTED_SHARE

  switch (dataMode) {
    case 'pre_launch':
      reasons.push(
        `The account is pre-launch — spend over the last 30 days${spendLabel ? ` is ${spendLabel}` : ''} is at or under ${formatMoneyAmount(DORMANT_SPEND_30D)}, so it counts as dormant.`,
      )
      reasons.push(
        `There is no current delivering evidence to grade. A fixed spend, ${OW.one}, day, or learning-event count would not make a campaign decision-ready by itself.`,
      )
      unlocks.push(
        'Store and approve a CampaignPlan before Maxx prescribes launch tracking; its paid-interaction contract must bind immutable Meta IDs with readable names.',
      )
      unlocks.push('Declare the business metric, comparison, loss ceiling, maturity rule, and exact paid-outcome contract before launch.')
      break
    case 'low_data':
      reasons.push(
        `Spend is flowing${spendLabel ? ` (${spendLabel}/30d)` : ''}, but the legacy operating-mode floor is not a decision-sufficiency test.`,
      )
      unlocks.push('Complete exact paid-outcome lineage and apply the CampaignPlan metric, maturity, uncertainty, and loss rules.')
      break
    case 'active_learning':
      reasons.push(
        'Meta reports a learning-state condition. That describes delivery exploration; it does not by itself prove or disprove performance and is not the reason to wait or act.',
      )
      unlocks.push('Use the separate measurement-maturity and decision-sufficiency gates; do not chase learning exit with an unsupported budget or event change.')
      break
    case 'sufficient':
      reasons.push('Legacy diagnostic floors are satisfied, but they do not authorize a conclusion or change. No current governed ActionDecision is open.')
      unlocks.push('Nothing to force: Maxx will surface only a decision that passes the governed target, exact paid-evidence, maturity, and authority gates.')
      break
  }

  if (lowAttribution) {
    reasons.push(
      `Only ${Math.round((attributionCoverage as number) * 100)}% of GA confirmation events carry a readable campaign label (diagnostic goal ≥ ${ATTR_FLOOR_PCT}%). This is a telemetry gap, not measured ${OW.one} attribution.`,
    )
    unlocks.push(
      `Adopt a stored CampaignPlan and paid-interaction contract with immutable Meta IDs, readable names, and exact ${OW.one} linkage. UTM coverage alone never unlocks paid ROAS.`,
    )
  }
  if (stale) {
    reasons.push(`The data may be stale (older than ${MAX_DATA_AGE_HOURS} hours) — Maxx won't act on it until it's re-synced.`)
    unlocks.push('Re-run the sync to refresh the data.')
  }

  const open = openCount ?? 0
  const title =
    open > 0
      ? `${open} recommendation${open === 1 ? ' is' : 's are'} open`
      : dataMode === 'pre_launch'
        ? 'Maxx is quiet because the account is pre-launch.'
        : dataMode === 'low_data'
          ? 'Maxx is quiet because there isn’t enough data yet.'
          : dataMode === 'active_learning'
            ? 'Maxx is reporting learning state separately from decision sufficiency.'
            : 'Maxx has no new recommendations right now.'

  return { title, reasons, unlocks }
}
