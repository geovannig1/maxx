// Auction and delivery evidence only. This module deliberately does not read CPA, ROAS, bookings, or
// revenue and it never proposes an action. Money decisions belong to the governed recommendation
// pipeline, where exact interaction-cohort evidence and an ActionDecision are required.

import type { TrustScore } from '@/lib/trust/trust'
import type { RankingTier } from './rankings'

export type DeliverySignalState = 'observed' | 'notable' | 'unavailable'

export interface DeliveryDiagnosticSignal {
  key: 'pacing' | 'frequency' | 'quality'
  label: string
  state: DeliverySignalState
  detail: string
}

export type DeliveryDiagnosticStatus =
  | 'evidence_available'
  | 'notable_observation'
  | 'insufficient_evidence'

export interface DeliveryDiagnosticInput {
  /** From computePacing: under / on / over relative to the entity's recorded budget. */
  pacing?: { status: 'under' | 'on' | 'over' | null; pct: number | null }
  frequency?: number | null
  qualityTier?: RankingTier
  trust: TrustScore
}

export interface DeliveryDiagnosticResult {
  status: DeliveryDiagnosticStatus
  summary: string
  signals: DeliveryDiagnosticSignal[]
  trust: TrustScore
  action_authority: {
    tier: 'diagnostic_only'
    prescriptions: []
    reason_code: 'auction_delivery_evidence_only'
  }
}

function pacingSignal(pacing: DeliveryDiagnosticInput['pacing']): DeliveryDiagnosticSignal {
  if (!pacing?.status) {
    return { key: 'pacing', label: 'Delivery pacing', state: 'unavailable', detail: 'no comparable entity budget' }
  }
  const detail = pacing.pct == null ? `pacing ${pacing.status}` : `pacing ${pacing.pct.toFixed(0)}% of recorded budget`
  return {
    key: 'pacing',
    label: 'Delivery pacing',
    state: pacing.status === 'on' ? 'observed' : 'notable',
    detail,
  }
}

function frequencySignal(frequency: number | null | undefined): DeliveryDiagnosticSignal {
  if (frequency == null || !Number.isFinite(frequency)) {
    return { key: 'frequency', label: 'Audience exposure', state: 'unavailable', detail: 'not enough delivery data' }
  }
  return { key: 'frequency', label: 'Audience exposure', state: 'observed', detail: `frequency ${frequency.toFixed(2)}` }
}

function qualitySignal(tier: RankingTier | undefined): DeliveryDiagnosticSignal {
  switch (tier) {
    case 'above_average':
      return { key: 'quality', label: 'Auction quality', state: 'observed', detail: tier }
    case 'average':
      return { key: 'quality', label: 'Auction quality', state: 'observed', detail: tier }
    case 'below_average':
      return { key: 'quality', label: 'Auction quality', state: 'notable', detail: tier }
    default:
      return { key: 'quality', label: 'Auction quality', state: 'unavailable', detail: 'not rated by Meta' }
  }
}

export function computeDeliveryDiagnostic(input: DeliveryDiagnosticInput): DeliveryDiagnosticResult {
  const signals = [pacingSignal(input.pacing), frequencySignal(input.frequency), qualitySignal(input.qualityTier)]
  const observed = signals.filter((signal) => signal.state !== 'unavailable')
  // Engagement-only evidence is intentionally capped below the 95% action bar by computeTrust. That
  // must not erase descriptive delivery facts: moderate/high evidence may be narrated, while authority
  // remains diagnostic_only and prescriptions remain empty.
  const evidenceReadable = input.trust.level === 'verified' || input.trust.level === 'high' || input.trust.level === 'moderate'

  let status: DeliveryDiagnosticStatus
  let summary: string
  if (!evidenceReadable || observed.length === 0) {
    status = 'insufficient_evidence'
    summary = `Auction and delivery evidence is insufficient for a reliable diagnostic (trust ${input.trust.score}%).`
  } else if (observed.some((signal) => signal.state === 'notable')) {
    status = 'notable_observation'
    summary = 'One or more notable auction or delivery observations are present in this window.'
  } else {
    status = 'evidence_available'
    summary = 'Auction and delivery evidence is available for this window.'
  }

  return {
    status,
    summary,
    signals,
    trust: input.trust,
    action_authority: {
      tier: 'diagnostic_only',
      prescriptions: [],
      reason_code: 'auction_delivery_evidence_only',
    },
  }
}
