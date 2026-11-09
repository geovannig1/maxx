import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  buildPaidCohortGeneration,
  type PaidAppointmentCohortInput,
  type PaidCohortCompletenessManifestInput,
  type PaidCohortGenerationPayload,
  type PaidCohortInsightInput,
  type PaidTouchCohortInput,
  type PaidTouchLinkCohortInput,
} from './paid-cohort'
import {
  PAID_COHORT_POLICY,
  PAID_COHORT_COMPLETENESS_MANIFEST_POLICY,
  PAID_MEASUREMENT_ACTIVATION_POLICY,
  resolvePaidCohortWindowsFromActivation,
} from './paid-cohort-policy'
import { PaidCohortStoreError } from './paid-cohort-reader'
import { readEnabledOutcomeSources } from '@/lib/outcomes/source-health'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'

const PAGE_SIZE = 1000
const MAX_PAGES_PER_QUERY = 100
const APPOINTMENT_ID_CHUNK = 200
const UTC_QUERY_PADDING_MS = 36 * 3_600_000

const iso = z.string().datetime({ offset: true })
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const numeric = z.union([
  z.number().finite().nonnegative(),
  z.string().regex(/^\d+(?:\.\d+)?$/),
  z.null(),
])
const safeInteger = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d+$/).transform((value, context) => {
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed)) {
      context.addIssue({ code: 'custom', message: 'integer exceeds the safe range' })
      return z.NEVER
    }
    return parsed
  }),
])

const accountSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().min(1).max(128),
  timezone_name: z.string().min(1).max(128),
  is_active: z.literal(true),
}).strict()

const activationSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  activated_at: iso,
  contract_version: z.literal(PAID_MEASUREMENT_ACTIVATION_POLICY.contractVersion),
  policy_version: z.literal(PAID_MEASUREMENT_ACTIVATION_POLICY.policyVersion),
}).strict()

const insightSchema = z.object({
  id: z.string().uuid(),
  date_start: dateOnly,
  entity_level: z.enum(['account', 'ad']),
  meta_campaign_id: z.string().nullable(),
  meta_adset_id: z.string().nullable(),
  meta_ad_id: z.string().nullable(),
  spend: numeric,
  landing_page_views: numeric,
  synced_at: iso.nullable(),
}).strict()

const touchSchema = z.object({
  id: z.string().uuid(),
  observed_at: iso,
  identity_complete: z.boolean(),
  meta_campaign_id: z.string().nullable(),
  meta_adset_id: z.string().nullable(),
  meta_ad_id: z.string().nullable(),
  // Carried ONLY to count distinct clicks per ad. fbclid identifies the click; a reload or SPA
  // navigation re-POSTs the same click and writes another observation row, so rows > clicks.
  fbclid: z.string().nullable(),
}).strict()

const linkSchema = z.object({
  id: z.string().uuid(),
  outcome_id: z.string().uuid(),
  last_touch_id: z.string().uuid(),
  last_interaction_at: iso,
  linked_at: iso.nullable(),
}).strict()

const appointmentSchema = z.object({
  id: z.string().uuid(),
  gross_value: numeric,
  collected_value: numeric,
  status: z.string(),
  synced_at: iso.nullable(),
}).strict()

const manifestSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  evaluation_run_id: z.string().uuid(),
  cohort_kind: z.enum(['recent_scale', 'matured_cut']),
  window_start: dateOnly,
  window_end: dateOnly,
  source_not_before: iso,
  capture_completed_at: iso,
  linker_completed_at: iso,
  contract_version: z.literal(PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.contractVersion),
  policy_version: z.literal(PAID_COHORT_COMPLETENESS_MANIFEST_POLICY.policyVersion),
  capture_complete: z.boolean(),
  linker_complete: z.boolean(),
  capture_eligible_inputs: safeInteger,
  captured_touches: safeInteger,
  eligible_outcomes: safeInteger,
  evaluated_outcomes: safeInteger,
  linked_outcomes: safeInteger,
  blocker_codes: z.array(z.string().trim().min(1).max(128)).refine(
    (values) => new Set(values).size === values.length,
    'blocker codes must be unique',
  ),
}).strict()

const publicationResultSchema = z.object({
  evaluation_run_id: z.string().uuid(),
  recent_generation_id: z.string().uuid(),
  matured_generation_id: z.string().uuid(),
}).strict()

export interface PaidCohortPublicationContext {
  evaluationRunId: string
  asOfDate: string
  sourceNotBefore: string
  appointmentSourceComplete: boolean
  appointmentSourceHead: string | null
  appointmentSourceWindowBasis: 'booking_date_et' | null
  appointmentSourceWindowStart: string | null
  appointmentSourceWindowEnd: string | null
}

export interface PublishedPaidCohortPair {
  evaluationRunId: string
  recentGenerationId: string
  maturedGenerationId: string
  recent: PaidCohortGenerationPayload
  matured: PaidCohortGenerationPayload
}

type QueryBuilder = ReturnType<ReturnType<SupabaseClient['from']>['select']>

function sourceReadError(table: string, reason: string): PaidCohortStoreError {
  return new PaidCohortStoreError('SOURCE_READ_FAILED', `${table} source read failed: ${reason}`)
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
        throw new PaidCohortStoreError('SOURCE_DATA_INVALID', `${args.table} returned a malformed row.`)
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

function paddedTimestampBounds(start: string, end: string): { start: string; end: string } {
  const startMs = new Date(`${start}T00:00:00.000Z`).getTime()
  const endMs = new Date(`${end}T23:59:59.999Z`).getTime()
  return {
    start: new Date(startMs - UTC_QUERY_PADDING_MS).toISOString(),
    end: new Date(endMs + UTC_QUERY_PADDING_MS).toISOString(),
  }
}

function deterministicGenerationId(evaluationRunId: string, kind: 'recent_scale' | 'matured_cut'): string {
  const bytes = createHash('sha256').update(`${evaluationRunId}:${kind}`, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Kinds of the enabled outcome sources that cannot carry an attribution token. A kind without an
 *  adapter counts as one: its rows cannot be linked either. */
async function readTokenlessSourceKinds(db: SupabaseClient, adAccountId: string): Promise<string[]> {
  let sources: Awaited<ReturnType<typeof readEnabledOutcomeSources>>
  try {
    sources = await readEnabledOutcomeSources(db, adAccountId)
  } catch (error) {
    throw sourceReadError('outcome_sources', error instanceof Error ? error.message : String(error))
  }
  const kinds = sources.filter((source) => getOutcomeAdapter(source.kind)?.capabilities.carriesToken !== true)
    .map((source) => source.kind)
  return [...new Set(kinds)].sort()
}

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
    throw new PaidCohortStoreError('SOURCE_DATA_INVALID', 'paid_measurement_activations returned a malformed row.')
  }
  return parsed.data
}

/** Outcome rows behind the links, in the builder's appointment vocabulary. The builder's numeric `id` is
 *  only a join key between links and outcomes, so it is the outcome uuid's 1-based position in the
 *  sorted id list: any source's external id (a numeric id, a webhook order id) works, and two
 *  sources sharing an external id stay two outcomes. `outcomeId` keeps the uuid for the link join. */
async function readAppointments(
  db: SupabaseClient,
  adAccountId: string,
  outcomeIds: string[],
): Promise<Array<PaidAppointmentCohortInput & { outcomeId: string }>> {
  const joinKey = new Map(outcomeIds.map((id, index) => [id, index + 1]))
  const rows: Array<PaidAppointmentCohortInput & { outcomeId: string }> = []
  for (let offset = 0; offset < outcomeIds.length; offset += APPOINTMENT_ID_CHUNK) {
    const ids = outcomeIds.slice(offset, offset + APPOINTMENT_ID_CHUNK)
    const page = await fetchPaged({
      db,
      table: 'outcomes',
      columns: 'id, gross_value, collected_value, status, synced_at',
      schema: appointmentSchema,
      configure: (query) => query.eq('ad_account_id', adAccountId).in('id', ids),
    })
    rows.push(...page.map((row) => ({
      outcomeId: row.id,
      // An id outside the requested list cannot match a link: it gets a key no link carries.
      id: joinKey.get(row.id) ?? 0,
      price: row.gross_value,
      amountPaid: row.collected_value,
      canceled: row.status === 'cancelled',
      syncedAt: row.synced_at,
    })))
  }
  return rows.sort((a, b) => a.id - b.id)
}

/** The source appointment id each link joins on. A link whose outcome the account-scoped read did not
 *  return still needs a key that matches NO appointment, so the builder records the same
 *  `appointment_state_missing` it did when the appointment read came back without it. Distinct
 *  outcomes get distinct negative keys, so duplicate-link detection is unchanged. */
function linkAppointmentIds(
  links: Array<{ outcome_id: string }>,
  appointments: Array<{ outcomeId: string; id: number }>,
): Map<string, number> {
  const byOutcome = new Map(appointments.map((row) => [row.outcomeId, row.id]))
  let missing = 0
  for (const outcomeId of [...new Set(links.map((row) => row.outcome_id))].sort()) {
    if (!byOutcome.has(outcomeId)) byOutcome.set(outcomeId, -(missing += 1))
  }
  return byOutcome
}

function manifestInput(row: z.infer<typeof manifestSchema>): PaidCohortCompletenessManifestInput {
  return {
    id: row.id,
    evaluationRunId: row.evaluation_run_id,
    cohortKind: row.cohort_kind,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    sourceNotBefore: row.source_not_before,
    captureCompletedAt: row.capture_completed_at,
    linkerCompletedAt: row.linker_completed_at,
    captureComplete: row.capture_complete,
    linkerComplete: row.linker_complete,
    captureEligibleInputs: row.capture_eligible_inputs,
    capturedTouches: row.captured_touches,
    eligibleAppointments: row.eligible_outcomes,
    evaluatedAppointments: row.evaluated_outcomes,
    linkedAppointments: row.linked_outcomes,
    blockerCodes: row.blocker_codes,
  }
}

export async function publishPaidCohortPair(
  db: SupabaseClient,
  adAccountId: string,
  context: PaidCohortPublicationContext,
): Promise<PublishedPaidCohortPair> {
  if (!z.string().uuid().safeParse(adAccountId).success
      || !z.string().uuid().safeParse(context.evaluationRunId).success) {
    throw new PaidCohortStoreError('INPUT_INVALID', 'Paid cohort account and evaluation run IDs must be UUIDs.')
  }

  const account = await readAccount(db, adAccountId)
  const activation = await readActivation(db, adAccountId)
  const tokenlessSourceKinds = await readTokenlessSourceKinds(db, adAccountId)

  const activationLocalDate = activation
    ? new Intl.DateTimeFormat('en-US', {
        timeZone: account.timezone_name,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(activation.activated_at))
        .reduce<Record<string, string>>((acc, part) => {
          acc[part.type] = part.value
          return acc
        }, {})
    : null
  const activationDate = activationLocalDate
    ? `${activationLocalDate.year}-${activationLocalDate.month}-${activationLocalDate.day}`
    : null

  let windows: ReturnType<typeof resolvePaidCohortWindowsFromActivation>
  try {
    windows = resolvePaidCohortWindowsFromActivation(context.asOfDate, activationDate)
  } catch (error) {
    throw new PaidCohortStoreError(
      'INPUT_INVALID', error instanceof Error ? error.message : 'Paid cohort as-of date is invalid.',
    )
  }
  const broad = { start: windows.maturedCut.start, end: windows.recentScale.end }
  const appointmentSourceCoversCohorts = context.appointmentSourceComplete
    && context.appointmentSourceWindowBasis === 'booking_date_et'
    && context.appointmentSourceWindowStart !== null
    && context.appointmentSourceWindowEnd !== null
    && context.appointmentSourceWindowStart <= broad.start
    && context.appointmentSourceWindowEnd >= broad.end
  const timeBounds = paddedTimestampBounds(broad.start, broad.end)

  const insights = await fetchPaged({
    db,
    table: 'daily_insights',
    columns: 'id, date_start, entity_level, meta_campaign_id, meta_adset_id, meta_ad_id, spend, landing_page_views, synced_at',
    schema: insightSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .in('entity_level', ['account', 'ad'])
      .gte('date_start', broad.start)
      .lte('date_start', broad.end),
  })
  const touches = await fetchPaged({
    db,
    table: 'paid_touch_observations',
    columns: 'id, observed_at, identity_complete, meta_campaign_id, meta_adset_id, meta_ad_id, fbclid',
    schema: touchSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .gte('observed_at', timeBounds.start)
      .lte('observed_at', timeBounds.end),
  })
  const links = await fetchPaged({
    db,
    table: 'outcome_touch_links',
    columns: 'id, outcome_id, last_touch_id, last_interaction_at, linked_at',
    schema: linkSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .gte('last_interaction_at', timeBounds.start)
      .lte('last_interaction_at', timeBounds.end),
  })
  const appointmentRows = await readAppointments(
    db,
    adAccountId,
    [...new Set(links.map((row) => row.outcome_id))].sort(),
  )
  const appointmentIdByOutcome = linkAppointmentIds(links, appointmentRows)
  const appointments = appointmentRows.map<PaidAppointmentCohortInput>((row) => {
    const { outcomeId, ...input } = row
    void outcomeId // the uuid is a join key only; the cohort input stays appointment-shaped
    return input
  })
  const completenessManifests = await fetchPaged({
    db,
    table: 'paid_cohort_completeness_manifests',
    columns: 'id, ad_account_id, evaluation_run_id, cohort_kind, window_start, window_end, source_not_before, capture_completed_at, linker_completed_at, contract_version, policy_version, capture_complete, linker_complete, capture_eligible_inputs, captured_touches, eligible_outcomes, evaluated_outcomes, linked_outcomes, blocker_codes',
    schema: manifestSchema,
    configure: (query) => query
      .eq('ad_account_id', adAccountId)
      .eq('evaluation_run_id', context.evaluationRunId),
  })
  const manifestsByKind = new Map<'recent_scale' | 'matured_cut', PaidCohortCompletenessManifestInput>()
  for (const row of completenessManifests) {
    if (manifestsByKind.has(row.cohort_kind)) {
      throw new PaidCohortStoreError(
        'SOURCE_DATA_INVALID',
        'paid_cohort_completeness_manifests returned duplicate cohort directions.',
      )
    }
    manifestsByKind.set(row.cohort_kind, manifestInput(row))
  }

  const shared = {
    accountMetaId: account.account_id,
    timezone: account.timezone_name,
    asOfDate: context.asOfDate,
    sourceNotBefore: context.sourceNotBefore,
    appointmentSourceComplete: appointmentSourceCoversCohorts,
    appointmentSourceHead: context.appointmentSourceHead,
    appointmentSourceWindowBasis: context.appointmentSourceWindowBasis,
    appointmentSourceWindowStart: context.appointmentSourceWindowStart,
    appointmentSourceWindowEnd: context.appointmentSourceWindowEnd,
    maturityLagDays: PAID_COHORT_POLICY.maturityLagDays,
    tokenlessSourceKinds,
    activation: activation ? { id: activation.id, activatedAt: activation.activated_at } : null,
    insights: insights.map<PaidCohortInsightInput>((row) => ({
      dateStart: row.date_start,
      entityLevel: row.entity_level,
      metaCampaignId: row.meta_campaign_id,
      metaAdsetId: row.meta_adset_id,
      metaAdId: row.meta_ad_id,
      spend: row.spend,
      landingPageViews: row.landing_page_views,
      syncedAt: row.synced_at,
    })),
    touches: touches.map<PaidTouchCohortInput>((row) => ({
      id: row.id,
      observedAt: row.observed_at,
      identityComplete: row.identity_complete,
      metaCampaignId: row.meta_campaign_id,
      metaAdsetId: row.meta_adset_id,
      metaAdId: row.meta_ad_id,
      fbclid: row.fbclid,
    })),
    links: links.map<PaidTouchLinkCohortInput>((row) => ({
      appointmentId: appointmentIdByOutcome.get(row.outcome_id)!,
      lastTouchId: row.last_touch_id,
      lastInteractionAt: row.last_interaction_at,
      linkedAt: row.linked_at,
    })),
    appointments,
  }

  const recent = buildPaidCohortGeneration({
    ...shared,
    generationId: deterministicGenerationId(context.evaluationRunId, 'recent_scale'),
    cohortKind: 'recent_scale',
    evaluationRunId: context.evaluationRunId,
    window: windows.recentScale,
    completenessManifest: manifestsByKind.get('recent_scale') ?? null,
  })
  const matured = buildPaidCohortGeneration({
    ...shared,
    generationId: deterministicGenerationId(context.evaluationRunId, 'matured_cut'),
    cohortKind: 'matured_cut',
    evaluationRunId: context.evaluationRunId,
    window: windows.maturedCut,
    completenessManifest: manifestsByKind.get('matured_cut') ?? null,
  })

  const { data, error } = await db.rpc('commit_paid_cohort_pair', {
    p_ad_account_id: adAccountId,
    p_evaluation_run_id: context.evaluationRunId,
    p_as_of_date: context.asOfDate,
    p_contract_version: PAID_COHORT_POLICY.contractVersion,
    p_policy_version: PAID_COHORT_POLICY.policyVersion,
    p_maturity_lag_days: PAID_COHORT_POLICY.maturityLagDays,
    p_generations: [recent, matured],
  })
  if (error) {
    throw new PaidCohortStoreError('PUBLICATION_FAILED', `Paid cohort publication failed: ${error.message}`)
  }
  const parsed = publicationResultSchema.safeParse(Array.isArray(data) ? data[0] : data)
  if (!parsed.success || parsed.data.evaluation_run_id !== context.evaluationRunId
      || parsed.data.recent_generation_id !== recent.id
      || parsed.data.matured_generation_id !== matured.id) {
    throw new PaidCohortStoreError('PUBLICATION_RESULT_INVALID', 'Paid cohort publication returned an invalid result.')
  }
  return {
    evaluationRunId: parsed.data.evaluation_run_id,
    recentGenerationId: parsed.data.recent_generation_id,
    maturedGenerationId: parsed.data.matured_generation_id,
    recent,
    matured,
  }
}

export {
  PaidCohortStoreError,
  paidCohortUnitKey,
  readLatestPaidCohortArtifact,
  readLatestPaidCohortPair,
  readLatestPaidCohortPairs,
  type PaidCohortDirectionArtifact,
  type PaidCohortEvaluationArtifact,
  type PaidCohortEvidence,
  type PaidCohortPairEvidence,
  type PaidCohortStoreErrorCode,
  type PaidCohortUnitRef,
} from './paid-cohort-reader'
