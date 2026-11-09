import type {
  ExecutiveOutcomeEvidenceV1,
  ExecutiveOutcomeWeeklyFactsV1,
  ExecutiveOutcomeWindowFactsV1,
  ExecutiveEvidenceAvailabilityV1,
  ExecutiveEvidenceBaseRequestV1,
  ExecutiveEvidenceReadersV1,
  ExecutiveEvidenceSnapshotInputV1,
  ExecutiveEvidenceSnapshotV1,
  ExecutiveEvidenceSourceReadV1,
  ExecutiveEvidenceSourceStateV1,
  ExecutiveEvidenceWindowKeyV1,
  ExecutiveEvidenceWindowsV1,
  ExecutiveMetaEvidenceV1,
  ExecutiveMetaColdWarmEvidenceV1,
  ExecutiveMetaPlacementEvidenceV1,
  ExecutiveMetaWeeklyFactsV1,
  ExecutiveMetaWindowFactsV1,
  ExecutivePaidCohortEvidenceV1,
  ExecutivePaidCohortFactsV1,
  ExecutiveSetupChangeProjectionV1,
  ExecutiveWindowFactsV1,
} from './executive-evidence.types'
import { normalizeMetaColdWarmEvidenceV1, normalizeMetaPlacementEvidenceV1 } from './executive-evidence-meta'
import { buildExecutiveEvidenceWindowsV1, isExecutiveEvidenceDateV1 } from './executive-evidence-windows'
export * from './executive-evidence.types'
type SourceName = 'setup_changes' | 'outcomes' | 'meta' | 'meta_cold_warm' | 'meta_placements' | 'tracking' | 'capi' | 'ga_identity' | 'paid_cohort'

/** Blocker-code prefix of a source: the business outcomes source keeps the singular `outcome_` codes
 *  every other outcome blocker uses. */
const codePrefix = (source: SourceName): string => source === 'outcomes' ? 'outcome' : source
interface NormalizedRead<T> {
  state: ExecutiveEvidenceSourceStateV1
  data: T | null
}
const WINDOW_KEYS: ExecutiveEvidenceWindowKeyV1[] = ['lastDay', 'trailing7', 'prior7', 'monthToDate', 'postChange']
function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function assertInput(input: ExecutiveEvidenceSnapshotInputV1): void {
  if (!input.accountId.trim() || !input.accountName.trim() || !input.timezone.trim()) {
    throw new Error('Executive evidence account identity is required')
  }
  if (!isExecutiveEvidenceDateV1(input.lastCompleteDate)) {
    throw new Error('Executive evidence lastCompleteDate must be a valid YYYY-MM-DD date')
  }
  if (!input.asOf || Number.isNaN(Date.parse(input.asOf))) {
    throw new Error('Executive evidence asOf must be a valid timestamp')
  }
}
function blockersFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return unique(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()))
}
async function readSource<T, R>(source: SourceName, reader: ((request: R) => Promise<ExecutiveEvidenceSourceReadV1<T>>) | undefined, request: R): Promise<NormalizedRead<T>> {
  if (!reader) {
    return unavailable(`${codePrefix(source)}_reader_missing`)
  }
  let raw: unknown
  try {
    raw = await reader(request)
  } catch {
    return unavailable(`${codePrefix(source)}_source_read_failed`)
  }
  if (!isRecord(raw) || !['available', 'partial', 'unavailable'].includes(String(raw.availability))) {
    return unavailable(`${codePrefix(source)}_source_result_invalid`)
  }
  const availability = raw.availability as ExecutiveEvidenceAvailabilityV1
  const suppliedBlockers = blockersFrom(raw.blockerCodes)
  const head = typeof raw.head === 'string' && raw.head.trim() ? raw.head : null
  if (availability === 'unavailable') {
    return {
      state: {
        availability: 'unavailable',
        head,
        blockerCodes: suppliedBlockers.length ? suppliedBlockers : [`${codePrefix(source)}_source_unavailable`],
      },
      data: null,
    }
  }
  if (raw.data === null || raw.data === undefined) {
    return unavailable(`${codePrefix(source)}_source_data_missing`, head)
  }
  const blockerCodes = unique([
    ...suppliedBlockers,
    ...(head ? [] : [`${codePrefix(source)}_source_head_missing`]),
    ...(availability === 'partial' && suppliedBlockers.length === 0 ? [`${codePrefix(source)}_source_partial`] : []),
  ])
  return {
    state: {
      availability: availability === 'available' && blockerCodes.length === 0 ? 'available' : 'partial',
      head,
      blockerCodes,
    },
    data: raw.data as T,
  }
}
function unavailable<T>(blocker: string, head: string | null = null): NormalizedRead<T> {
  return {
    state: { availability: 'unavailable', head, blockerCodes: [blocker] },
    data: null,
  }
}

function withPartialBlockers<T>(read: NormalizedRead<T>, blockers: string[]): NormalizedRead<T> {
  if (!read.data || blockers.length === 0) return read
  return {
    state: {
      ...read.state,
      availability: 'partial',
      blockerCodes: unique([...read.state.blockerCodes, ...blockers]),
    },
    data: read.data,
  }
}

function invalidate<T>(read: NormalizedRead<T>, blocker: string): NormalizedRead<T> {
  return {
    state: {
      availability: 'unavailable',
      head: read.state.head,
      blockerCodes: unique([...read.state.blockerCodes, blocker]),
    },
    data: null,
  }
}

function normalizeSetup(read: NormalizedRead<ExecutiveSetupChangeProjectionV1>): NormalizedRead<ExecutiveSetupChangeProjectionV1> {
  if (!read.data) return read
  const data = read.data
  const shapeValid =
    isRecord(data) &&
    data.contract_version === 1 &&
    ['available', 'blocked'].includes(String(data.status)) &&
    typeof data.complete === 'boolean' &&
    Array.isArray(data.blocker_codes) &&
    Array.isArray(data.campaigns) &&
    Array.isArray(data.adsets) &&
    Array.isArray(data.active_ad_wrappers) &&
    isRecord(data.latest_material_change) &&
    data.action_authority_tier === 'diagnostic_only' &&
    Array.isArray(data.prescriptions)
  if (!shapeValid) return invalidate(read, 'setup_changes_source_data_invalid')
  const projectionBlockers = blockersFrom(data.blocker_codes)
  const completenessBlockers = unique([
    ...projectionBlockers,
    ...(data.status === 'blocked' && projectionBlockers.length === 0 ? ['setup_projection_blocked'] : []),
    ...(!data.complete && projectionBlockers.length === 0 ? ['setup_projection_incomplete'] : []),
  ])
  return withPartialBlockers({ ...read, data: structuredClone(data) }, completenessBlockers)
}

function validOutcomeFact(value: unknown): value is ExecutiveOutcomeWindowFactsV1 {
  if (!isRecord(value) || !isRecord(value.amountPaidCoverage)) return false
  const coverage = value.amountPaidCoverage
  const numeric = [
    value.activeAppointments,
    value.valueBearingBookings,
    value.zeroValueAppointments,
    value.bookedValue,
    value.activeAmountPaidObserved,
    value.canceledAppointments,
    value.canceledAmountPaidObserved,
    coverage.withRecordedAmount,
    coverage.total,
  ]
  if (!numeric.every(isNonNegative)) return false
  return (
    (value.activeAmountPaidRevenue === null || isNonNegative(value.activeAmountPaidRevenue)) &&
    Number.isInteger(coverage.withRecordedAmount) &&
    Number.isInteger(coverage.total) &&
    (coverage.withRecordedAmount as number) <= (coverage.total as number)
  )
}

function normalizeOutcomeFact(value: unknown, key: string): { fact: ExecutiveOutcomeWindowFactsV1 | null; blockers: string[] } {
  if (!validOutcomeFact(value)) return { fact: null, blockers: [`outcome_window_invalid:${key}`] }
  const complete = value.amountPaidCoverage.withRecordedAmount === value.amountPaidCoverage.total
  if (!complete) {
    return {
      fact: {
        ...value,
        amountPaidCoverage: { ...value.amountPaidCoverage },
        activeAmountPaidRevenue: null,
      },
      blockers: [`outcome_amount_paid_coverage_incomplete:${key}`],
    }
  }
  if (value.activeAmountPaidRevenue === null) {
    return {
      fact: { ...value, amountPaidCoverage: { ...value.amountPaidCoverage } },
      blockers: [`outcome_amount_paid_revenue_missing:${key}`],
    }
  }
  return {
    fact: { ...value, amountPaidCoverage: { ...value.amountPaidCoverage } },
    blockers: [],
  }
}

function normalizeOutcome(read: NormalizedRead<ExecutiveOutcomeEvidenceV1>, windows: ExecutiveEvidenceWindowsV1): NormalizedRead<ExecutiveOutcomeEvidenceV1> {
  if (!read.data || !isRecord(read.data) || !isRecord(read.data.byWindow) || !Array.isArray(read.data.weeklyTrend8)) {
    return read.data ? invalidate(read, 'outcome_source_data_invalid') : read
  }
  const blockers: string[] = []
  const byWindow = {} as ExecutiveWindowFactsV1<ExecutiveOutcomeWindowFactsV1>
  for (const key of WINDOW_KEYS) {
    const normalized = normalizeOutcomeFact(read.data.byWindow[key], key)
    byWindow[key] = normalized.fact
    if (windows[key].availability === 'available') blockers.push(...normalized.blockers)
  }
  const weeklyTrend8: ExecutiveOutcomeWeeklyFactsV1[] = []
  read.data.weeklyTrend8.forEach((item, index) => {
    const normalized = normalizeOutcomeFact(item, `weeklyTrend8:${index}`)
    if (!normalized.fact || !isRecord(item) || !isExecutiveEvidenceDateV1(String(item.windowStart)) || !isExecutiveEvidenceDateV1(String(item.windowEnd))) {
      blockers.push(`outcome_weekly_fact_invalid:${index}`)
      return
    }
    blockers.push(...normalized.blockers)
    weeklyTrend8.push({
      ...normalized.fact,
      windowStart: String(item.windowStart),
      windowEnd: String(item.windowEnd),
    })
  })
  return withPartialBlockers({ ...read, data: { byWindow, weeklyTrend8 } }, blockers)
}

function validMetaFact(value: unknown): value is ExecutiveMetaWindowFactsV1 {
  if (!isRecord(value)) return false
  const required = [value.spendAmount, value.impressions, value.reach]
  const nullable = [
    value.linkClicks,
    value.landingPageViews,
    value.leads,
    value.modeledBookings,
    value.modeledBookingValue,
    value.modeledClickBookings,
    value.modeledViewBookings,
    value.modeledUnknownBookings,
  ]
  const outcomePlane = value.outcomePlane
  const planeValid = outcomePlane === undefined || (
    isRecord(outcomePlane) &&
    ['complete', 'incomplete'].includes(String(outcomePlane.status)) &&
    Array.isArray(outcomePlane.blockerCodes) &&
    outcomePlane.blockerCodes.every((item) => typeof item === 'string') &&
    (outcomePlane.sourceNotBefore === null || typeof outcomePlane.sourceNotBefore === 'string') &&
    Array.isArray(outcomePlane.checkedLevels) &&
    outcomePlane.checkedLevels.every((item) => ['campaign', 'adset', 'ad'].includes(String(item)))
  )
  return required.every(isNonNegative) && nullable.every((item) => item === null || isNonNegative(item)) && planeValid
}

function metaFactBlockers(value: ExecutiveMetaWindowFactsV1, key: string): string[] {
  const nullable = {
    link_clicks: value.linkClicks,
    landing_page_views: value.landingPageViews,
    leads: value.leads,
    modeled_bookings: value.modeledBookings,
    modeled_booking_value: value.modeledBookingValue,
    modeled_click_bookings: value.modeledClickBookings,
    modeled_view_bookings: value.modeledViewBookings,
    modeled_unknown_bookings: value.modeledUnknownBookings,
  }
  const blockers = Object.entries(nullable)
    .filter(([, metric]) => metric === null)
    .map(([metric]) => `meta_metric_unavailable:${key}:${metric}`)
  if (value.outcomePlane?.status === 'incomplete') {
    blockers.push(`meta_outcome_plane_incomplete:${key}`)
    blockers.push(...value.outcomePlane.blockerCodes.map((code) => `meta_outcome_plane:${key}:${code}`))
  }
  return unique(blockers)
}

function normalizeMeta(read: NormalizedRead<ExecutiveMetaEvidenceV1>, windows: ExecutiveEvidenceWindowsV1): NormalizedRead<ExecutiveMetaEvidenceV1> {
  if (!read.data || !isRecord(read.data) || !isRecord(read.data.byWindow) || !Array.isArray(read.data.weeklyTrend8)) {
    return read.data ? invalidate(read, 'meta_source_data_invalid') : read
  }
  const blockers: string[] = []
  const byWindow = {} as ExecutiveWindowFactsV1<ExecutiveMetaWindowFactsV1>
  for (const key of WINDOW_KEYS) {
    const item = read.data.byWindow[key]
    byWindow[key] = validMetaFact(item) ? { ...item } : null
    if (windows[key].availability !== 'available') continue
    if (!byWindow[key]) blockers.push(`meta_window_invalid:${key}`)
    else blockers.push(...metaFactBlockers(byWindow[key]!, key))
  }
  const weeklyTrend8: ExecutiveMetaWeeklyFactsV1[] = []
  read.data.weeklyTrend8.forEach((item, index) => {
    if (!validMetaFact(item) || !isRecord(item) || !isExecutiveEvidenceDateV1(String(item.windowStart)) || !isExecutiveEvidenceDateV1(String(item.windowEnd))) {
      blockers.push(`meta_weekly_fact_invalid:${index}`)
      return
    }
    blockers.push(...metaFactBlockers(item, `weeklyTrend8:${index}`))
    weeklyTrend8.push({
      ...item,
      windowStart: String(item.windowStart),
      windowEnd: String(item.windowEnd),
    })
  })
  return withPartialBlockers({ ...read, data: { byWindow, weeklyTrend8 } }, blockers)
}

function validNumericRecord(value: unknown, fields: string[]): value is Record<string, number> {
  return isRecord(value) && fields.every((field) => isNonNegative(value[field]))
}

function normalizeSimple<T>(read: NormalizedRead<T>, valid: (value: unknown) => boolean, blocker: string): NormalizedRead<T> {
  if (!read.data) return read
  if (!valid(read.data)) return invalidate(read, blocker)
  return {
    ...read,
    data: isRecord(read.data) ? ({ ...read.data } as T) : read.data,
  }
}

function normalizePaidCohort(read: NormalizedRead<ExecutivePaidCohortFactsV1>): NormalizedRead<ExecutivePaidCohortEvidenceV1> {
  if (!read.data || !isRecord(read.data) || !isRecord(read.data.recentScale) || !isRecord(read.data.maturedCut)) {
    const normalized = read.data ? invalidate(read, 'paid_cohort_source_data_invalid') : read
    return { state: normalized.state, data: null }
  }
  const facts = read.data
  const cohortBlockers = unique([...blockersFrom(facts.blockerCodes), ...blockersFrom(facts.recentScale.blockerCodes), ...blockersFrom(facts.maturedCut.blockerCodes)])
  const shapeValid =
    Number.isInteger(facts.policyVersion) &&
    facts.policyVersion > 0 &&
    typeof facts.complete === 'boolean' &&
    typeof facts.recentScale.complete === 'boolean' &&
    typeof facts.maturedCut.complete === 'boolean' &&
    isExecutiveEvidenceDateV1(String(facts.recentScale.windowStart)) &&
    isExecutiveEvidenceDateV1(String(facts.recentScale.windowEnd)) &&
    isExecutiveEvidenceDateV1(String(facts.maturedCut.windowStart)) &&
    isExecutiveEvidenceDateV1(String(facts.maturedCut.windowEnd))
  if (!shapeValid) {
    const normalized = invalidate(read, 'paid_cohort_source_data_invalid')
    return { state: normalized.state, data: null }
  }

  const metricsComplete = isNonNegative(facts.associatedSpend) && isNonNegative(facts.associatedValueBearingBookings) && isNonNegative(facts.associatedAmountPaidRevenue)
  const evidenceComplete = read.state.availability === 'available' && facts.complete && facts.recentScale.complete && facts.maturedCut.complete && cohortBlockers.length === 0 && metricsComplete
  const completenessBlockers = unique([
    ...cohortBlockers,
    ...(!facts.complete && cohortBlockers.length === 0 ? ['paid_cohort_incomplete'] : []),
    ...(!facts.recentScale.complete && cohortBlockers.length === 0 ? ['paid_cohort_recent_scale_incomplete'] : []),
    ...(!facts.maturedCut.complete && cohortBlockers.length === 0 ? ['paid_cohort_matured_cut_incomplete'] : []),
    ...(!metricsComplete ? ['paid_cohort_exact_metrics_missing'] : []),
  ])
  const exactPaidAssociation = evidenceComplete
    ? {
        attributionBasis: 'immutable_paid_touch_association' as const,
        spendAmount: facts.associatedSpend as number,
        valueBearingBookings: facts.associatedValueBearingBookings as number,
        amountPaidRevenue: facts.associatedAmountPaidRevenue as number,
        revenueRoas: (facts.associatedSpend as number) > 0 ? (facts.associatedAmountPaidRevenue as number) / (facts.associatedSpend as number) : null,
      }
    : null
  const normalized: ExecutivePaidCohortEvidenceV1 = {
    ...facts,
    blockerCodes: completenessBlockers,
    recentScale: {
      ...facts.recentScale,
      blockerCodes: blockersFrom(facts.recentScale.blockerCodes),
    },
    maturedCut: {
      ...facts.maturedCut,
      blockerCodes: blockersFrom(facts.maturedCut.blockerCodes),
    },
    exactPaidAssociation,
  }
  return withPartialBlockers({ ...read, data: normalized }, completenessBlockers)
}

function sourceState<T>(read: NormalizedRead<T>): ExecutiveEvidenceSourceStateV1 {
  return { ...read.state, blockerCodes: [...read.state.blockerCodes] }
}

export async function buildExecutiveEvidenceSnapshotV1(input: ExecutiveEvidenceSnapshotInputV1, readers: ExecutiveEvidenceReadersV1): Promise<ExecutiveEvidenceSnapshotV1> {
  assertInput(input)
  const baseRequest: ExecutiveEvidenceBaseRequestV1 = {
    accountId: input.accountId,
    timezone: input.timezone,
    asOf: input.asOf,
    lastCompleteDate: input.lastCompleteDate,
  }
  const setup = normalizeSetup(await readSource('setup_changes', readers.projectSetupChanges, baseRequest))
  const windows = buildExecutiveEvidenceWindowsV1(input.lastCompleteDate, input.timezone, setup.data)
  const windowRequest = { ...baseRequest, windows }
  const [outcomeRaw, metaRaw, metaColdWarmRaw, metaPlacementsRaw, trackingRaw, capiRaw, gaIdentityRaw, paidCohortRaw] = await Promise.all([
    readSource('outcomes', readers.readOutcome, windowRequest),
    readSource('meta', readers.readMeta, windowRequest),
    readSource<ExecutiveMetaColdWarmEvidenceV1, typeof windowRequest>('meta_cold_warm', readers.readMetaColdWarm, windowRequest),
    readSource<ExecutiveMetaPlacementEvidenceV1, typeof windowRequest>('meta_placements', readers.readMetaPlacements, windowRequest),
    readSource('tracking', readers.readTracking, windowRequest),
    readSource('capi', readers.readCapi, windowRequest),
    readSource('ga_identity', readers.readGaIdentity, windowRequest),
    readSource('paid_cohort', readers.readPaidCohort, windowRequest),
  ])
  const outcomes = normalizeOutcome(outcomeRaw, windows)
  const meta = normalizeMeta(metaRaw, windows)
  const metaColdWarm = normalizeMetaColdWarmEvidenceV1(metaColdWarmRaw, setup.data, input.timezone)
  const metaPlacements = normalizeMetaPlacementEvidenceV1(metaPlacementsRaw)
  const trackingValidated = normalizeSimple(
    trackingRaw,
    (value) =>
      isRecord(value) &&
      (value.landingPageViews === null || isNonNegative(value.landingPageViews)) &&
      validNumericRecord(value, ['paidTouchObservations', 'identityCompleteTouches', 'identityIncompleteTouches', 'linkedAppointments']),
    'tracking_source_data_invalid',
  )
  const tracking = withPartialBlockers(trackingValidated, trackingValidated.data?.landingPageViews === null ? ['tracking_landing_page_views_unavailable'] : [])
  const capi = normalizeSimple(
    capiRaw,
    (value) =>
      isRecord(value) &&
      ['off', 'shadow', 'live', 'unknown'].includes(String(value.mode)) &&
      validNumericRecord(value, ['eligibleAppointments', 'sentAppointments', 'failedAppointments', 'expiredAppointments']) &&
      (value.acceptedAppointments === null || isNonNegative(value.acceptedAppointments)),
    'capi_source_data_invalid',
  )
  const gaIdentity = normalizeSimple(
    gaIdentityRaw,
    (value) =>
      validNumericRecord(value, [
        'confirmationEvents',
        'identifiedEvents',
        'legacyUnlinkedEvents',
        'duplicateAppointments',
        'unmatchedAppointmentIds',
        'websiteBookingsMissingGa',
        'unknownOriginAppointments',
      ]) && ['exact_appointment_join', 'legacy_unlinked', 'mixed_partial_coverage', 'no_events_observed', 'pending_configuration', 'unavailable'].includes(String(value.scope)),
    'ga_identity_source_data_invalid',
  )
  const paidCohort = normalizePaidCohort(paidCohortRaw)
  const namedSources = [
    ['setup_changes', setup],
    ['outcomes', outcomes],
    ['meta', meta],
    ['meta_cold_warm', metaColdWarm],
    ['meta_placements', metaPlacements],
    ['tracking', tracking],
    ['capi', capi],
    ['ga_identity', gaIdentity],
    ['paid_cohort', paidCohort],
  ] as const
  const blockerCodes = unique([
    ...namedSources.flatMap(([name, read]) => read.state.blockerCodes.map((code) => `${name}:${code}`)),
    ...windows.postChange.blockerCodes.map((code) => `windows:${code}`),
  ])

  return {
    contract: 'executive_evidence_snapshot',
    version: 1,
    generatedAt: input.asOf,
    account: {
      id: input.accountId,
      name: input.accountName,
      timezone: input.timezone,
    },
    asOf: input.asOf,
    lastCompleteDate: input.lastCompleteDate,
    windows,
    sources: {
      setupChanges: sourceState(setup),
      outcomes: sourceState(outcomes),
      meta: sourceState(meta),
      metaColdWarm: sourceState(metaColdWarm),
      metaPlacements: sourceState(metaPlacements),
      tracking: sourceState(tracking),
      capi: sourceState(capi),
      gaIdentity: sourceState(gaIdentity),
      paidCohort: sourceState(paidCohort),
    },
    outcomes: outcomes.data,
    meta: meta.data,
    metaColdWarm: metaColdWarm.data,
    metaPlacements: metaPlacements.data,
    tracking: tracking.data,
    capi: capi.data,
    gaIdentity: gaIdentity.data,
    paidCohort: paidCohort.data,
    setupChanges: setup.data,
    authority: {
      tier: 'diagnostic_only',
      moneyActionsAuthorized: false,
      reason: 'Evidence is descriptive; governed action authority is not connected to this snapshot.',
    },
    governedActions: {
      availability: 'unavailable',
      items: null,
      blockerCodes: ['governed_actions_not_connected'],
    },
    blockerCodes,
  }
}
