import type { BriefExpectation, BriefGateId } from './brief-rubric'

/** The server-owned audit adapter now supplies every plane required by the owner audit. */

export interface UnreachableGate {
  question: string
  gate: BriefGateId
  /** The plane whose absence from the claim supply disables this gate. */
  blockedByMissingPlane?: 'outcome_business' | 'ga4_telemetry' | 'paid_association'
  /** The entity level the supply cannot emit, which disables this gate at that granularity. */
  blockedByMissingLevel?: 'campaign' | 'adset' | 'ad'
  reason: string
}

export const UNREACHABLE_GATES: readonly UnreachableGate[] = []

export const BRIEF_EXPECTATIONS: Readonly<Record<string, BriefExpectation>> = {
  'q1-flagship-diagnosis': {
    id: 'q1-flagship-diagnosis',
    requiredPlanes: [
      'meta_delivery', 'outcome_business', 'ga4_telemetry',
      'paid_association', 'capi_delivery', 'decision',
    ],
    businessTruthMetrics: ['appointments'],
    mustDeclareUnavailable: ['paid.cpa', 'paid.roas'],
    entityLevels: {
      meta_delivery: ['account', 'adset'], outcome_business: ['business'],
      ga4_telemetry: ['account'], paid_association: ['account'],
      capi_delivery: ['account'], decision: ['account'],
    },
    window: null,
    actionDecisions: 'either',
  },
  'q2-adset-optimized': {
    id: 'q2-adset-optimized',
    requiredPlanes: ['meta_delivery', 'decision'],
    businessTruthMetrics: [],
    mustDeclareUnavailable: [],
    entityLevels: { meta_delivery: ['account', 'adset'], decision: ['account'] },
    window: null,
    actionDecisions: 'either',
  },
  'q3-creative-quality': {
    id: 'q3-creative-quality',
    requiredPlanes: ['meta_delivery', 'decision'],
    businessTruthMetrics: [],
    mustDeclareUnavailable: [],
    entityLevels: { meta_delivery: ['account', 'ad'], decision: ['account'] },
    window: null,
    actionDecisions: 'either',
  },
  'q4-optimization-goal-budget': {
    id: 'q4-optimization-goal-budget',
    requiredPlanes: ['meta_delivery', 'outcome_business', 'paid_association', 'decision'],
    businessTruthMetrics: ['appointments'],
    mustDeclareUnavailable: ['paid.cpa', 'paid.roas'],
    entityLevels: {
      meta_delivery: ['account'], outcome_business: ['business'],
      paid_association: ['account'], decision: ['account'],
    },
    window: null,
    // A budget question must not invent a governed decision. Referencing one requires it to exist and
    // be persisted final, which renderAnswerBrief verifies independently.
    actionDecisions: 'either',
  },
}
