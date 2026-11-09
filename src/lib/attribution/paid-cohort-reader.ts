import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { PaidCohortBlockerCode } from './paid-cohort'
import { currencyFractionDigits } from '@/lib/utils/format-currency'
import {
  PAID_COHORT_POLICY,
  PAID_MEASUREMENT_ACTIVATION_POLICY,
  resolvePaidCohortWindowsFromActivation,
} from './paid-cohort-policy'

const PAGE_SIZE = 1000
const MAX_PAGES_PER_QUERY = 100

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`).getTime()
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value
})
const iso = z.string().datetime({ offset: true })
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER)
const FLOAT_MINOR_UNIT_EPSILON = 1e-9
/** Plain decimal money with at most `digits` decimals (none when the currency has no minor unit). */
const moneyPattern = (digits: number) => new RegExp(digits === 0 ? '^\\d{1,14}$' : `^\\d{1,14}(?:\\.\\d{1,${digits}})?$`)
// Money is validated at the account currency's minor unit (USD 2, JPY 0, KWD 3), read at parse time.
const nonnegativeNumber = z.union([z.number().finite().nonnegative(), z.string()])
  .transform((value, context) => {
    const digits = currencyFractionDigits()
    const scale = 10 ** digits
    const precisionMessage = `money must use at most ${digits} decimal places (the account currency's minor unit)`
    if (typeof value === 'number') {
      const minorUnits = Math.round(value * scale)
      const normalized = minorUnits / scale
      if (!Number.isSafeInteger(minorUnits) || Math.abs(value - normalized) > FLOAT_MINOR_UNIT_EPSILON) {
        context.addIssue({ code: 'custom', message: precisionMessage })
        return z.NEVER
      }
      return normalized
    }
    const raw = String(value)
    if (!moneyPattern(digits).test(raw)) {
      // Deliberately STRICT, and deliberately stricter than the number branch above.
      //
      // PostgREST returns `numeric` columns as strings, so this is the branch stored money arrives
      // through. A stored figure that is not whole minor units means the WRITER is broken, and it once
      // was: spend was accumulated in floating point and persisted as, e.g., 512.4000000000001.
      // Relaxing this to normalise epsilon drift was attempted and reverted — it would have hidden that
      // writer bug permanently instead of surfacing it. The repair belongs at the writer (`money()` in
      // paid-cohort.ts), and this staying loud is what forced it there.
      context.addIssue({ code: 'custom', message: precisionMessage })
      return z.NEVER
    }
    const [whole, fraction = ''] = raw.split('.')
    const minorUnits = BigInt(whole) * BigInt(scale) + BigInt(fraction.padEnd(digits, '0') || '0')
    if (minorUnits > MAX_SAFE_MINOR_UNITS) {
      context.addIssue({ code: 'custom', message: 'money exceeds safe minor-unit precision' })
      return z.NEVER
    }
    return Number(minorUnits) / scale
  })
const nullableNonnegativeNumber = nonnegativeNumber.nullable()
/**
 * A RATIO, not money. ROAS and CPA are quotients — 150 / 512.40 is 0.2927400468384075 — so the
 * two-decimal money contract does not apply to them and rejects every honest value. Validating
 * `revenue_roas` as money is what threw "The latest paid cohort generation is malformed" on every
 * recommendation run once outcome-source revenue began flowing and the quotient stopped being 0 or null.
 */
const nonnegativeRatio = z.number().finite().nonnegative()
const nullableNonnegativeRatio = nonnegativeRatio.nullable()
const safeInteger = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/),
]).transform((value, context) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    context.addIssue({ code: 'custom', message: 'integer exceeds the safe nonnegative range' })
    return z.NEVER
  }
  return parsed
})
const nullableSafeInteger = safeInteger.nullable()
const PAID_COHORT_BLOCKER_CODES = [
  'activation_missing', 'pre_activation_window', 'maturity_lag_not_met', 'invalid_timezone',
  'invalid_source_boundary', 'stale_insight_source', 'appointment_source_unavailable',
  'stale_appointment_state', 'missing_account_insight_days', 'duplicate_account_insights',
  'duplicate_ad_insights', 'invalid_insight_metrics', 'spend_reconciliation_failed',
  'incomplete_insight_identity', 'landing_page_views_unavailable', 'capture_coverage_mismatch',
  'paid_completeness_manifest_unavailable', 'paid_completeness_manifest_mismatch',
  'paid_capture_source_incomplete', 'paid_linker_source_incomplete',
  'incomplete_touch_identity', 'invalid_touch_time', 'duplicate_touch_id', 'orphan_link_touch',
  'link_touch_mismatch', 'appointment_state_missing', 'invalid_appointment_value',
  'invalid_appointment_revenue', 'source_cannot_carry_token',
] as const satisfies readonly [PaidCohortBlockerCode, ...PaidCohortBlockerCode[]]
const blockerCodesSchema = z.array(z.enum(PAID_COHORT_BLOCKER_CODES)).superRefine((codes, context) => {
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: 'custom', message: 'blocker codes must be unique' })
  }
})
const storedMetricsSchema = z.object({
  zero_value_bookings: safeInteger,
  canceled_links: safeInteger,
  outcome_recorded_revenue: nonnegativeNumber.optional(),
  // A quotient, validated as a quotient. `roas` and `cpa` are the same category and deliberately stay
  // on the catchall: zero rows have ever failed on either, and adding two new ways for this function
  // to throw — the function that took recommendations down 40 minutes earlier — would be speculative
  // defence against a hypothesis. `revenue_roas` is here because it has an OBSERVED failure, recorded
  // in api_sync_logs.
  revenue_roas: nullableNonnegativeRatio.optional(),
}).catchall(z.unknown())

/**
 * Render a Zod failure as `field: reason` pairs.
 *
 * These reads previously threw "…is malformed." with nothing else. Every other blocker in this system
 * names itself, and this one did not, so diagnosing a rejected row meant re-deriving the schema by hand
 * against the stored JSON — which produced wrong diagnoses before the actual field was found. The row's own values are NOT included: they are money and identity, and the field path
 * plus the rule that rejected it is what a reader needs.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}

function enforceCompleteContract(
  value: { complete: boolean; blocker_codes: readonly string[] },
  context: z.RefinementCtx,
): void {
  if (value.complete !== (value.blocker_codes.length === 0)) {
    context.addIssue({ code: 'custom', message: 'completeness does not match blocker codes' })
  }
}

function enforceGenerationContract(
  value: { activation_id: string | null; complete: boolean; blocker_codes: readonly string[] },
  context: z.RefinementCtx,
): void {
  enforceCompleteContract(value, context)
  if ((value.activation_id === null) !== value.blocker_codes.includes('activation_missing')) {
    context.addIssue({ code: 'custom', message: 'activation fact does not match activation blocker' })
  }
}

const storedGenerationSchema = z.object({
  id: z.string().uuid(),
  evaluation_run_id: z.string().uuid(),
  cohort_kind: z.enum(['recent_scale', 'matured_cut']),
  window_start: dateOnly,
  window_end: dateOnly,
  as_of_date: dateOnly,
  activation_id: z.string().uuid().nullable(),
  contract_version: z.literal(PAID_COHORT_POLICY.contractVersion),
  policy_version: z.literal(PAID_COHORT_POLICY.policyVersion),
  account_spend: nullableNonnegativeNumber,
  landing_page_views: nullableSafeInteger,
  captured_landing_views: safeInteger,
  complete: z.boolean(),
  blocker_codes: blockerCodesSchema,
  metrics: storedMetricsSchema,
  created_at: iso,
}).strict().superRefine(enforceGenerationContract)

const storedUnitSchema = z.object({
  id: z.string().uuid(),
  generation_id: z.string().uuid(),
  entity_level: z.enum(['account', 'campaign', 'adset', 'ad']),
  entity_id: z.string().min(1).max(128),
  spend: nullableNonnegativeNumber,
  landing_page_views: nullableSafeInteger,
  captured_touches: safeInteger,
  bookings: safeInteger,
  booked_value: nonnegativeNumber,
  complete: z.boolean(),
  blocker_codes: blockerCodesSchema,
  metrics: storedMetricsSchema,
}).strict().superRefine(enforceCompleteContract)

const unitRefSchema = z.object({
  entityLevel: z.enum(['account', 'campaign', 'adset', 'ad']),
  entityId: z.string().min(1).max(128).refine((value) => value.trim().length > 0),
}).strict()

/** Exported for diagnostics only: lets a harness validate stored rows with the REAL schema instead of
 *  a hand-written restatement of it, which is how wrong diagnoses get reached. */
export const PAID_COHORT_DIAGNOSTIC_SCHEMAS = {
  generation: storedGenerationSchema,
  unit: storedUnitSchema,
}

type StoredGeneration = z.infer<typeof storedGenerationSchema>
type StoredUnit = z.infer<typeof storedUnitSchema>
type QueryBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>

export type PaidCohortStoreErrorCode = 'INPUT_INVALID' | 'SOURCE_READ_FAILED'
  | 'SOURCE_DATA_INVALID' | 'SOURCE_PAGE_LIMIT_EXCEEDED'
  | 'PUBLICATION_FAILED' | 'PUBLICATION_RESULT_INVALID'

export class PaidCohortStoreError extends Error {
  constructor(
    public readonly code: PaidCohortStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PaidCohortStoreError'
  }
}

export interface PaidCohortUnitRef {
  entityLevel: 'account' | 'campaign' | 'adset' | 'ad'; entityId: string
}

export interface PaidCohortEvidence {
  generationId: string; cohortKind: 'recent_scale' | 'matured_cut'
  /** The durable cohort policy, never inferred from the manifest policy. */
  policyVersion?: number
  windowStart: string; windowEnd: string; asOfDate: string
  complete: boolean; blockerCodes: string[]
  generationComplete: boolean; generationBlockerCodes: string[]
  spend: number | null; bookings: number | null; bookedValue: number | null
  /** Account-unit population that the manifest must reconcile before it is consumable. */
  capturedTouches?: number
  /** Generation-level manifest population facts, retained separately from unit metrics. */
  generationMetrics?: Record<string, unknown>
  metrics: Record<string, unknown>
}

export interface PaidCohortPairEvidence {
  evaluationRunId: string; recentScale: PaidCohortEvidence; maturedCut: PaidCohortEvidence
}

export interface PaidCohortDirectionArtifact {
  generation: {
    generationId: string; cohortKind: 'recent_scale' | 'matured_cut'
    windowStart: string; windowEnd: string; asOfDate: string
    activationId: string | null; contractVersion: number; policyVersion: number; complete: boolean
    blockerCodes: string[]
  }
  adUnits: Array<{
    id: string; generationId: string; metaAdId: string
    spend: number | null; landingPageViews: number | null; capturedTouches: number
    bookings: number; bookedValue: number; complete: boolean; blockerCodes: string[]
    zeroValueBookings: number; canceledLinks: number
  }>
}

export interface PaidCohortEvaluationArtifact {
  evaluationRunId: string
  recentScale: PaidCohortDirectionArtifact; maturedCut: PaidCohortDirectionArtifact
}

interface StrictPaidCohortPair {
  evaluationRunId: string
  recent: StoredGeneration
  matured: StoredGeneration
  units: StoredUnit[]
  unitIndex: Map<string, StoredUnit>
}

function sourceReadError(table: string, reason: string): PaidCohortStoreError {
  return new PaidCohortStoreError('SOURCE_READ_FAILED', `${table} source read failed: ${reason}`)
}

const accountSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().min(1).max(128),
  timezone_name: z.string().min(1).max(128),
  is_active: z.literal(true),
}).strict()

const activationSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  activated_at: z.string().datetime({ offset: true }),
  contract_version: z.literal(PAID_MEASUREMENT_ACTIVATION_POLICY.contractVersion),
  policy_version: z.literal(PAID_MEASUREMENT_ACTIVATION_POLICY.policyVersion),
}).strict()

async function readAccount(db: SupabaseClient, adAccountId: string) {
  const result = await db.from('ad_accounts')
    .select('id, account_id, timezone_name, is_active')
    .eq('id', adAccountId)
    .eq('is_active', true)
    .maybeSingle()
  if (result.error) throw sourceReadError('ad_accounts', result.error.message)
  const parsed = accountSchema.safeParse(result.data)
  if (!parsed.success) {
    throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'The active ad account is missing or malformed.')
  }
  return parsed.data
}

async function readActivation(db: SupabaseClient, adAccountId: string) {
  const result = await db.from('paid_measurement_activations')
    .select('id, ad_account_id, activated_at, contract_version, policy_version')
    .eq('ad_account_id', adAccountId)
    .order('activated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
  if (result.error) throw sourceReadError('paid_measurement_activations', result.error.message)
  if (!Array.isArray(result.data)) {
    throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'paid_measurement_activations returned a non-array result.')
  }
  if (result.data.length === 0) return null
  const parsed = activationSchema.safeParse(result.data[0])
  if (!parsed.success) {
    throw new PaidCohortStoreError(
      'SOURCE_DATA_INVALID',
      `paid_measurement_activations returned a malformed row — ${describeIssues(parsed.error)}`,
    )
  }
  return parsed.data
}

function activationDateInTimezone(activation: { activated_at: string }, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(activation.activated_at))
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  } catch {
    return null
  }
}

async function fetchPaged<T>(args: {
  db: SupabaseClient
  table: string
  columns: string
  schema: z.ZodType<T>
  configure: (query: QueryBuilder) => QueryBuilder
}): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
    const from = page * PAGE_SIZE
    const result = await args.configure(args.db.from(args.table).select(args.columns))
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (result.error) throw sourceReadError(args.table, result.error.message)
    if (!Array.isArray(result.data)) {
      throw new PaidCohortStoreError('SOURCE_DATA_INVALID', `${args.table} returned a non-array result.`)
    }
    for (const raw of result.data) {
      const parsed = args.schema.safeParse(raw)
      if (!parsed.success) {
        throw new PaidCohortStoreError(
          'SOURCE_DATA_INVALID',
          `${args.table} returned a malformed row — ${describeIssues(parsed.error)}`,
        )
      }
      rows.push(parsed.data)
    }
    if (result.data.length < PAGE_SIZE) return rows
  }
  throw new PaidCohortStoreError(
    'SOURCE_PAGE_LIMIT_EXCEEDED',
    `${args.table} exceeded the audited ${PAGE_SIZE * MAX_PAGES_PER_QUERY}-row read bound.`,
  )
}

function generationColumns(): string {
  return 'id, evaluation_run_id, cohort_kind, window_start, window_end, as_of_date, activation_id, contract_version, policy_version, account_spend, landing_page_views, captured_landing_views, complete, blocker_codes, metrics, created_at'
}

function unitColumns(): string {
  return 'id, generation_id, entity_level, entity_id, spend, landing_page_views, captured_touches, bookings, booked_value, complete, blocker_codes, metrics'
}

function unitIndexKey(unit: Pick<StoredUnit, 'generation_id' | 'entity_level' | 'entity_id'>): string {
  return `${unit.generation_id}:${unit.entity_level}:${unit.entity_id}`
}

function matchesPolicyWindows(
  recent: StoredGeneration,
  matured: StoredGeneration,
  activationDate: string | null,
): boolean {
  try {
    const expected = resolvePaidCohortWindowsFromActivation(recent.as_of_date, activationDate)
    return recent.window_start === expected.recentScale.start
      && recent.window_end === expected.recentScale.end
      && matured.window_start === expected.maturedCut.start
      && matured.window_end === expected.maturedCut.end
  } catch {
    return false
  }
}

const ACTIVATION_BLOCKERS = ['activation_missing', 'pre_activation_window'] as const

function activationBlockersMatch(generation: StoredGeneration, unit: StoredUnit): boolean {
  return ACTIVATION_BLOCKERS.every((code) => (
    generation.blocker_codes.includes(code) === unit.blocker_codes.includes(code)
  ))
}

async function readStrictLatestPaidCohortPair(
  db: SupabaseClient,
  adAccountId: string,
): Promise<StrictPaidCohortPair | null> {
  if (!z.string().uuid().safeParse(adAccountId).success) {
    throw new PaidCohortStoreError('INPUT_INVALID', 'Paid cohort account ID must be a UUID.')
  }

  const latestResult = await db.from('paid_cohort_generations')
    .select(generationColumns())
    .eq('ad_account_id', adAccountId)
    .eq('cohort_kind', 'recent_scale')
    .eq('contract_version', PAID_COHORT_POLICY.contractVersion)
    .eq('policy_version', PAID_COHORT_POLICY.policyVersion)
    .order('as_of_date', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, 0)
  if (latestResult.error) throw sourceReadError('paid_cohort_generations', latestResult.error.message)
  if (!Array.isArray(latestResult.data)) {
    throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'paid_cohort_generations returned a non-array result.')
  }
  if (latestResult.data.length === 0) return null
  const latest = storedGenerationSchema.safeParse(latestResult.data[0])
  if (!latest.success || latest.data.cohort_kind !== 'recent_scale') {
    const detail = latest.success
      ? `cohort_kind was ${latest.data.cohort_kind}, expected recent_scale`
      : describeIssues(latest.error)
    throw new PaidCohortStoreError(
      'SOURCE_DATA_INVALID',
      `The latest paid cohort generation is malformed — ${detail}`,
    )
  }

  const account = await readAccount(db, adAccountId)
  const activation = await readActivation(db, adAccountId)
  const activationDate = activation ? activationDateInTimezone(activation, account.timezone_name) : null

  const generations = await fetchPaged({
    db,
    table: 'paid_cohort_generations',
    columns: generationColumns(),
    schema: storedGenerationSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .eq('evaluation_run_id', latest.data.evaluation_run_id)
      .eq('contract_version', PAID_COHORT_POLICY.contractVersion)
      .eq('policy_version', PAID_COHORT_POLICY.policyVersion),
  })
  const recent = generations.filter((row) => row.cohort_kind === 'recent_scale')
  const matured = generations.filter((row) => row.cohort_kind === 'matured_cut')
  if (generations.length !== 2 || recent.length !== 1 || matured.length !== 1
      || recent[0].id !== latest.data.id
      || recent[0].id === matured[0].id
      || recent[0].as_of_date !== matured[0].as_of_date
      || recent[0].activation_id !== matured[0].activation_id
      || !matchesPolicyWindows(recent[0], matured[0], activationDate)) {
    throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'The latest paid cohort evaluation is torn or duplicated.')
  }

  const units = await fetchPaged({
    db,
    table: 'paid_cohort_units',
    columns: unitColumns(),
    schema: storedUnitSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .in('generation_id', [recent[0].id, matured[0].id]),
  })
  const unitIndex = new Map<string, StoredUnit>()
  const unitIds = new Set<string>()
  for (const unit of units) {
    const key = unitIndexKey(unit)
    const generation = unit.generation_id === recent[0].id ? recent[0]
      : unit.generation_id === matured[0].id ? matured[0] : null
    if (unitIds.has(unit.id) || unitIndex.has(key) || !generation
        || !activationBlockersMatch(generation, unit)) {
      throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'A paid cohort contains malformed units.')
    }
    unitIds.add(unit.id)
    unitIndex.set(key, unit)
  }

  return {
    evaluationRunId: latest.data.evaluation_run_id,
    recent: recent[0],
    matured: matured[0],
    units,
    unitIndex,
  }
}

function evidenceFromStored(
  generation: StoredGeneration,
  unit: StoredUnit | null,
  ref: PaidCohortUnitRef,
): PaidCohortEvidence {
  if (!unit) {
    if (ref.entityLevel === 'account') {
      throw new PaidCohortStoreError(
        'SOURCE_DATA_INVALID',
        `Paid cohort generation ${generation.id} has no account unit.`,
      )
    }
    return {
      generationId: generation.id,
      cohortKind: generation.cohort_kind,
      policyVersion: generation.policy_version,
      windowStart: generation.window_start,
      windowEnd: generation.window_end,
      asOfDate: generation.as_of_date,
      complete: false,
      blockerCodes: ['unit_not_present'],
      generationComplete: generation.complete,
      generationBlockerCodes: [...generation.blocker_codes],
      spend: null,
      bookings: null,
      bookedValue: null,
      capturedTouches: undefined,
      generationMetrics: { ...generation.metrics },
      metrics: {},
    }
  }
  return {
    generationId: generation.id,
    cohortKind: generation.cohort_kind,
    policyVersion: generation.policy_version,
    windowStart: generation.window_start,
    windowEnd: generation.window_end,
    asOfDate: generation.as_of_date,
    complete: unit.complete,
    blockerCodes: [...unit.blocker_codes],
    generationComplete: generation.complete,
    generationBlockerCodes: [...generation.blocker_codes],
    spend: unit.spend,
    bookings: unit.bookings,
    bookedValue: unit.booked_value,
    capturedTouches: unit.captured_touches,
    generationMetrics: { ...generation.metrics },
    metrics: { ...unit.metrics },
  }
}

function directionArtifact(
  generation: StoredGeneration,
  units: StoredUnit[],
): PaidCohortDirectionArtifact {
  return {
    generation: {
      generationId: generation.id,
      cohortKind: generation.cohort_kind,
      windowStart: generation.window_start,
      windowEnd: generation.window_end,
      asOfDate: generation.as_of_date,
      activationId: generation.activation_id,
      contractVersion: generation.contract_version,
      policyVersion: generation.policy_version,
      complete: generation.complete,
      blockerCodes: [...generation.blocker_codes],
    },
    adUnits: units
      .filter((unit) => unit.generation_id === generation.id && unit.entity_level === 'ad')
      .map((unit) => ({
        id: unit.id,
        generationId: unit.generation_id,
        metaAdId: unit.entity_id,
        spend: unit.spend,
        landingPageViews: unit.landing_page_views,
        capturedTouches: unit.captured_touches,
        bookings: unit.bookings,
        bookedValue: unit.booked_value,
        complete: unit.complete,
        blockerCodes: [...unit.blocker_codes],
        zeroValueBookings: unit.metrics.zero_value_bookings,
        canceledLinks: unit.metrics.canceled_links,
      })),
  }
}

export function paidCohortUnitKey(ref: PaidCohortUnitRef): string {
  return `${ref.entityLevel}:${ref.entityId}`
}

export async function readLatestPaidCohortPairs(
  db: SupabaseClient,
  adAccountId: string,
  refs: PaidCohortUnitRef[],
): Promise<Map<string, PaidCohortPairEvidence> | null> {
  if (!z.array(unitRefSchema).min(1).safeParse(refs).success) {
    throw new PaidCohortStoreError('INPUT_INVALID', 'Paid cohort read scope is invalid.')
  }
  const pair = await readStrictLatestPaidCohortPair(db, adAccountId)
  if (!pair) return null

  const result = new Map<string, PaidCohortPairEvidence>()
  for (const ref of refs) {
    const unitFor = (generationId: string) => pair.unitIndex.get(
      `${generationId}:${ref.entityLevel}:${ref.entityId}`,
    ) ?? null
    result.set(paidCohortUnitKey(ref), {
      evaluationRunId: pair.evaluationRunId,
      recentScale: evidenceFromStored(pair.recent, unitFor(pair.recent.id), ref),
      maturedCut: evidenceFromStored(pair.matured, unitFor(pair.matured.id), ref),
    })
  }
  return result
}

export async function readLatestPaidCohortPair(
  db: SupabaseClient,
  adAccountId: string,
  ref: PaidCohortUnitRef,
): Promise<PaidCohortPairEvidence | null> {
  const pairs = await readLatestPaidCohortPairs(db, adAccountId, [ref])
  return pairs?.get(paidCohortUnitKey(ref)) ?? null
}

export async function readLatestPaidCohortArtifact(
  db: SupabaseClient,
  adAccountId: string,
): Promise<PaidCohortEvaluationArtifact | null> {
  const pair = await readStrictLatestPaidCohortPair(db, adAccountId)
  if (!pair) return null
  return {
    evaluationRunId: pair.evaluationRunId,
    recentScale: directionArtifact(pair.recent, pair.units),
    maturedCut: directionArtifact(pair.matured, pair.units),
  }
}
