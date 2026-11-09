import type { MetaSetupEvidenceProjection } from '@/lib/report/setup-evidence-types'

export type { MetaSetupEvidenceProjection } from '@/lib/report/setup-evidence-types'

export type ExecutiveEvidenceAvailabilityV1 = 'available' | 'partial' | 'unavailable'

export type ExecutiveEvidenceWindowKeyV1 = 'lastDay' | 'trailing7' | 'prior7' | 'monthToDate' | 'postChange'

export interface ExecutiveEvidenceSourceStateV1 {
  availability: ExecutiveEvidenceAvailabilityV1
  head: string | null
  blockerCodes: string[]
}

/** Reader boundary. Runtime normalization still rejects contradictory states such as available+null. */
export interface ExecutiveEvidenceSourceReadV1<T> extends ExecutiveEvidenceSourceStateV1 {
  data: T | null
}

export interface ExecutiveEvidenceWindowV1 {
  startDate: string | null
  endDate: string
  availability: 'available' | 'unavailable'
  changeId?: string | null
  blockerCodes: string[]
}

export type ExecutiveEvidenceWindowsV1 = Record<ExecutiveEvidenceWindowKeyV1, ExecutiveEvidenceWindowV1>
export type ExecutiveWindowFactsV1<T> = Record<ExecutiveEvidenceWindowKeyV1, T | null>

export interface ExecutiveAmountPaidCoverageV1 {
  withRecordedAmount: number
  total: number
}

export interface ExecutiveOutcomeWindowFactsV1 {
  /** Every active appointment, including zero-value appointments. */
  activeAppointments: number
  valueBearingBookings: number
  zeroValueAppointments: number
  bookedValue: number
  /** Sum of observed non-null amount_paid values; a lower bound when coverage is incomplete. */
  activeAmountPaidObserved: number
  /** Exact active-appointment amount_paid only when coverage is complete. */
  activeAmountPaidRevenue: number | null
  amountPaidCoverage: ExecutiveAmountPaidCoverageV1
  canceledAppointments: number
  /** Diagnostic only: excluded exception-state amount kept for legacy compatibility. */
  canceledAmountPaidObserved: number
}

export interface ExecutiveOutcomeWeeklyFactsV1 extends ExecutiveOutcomeWindowFactsV1 {
  windowStart: string
  windowEnd: string
}

export interface ExecutiveOutcomeEvidenceV1 {
  byWindow: ExecutiveWindowFactsV1<ExecutiveOutcomeWindowFactsV1>
  weeklyTrend8: ExecutiveOutcomeWeeklyFactsV1[]
}

export type ExecutiveMetaOutcomePlaneLevelV1 = 'campaign' | 'adset' | 'ad'

export interface ExecutiveMetaOutcomePlaneV1 {
  /** INTEGRITY only. `incomplete` means the response itself cannot be trusted. */
  status: 'complete' | 'incomplete'
  /** Integrity blockers. These, and only these, decide `status`. */
  blockerCodes: string[]
  /**
   * COVERAGE gaps — a non-authoritative measure Meta simply did not supply. Recorded and rendered so
   * value-derived figures read as unavailable on the affected dates, never as zero, but never gating.
   *
   * OPTIONAL because evidence stored before policy v1 has no such field. Absent means "this row was
   * written under the old undivided meaning", NOT "there were no coverage gaps" — so a reader must not
   * treat `undefined` as `[]` when making a completeness claim.
   */
  coverageBlockerCodes?: string[]
  /** The META_OUTCOME_PLANE_POLICY version `status` was computed under. Absent on pre-v1 evidence. */
  policyVersion?: number
  sourceNotBefore: string | null
  checkedLevels: ExecutiveMetaOutcomePlaneLevelV1[]
}

export interface ExecutiveMetaWindowFactsV1 {
  spendAmount: number
  impressions: number
  /** A daily Insights rollup cannot supply native selected-period reach. */
  reach: number
  /** Present when reach is the maximum daily reach, not period reach. */
  reachAggregation?: 'peak_daily'
  linkClicks: number | null
  landingPageViews: number | null
  leads: number | null
  /** Meta-modelled attribution. These fields never become business bookings or exact revenue. */
  modeledBookings: number | null
  modeledBookingValue: number | null
  modeledClickBookings: number | null
  modeledViewBookings: number | null
  modeledUnknownBookings: number | null
  outcomePlane?: ExecutiveMetaOutcomePlaneV1
}

export interface ExecutiveMetaWeeklyFactsV1 extends ExecutiveMetaWindowFactsV1 {
  windowStart: string
  windowEnd: string
}

export interface ExecutiveMetaEvidenceV1 {
  byWindow: ExecutiveWindowFactsV1<ExecutiveMetaWindowFactsV1>
  weeklyTrend8: ExecutiveMetaWeeklyFactsV1[]
}

export interface ExecutiveMetaColdWarmUnitV1 extends ExecutiveMetaWindowFactsV1 {
  entityLevel: 'campaign' | 'adset'
  entityId: string
  parentCampaignId: string | null
  name: string
  comparisonRole: 'cold' | 'warm' | 'other' | null
}

export interface ExecutiveMetaColdWarmEvidenceV1 {
  windowStart: string
  windowEnd: string
  comparisonStatus: 'clean' | 'blocked'
  blockerCodes: string[]
  units: ExecutiveMetaColdWarmUnitV1[]
}

export interface ExecutiveMetaPlacementRowV1 {
  dimension: 'publisher_platform' | 'platform_position'
  value: string
  spendAmount: number
  impressions: number
  clicks: number
  leads: number | null
  modeledBookings: number | null
  outcomePlane?: ExecutiveMetaOutcomePlaneV1
}

export interface ExecutiveMetaPlacementEvidenceV1 {
  windowStart: string
  windowEnd: string
  blockerCodes: string[]
  rows: ExecutiveMetaPlacementRowV1[]
}

export interface ExecutiveTrackingFactsV1 {
  /** Meta landing-page-view telemetry for the same window; null when that field was not returned. */
  landingPageViews: number | null
  paidTouchObservations: number
  identityCompleteTouches: number
  identityIncompleteTouches: number
  linkedAppointments: number
}

export interface ExecutiveCapiFactsV1 {
  mode: 'off' | 'shadow' | 'live' | 'unknown'
  eligibleAppointments: number
  sentAppointments: number
  /** Null when Meta acknowledgement is not available. */
  acceptedAppointments: number | null
  failedAppointments: number
  expiredAppointments: number
}

export type ExecutiveGaIdentityScopeV1 =
  | 'exact_appointment_join'
  | 'legacy_unlinked'
  | 'mixed_partial_coverage'
  | 'no_events_observed'
  | 'pending_configuration'
  | 'unavailable'

export interface ExecutiveGaIdentityFactsV1 {
  confirmationEvents: number
  identifiedEvents: number
  legacyUnlinkedEvents: number
  duplicateAppointments: number
  unmatchedAppointmentIds: number
  websiteBookingsMissingGa: number
  unknownOriginAppointments: number
  scope: ExecutiveGaIdentityScopeV1
}

export interface ExecutivePaidCohortDirectionV1 {
  windowStart: string
  windowEnd: string
  complete: boolean
  blockerCodes: string[]
}

export interface ExecutivePaidCohortFactsV1 {
  policyVersion: number
  complete: boolean
  blockerCodes: string[]
  recentScale: ExecutivePaidCohortDirectionV1
  maturedCut: ExecutivePaidCohortDirectionV1
  associatedSpend: number | null
  associatedValueBearingBookings: number | null
  associatedAmountPaidRevenue: number | null
}

export interface ExecutiveExactPaidAssociationV1 {
  attributionBasis: 'immutable_paid_touch_association'
  spendAmount: number
  valueBearingBookings: number
  amountPaidRevenue: number
  revenueRoas: number | null
}

export interface ExecutivePaidCohortEvidenceV1 extends ExecutivePaidCohortFactsV1 {
  /** Present only for complete, blocker-free paid-touch association evidence. Not a causal claim. */
  exactPaidAssociation: ExecutiveExactPaidAssociationV1 | null
}

/** Injectable seam: another module owns projecting setup and governed material changes. */
export type ExecutiveSetupChangeProjectionV1 = MetaSetupEvidenceProjection

export interface ExecutiveEvidenceBaseRequestV1 {
  accountId: string
  timezone: string
  asOf: string
  lastCompleteDate: string
}

export interface ExecutiveEvidenceWindowRequestV1 extends ExecutiveEvidenceBaseRequestV1 {
  windows: ExecutiveEvidenceWindowsV1
}

export interface ExecutiveEvidenceReadersV1 {
  projectSetupChanges?: (
    request: ExecutiveEvidenceBaseRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveSetupChangeProjectionV1>>
  readOutcome?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveOutcomeEvidenceV1>>
  readMeta?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaEvidenceV1>>
  readMetaColdWarm?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaColdWarmEvidenceV1>>
  readMetaPlacements?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveMetaPlacementEvidenceV1>>
  readTracking?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveTrackingFactsV1>>
  readCapi?: (request: ExecutiveEvidenceWindowRequestV1) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveCapiFactsV1>>
  readGaIdentity?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutiveGaIdentityFactsV1>>
  readPaidCohort?: (
    request: ExecutiveEvidenceWindowRequestV1,
  ) => Promise<ExecutiveEvidenceSourceReadV1<ExecutivePaidCohortFactsV1>>
}

export interface ExecutiveEvidenceSnapshotInputV1 extends ExecutiveEvidenceBaseRequestV1 {
  accountName: string
}

export interface ExecutiveEvidenceSnapshotV1 {
  contract: 'executive_evidence_snapshot'
  version: 1
  generatedAt: string
  account: { id: string; name: string; timezone: string }
  asOf: string
  lastCompleteDate: string
  windows: ExecutiveEvidenceWindowsV1
  sources: {
    setupChanges: ExecutiveEvidenceSourceStateV1
    outcomes: ExecutiveEvidenceSourceStateV1
    meta: ExecutiveEvidenceSourceStateV1
    metaColdWarm: ExecutiveEvidenceSourceStateV1
    metaPlacements: ExecutiveEvidenceSourceStateV1
    tracking: ExecutiveEvidenceSourceStateV1
    capi: ExecutiveEvidenceSourceStateV1
    gaIdentity: ExecutiveEvidenceSourceStateV1
    paidCohort: ExecutiveEvidenceSourceStateV1
  }
  outcomes: ExecutiveOutcomeEvidenceV1 | null
  meta: ExecutiveMetaEvidenceV1 | null
  metaColdWarm: ExecutiveMetaColdWarmEvidenceV1 | null
  metaPlacements: ExecutiveMetaPlacementEvidenceV1 | null
  tracking: ExecutiveTrackingFactsV1 | null
  capi: ExecutiveCapiFactsV1 | null
  gaIdentity: ExecutiveGaIdentityFactsV1 | null
  paidCohort: ExecutivePaidCohortEvidenceV1 | null
  setupChanges: ExecutiveSetupChangeProjectionV1 | null
  authority: {
    tier: 'diagnostic_only'
    moneyActionsAuthorized: false
    reason: string
  }
  governedActions: {
    availability: 'unavailable'
    items: null
    blockerCodes: string[]
  }
  blockerCodes: string[]
}
