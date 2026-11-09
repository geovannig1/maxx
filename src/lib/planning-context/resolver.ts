import type { getAdminClient } from '@/lib/supabase/admin'
import { z } from 'zod'
import {
  businessContextDocumentV1Schema,
  hashCanonicalDocument,
  landingPageSnapshotDocumentV1Schema,
  normalizeCanonicalUrl,
  type BusinessContextDocumentV1,
  type LandingPageSnapshotDocumentV1,
} from './contracts'

export type BusinessContextStatus =
  | 'approved_current'
  | 'missing'
  | 'unapproved'
  | 'withdrawn'
  | 'review_expired'
  | 'invalid_document'
  | 'integrity_mismatch'
  | 'newer_unapproved'
  | 'account_mismatch'
  | 'read_failed'

export type LandingPageStatus =
  | 'approved_current'
  | 'url_required'
  | 'missing'
  | 'unapproved'
  | 'withdrawn'
  | 'review_expired'
  | 'invalid_document'
  | 'integrity_mismatch'
  | 'newer_unapproved'
  | 'business_context_conflict'
  | 'account_mismatch'
  | 'read_failed'

export type PlanningContextBlockerCode =
  | 'planning_context_read_failed'
  | 'planning_context_account_mismatch'
  | 'business_context_missing'
  | 'business_context_unapproved'
  | 'business_context_withdrawn'
  | 'business_context_review_expired'
  | 'business_context_invalid_document'
  | 'business_context_integrity_mismatch'
  | 'business_context_newer_unapproved'
  | 'landing_page_url_required'
  | 'landing_page_url_invalid'
  | 'landing_page_snapshot_missing'
  | 'landing_page_snapshot_unapproved'
  | 'landing_page_snapshot_withdrawn'
  | 'landing_page_review_expired'
  | 'landing_page_invalid_document'
  | 'landing_page_integrity_mismatch'
  | 'landing_page_newer_unapproved'
  | 'landing_page_business_context_conflict'

export interface BusinessContextVersionRow {
  id: string
  ad_account_id: string
  schema_version: number
  document: unknown
  content_hash: string
  created_at: string
}

export interface BusinessContextApprovalRow {
  id: string
  ad_account_id: string
  artifact_id: string
  artifact_hash: string
  decision: 'approved' | 'withdrawn'
  revision: number
  review_due_at: string | null
}

export interface LandingPageSnapshotRow {
  id: string
  ad_account_id: string
  requested_url: string
  final_url: string
  canonical_url: string
  schema_version: number
  document: unknown
  content_hash: string
  created_at: string
}

export interface LandingPageApprovalRow {
  id: string
  ad_account_id: string
  artifact_id: string
  artifact_hash: string
  canonical_url: string
  business_context_approval_id: string | null
  decision: 'approved' | 'withdrawn'
  revision: number
  review_due_at: string | null
}

export type BusinessContextReviewRow = BusinessContextVersionRow & {
  revision: number
  source_kind: string
  source_ref: string
  captured_at: string
  dedupe_key: string
}

export type BusinessContextDecisionReviewRow = BusinessContextApprovalRow & {
  previous_approval_id: string | null
  reviewed_by: string
  reason: string
  dedupe_key: string
  created_at: string
}

export type LandingPageReviewRow = LandingPageSnapshotRow & {
  revision: number
  source_kind: string
  source_ref: string
  captured_at: string
  dedupe_key: string
}

export type LandingPageDecisionReviewRow = LandingPageApprovalRow & {
  previous_approval_id: string | null
  reviewed_by: string
  reason: string
  dedupe_key: string
  created_at: string
}

export interface PlanningContextReviewSnapshot {
  latest_business_observation: BusinessContextReviewRow | null
  latest_business_decision: BusinessContextDecisionReviewRow | null
  approved_business_observation: BusinessContextReviewRow | null
  latest_page_observation: LandingPageReviewRow | null
  latest_page_decision: LandingPageDecisionReviewRow | null
  approved_page_observation: LandingPageReviewRow | null
}

export interface PlanningContextEvaluationInput {
  now: Date
  adAccountId: string
  requestedLandingPageUrl: string | null
  latestBusinessObservation: BusinessContextVersionRow | null
  latestBusinessDecision: BusinessContextApprovalRow | null
  approvedBusinessObservation: BusinessContextVersionRow | null
  latestPageObservation: LandingPageSnapshotRow | null
  latestPageDecision: LandingPageApprovalRow | null
  approvedPageObservation: LandingPageSnapshotRow | null
  readError?: boolean
}

interface PlanningContextLineage {
  business_context: {
    status: BusinessContextStatus
    version_id: string | null
    approval_id: string | null
    content_hash: string | null
    document: BusinessContextDocumentV1 | null
  }
  landing_page: {
    status: LandingPageStatus
    canonical_url: string | null
    snapshot_id: string | null
    approval_id: string | null
    content_hash: string | null
    document: LandingPageSnapshotDocumentV1 | null
  }
}

export type GovernedPlanningContext =
  | (PlanningContextLineage & {
      status: 'approved_current'
      context_available_for_campaign_plan: true
      blocker_codes: []
      business_context: PlanningContextLineage['business_context'] & {
        status: 'approved_current'
        document: BusinessContextDocumentV1
      }
      landing_page: PlanningContextLineage['landing_page'] & {
        status: 'approved_current'
        document: LandingPageSnapshotDocumentV1
      }
    })
  | (PlanningContextLineage & {
      status: 'blocked'
      context_available_for_campaign_plan: false
      blocker_codes: PlanningContextBlockerCode[]
      business_context: PlanningContextLineage['business_context'] & { document: null }
      landing_page: PlanningContextLineage['landing_page'] & { document: null }
    })

export interface GovernedPlanningContextReview {
  evaluation: GovernedPlanningContext
  /** Owner-only workflow state. Never expose this snapshot through Maxx when evaluation is blocked. */
  snapshot: PlanningContextReviewSnapshot | null
}

const expired = (value: string | null, now: Date): boolean => {
  if (!value) return true
  const timestamp = new Date(value).getTime()
  return !Number.isFinite(timestamp) || timestamp <= now.getTime()
}

const normalizedUrlOrNull = (value: string): string | null => {
  try { return normalizeCanonicalUrl(value) } catch { return null }
}

function parsedBusinessObservation(row: BusinessContextVersionRow): {
  document: BusinessContextDocumentV1 | null
  failure: 'invalid_document' | 'integrity_mismatch' | null
} {
  const parsed = businessContextDocumentV1Schema.safeParse(row.document)
  if (!parsed.success || row.schema_version !== 1) {
    return { document: null, failure: 'invalid_document' }
  }
  if (hashCanonicalDocument(parsed.data) !== row.content_hash) {
    return { document: null, failure: 'integrity_mismatch' }
  }
  return { document: parsed.data, failure: null }
}

function parsedPageObservation(row: LandingPageSnapshotRow, requestedUrl: string): {
  document: LandingPageSnapshotDocumentV1 | null
  failure: 'invalid_document' | 'integrity_mismatch' | null
} {
  const storedUrl = normalizedUrlOrNull(row.canonical_url)
  if (storedUrl !== requestedUrl) return { document: null, failure: 'integrity_mismatch' }
  const parsed = landingPageSnapshotDocumentV1Schema.safeParse(row.document)
  if (!parsed.success || row.schema_version !== 1) {
    return { document: null, failure: 'invalid_document' }
  }
  if (
    hashCanonicalDocument(parsed.data) !== row.content_hash
    || normalizedUrlOrNull(row.requested_url) !== normalizedUrlOrNull(parsed.data.requested_url)
    || normalizedUrlOrNull(row.final_url) !== normalizedUrlOrNull(parsed.data.final_url)
    || normalizedUrlOrNull(parsed.data.canonical_url) !== requestedUrl
  ) {
    return { document: null, failure: 'integrity_mismatch' }
  }
  return { document: parsed.data, failure: null }
}

function businessResult(input: PlanningContextEvaluationInput): {
  status: BusinessContextStatus
  blocker: PlanningContextBlockerCode | null
  document: BusinessContextDocumentV1 | null
} {
  const latest = input.latestBusinessObservation
  const decision = input.latestBusinessDecision
  const approved = input.approvedBusinessObservation
  if (!latest) return { status: 'missing', blocker: 'business_context_missing', document: null }
  const latestParsed = parsedBusinessObservation(latest)
  if (latestParsed.failure === 'invalid_document') {
    return { status: 'invalid_document', blocker: 'business_context_invalid_document', document: null }
  }
  if (latestParsed.failure === 'integrity_mismatch') {
    return { status: 'integrity_mismatch', blocker: 'business_context_integrity_mismatch', document: null }
  }
  if (!decision) return { status: 'unapproved', blocker: 'business_context_unapproved', document: null }
  if (decision.decision === 'withdrawn') {
    return { status: 'withdrawn', blocker: 'business_context_withdrawn', document: null }
  }
  if (!approved || approved.id !== decision.artifact_id) {
    return { status: 'integrity_mismatch', blocker: 'business_context_integrity_mismatch', document: null }
  }
  const approvedParsed = parsedBusinessObservation(approved)
  if (approvedParsed.failure === 'invalid_document') {
    return { status: 'invalid_document', blocker: 'business_context_invalid_document', document: null }
  }
  if (approvedParsed.failure === 'integrity_mismatch' || decision.artifact_hash !== approved.content_hash) {
    return { status: 'integrity_mismatch', blocker: 'business_context_integrity_mismatch', document: null }
  }
  if (expired(decision.review_due_at, input.now)) {
    return { status: 'review_expired', blocker: 'business_context_review_expired', document: approvedParsed.document }
  }
  if (latest.id !== approved.id && latest.content_hash !== approved.content_hash) {
    return { status: 'newer_unapproved', blocker: 'business_context_newer_unapproved', document: approvedParsed.document }
  }
  return { status: 'approved_current', blocker: null, document: approvedParsed.document }
}

function pageResult(
  input: PlanningContextEvaluationInput,
  requestedUrl: string | null,
  business: ReturnType<typeof businessResult>,
): {
  status: LandingPageStatus
  blocker: PlanningContextBlockerCode | null
  document: LandingPageSnapshotDocumentV1 | null
} {
  if (!input.requestedLandingPageUrl) {
    return { status: 'url_required', blocker: 'landing_page_url_required', document: null }
  }
  if (!requestedUrl) {
    return { status: 'invalid_document', blocker: 'landing_page_url_invalid', document: null }
  }
  const latest = input.latestPageObservation
  const decision = input.latestPageDecision
  const approved = input.approvedPageObservation
  if (!latest) return { status: 'missing', blocker: 'landing_page_snapshot_missing', document: null }
  const latestParsed = parsedPageObservation(latest, requestedUrl)
  if (latestParsed.failure === 'invalid_document') {
    return { status: 'invalid_document', blocker: 'landing_page_invalid_document', document: null }
  }
  if (latestParsed.failure === 'integrity_mismatch') {
    return { status: 'integrity_mismatch', blocker: 'landing_page_integrity_mismatch', document: null }
  }
  if (!decision) return { status: 'unapproved', blocker: 'landing_page_snapshot_unapproved', document: null }
  if (decision.decision === 'withdrawn') {
    return { status: 'withdrawn', blocker: 'landing_page_snapshot_withdrawn', document: null }
  }
  if (
    !approved
    || approved.id !== decision.artifact_id
    || normalizedUrlOrNull(approved.canonical_url) !== requestedUrl
    || normalizedUrlOrNull(decision.canonical_url) !== requestedUrl
  ) {
    return { status: 'integrity_mismatch', blocker: 'landing_page_integrity_mismatch', document: null }
  }
  const approvedParsed = parsedPageObservation(approved, requestedUrl)
  if (approvedParsed.failure === 'invalid_document') {
    return { status: 'invalid_document', blocker: 'landing_page_invalid_document', document: null }
  }
  if (
    approvedParsed.failure === 'integrity_mismatch'
    || decision.artifact_hash !== approved.content_hash
  ) {
    return { status: 'integrity_mismatch', blocker: 'landing_page_integrity_mismatch', document: null }
  }
  if (expired(decision.review_due_at, input.now)) {
    return { status: 'review_expired', blocker: 'landing_page_review_expired', document: approvedParsed.document }
  }
  if (latest.id !== approved.id && latest.content_hash !== approved.content_hash) {
    return { status: 'newer_unapproved', blocker: 'landing_page_newer_unapproved', document: approvedParsed.document }
  }
  const businessDocument = business.document
  const pageDocument = approvedParsed.document
  const offerIds = new Set(businessDocument?.offers.map((offer) => offer.id) ?? [])
  const claimsById = new Map(
    businessDocument?.approved_claims.map((claim) => [claim.id, claim] as const) ?? [],
  )
  const pageOfferIds = new Set(pageDocument?.offer_ids ?? [])
  const pageReferencesUnknownFact = !pageDocument
    || pageDocument.offer_ids.some((id) => !offerIds.has(id))
    || pageDocument.claim_ids.some((id) => {
      const claim = claimsById.get(id)
      return !claim || !claim.offer_ids.some((offerId) => pageOfferIds.has(offerId))
    })
  if (
    business.status !== 'approved_current'
    || decision.business_context_approval_id !== input.latestBusinessDecision?.id
    || pageReferencesUnknownFact
  ) {
    return {
      status: 'business_context_conflict',
      blocker: 'landing_page_business_context_conflict',
      document: pageDocument,
    }
  }
  return { status: 'approved_current', blocker: null, document: pageDocument }
}

export function evaluateGovernedPlanningContext(input: PlanningContextEvaluationInput): GovernedPlanningContext {
  if (input.readError) {
    return {
      status: 'blocked',
      context_available_for_campaign_plan: false,
      blocker_codes: ['planning_context_read_failed'],
      business_context: {
        status: 'read_failed', version_id: null, approval_id: null, content_hash: null, document: null,
      },
      landing_page: {
        status: 'read_failed', canonical_url: null, snapshot_id: null, approval_id: null,
        content_hash: null, document: null,
      },
    }
  }

  const rows = [
    input.latestBusinessObservation,
    input.latestBusinessDecision,
    input.approvedBusinessObservation,
    input.latestPageObservation,
    input.latestPageDecision,
    input.approvedPageObservation,
  ].filter((row): row is NonNullable<typeof row> => row != null)
  if (!input.adAccountId || rows.some((row) => row.ad_account_id !== input.adAccountId)) {
    return {
      status: 'blocked',
      context_available_for_campaign_plan: false,
      blocker_codes: ['planning_context_account_mismatch'],
      business_context: {
        status: 'account_mismatch', version_id: null, approval_id: null, content_hash: null, document: null,
      },
      landing_page: {
        status: 'account_mismatch', canonical_url: null, snapshot_id: null, approval_id: null,
        content_hash: null, document: null,
      },
    }
  }

  let requestedUrl: string | null = null
  if (input.requestedLandingPageUrl) {
    try { requestedUrl = normalizeCanonicalUrl(input.requestedLandingPageUrl) } catch { requestedUrl = null }
  }
  const business = businessResult(input)
  const page = pageResult(input, requestedUrl, business)
  const blockers = [business.blocker, page.blocker].filter(
    (value): value is PlanningContextBlockerCode => value != null,
  )
  const ready = business.status === 'approved_current' && page.status === 'approved_current'
  const lineage = {
    business_context: {
      status: business.status,
      version_id: input.approvedBusinessObservation?.id ?? null,
      approval_id: input.latestBusinessDecision?.decision === 'approved'
        ? input.latestBusinessDecision.id
        : null,
      content_hash: input.approvedBusinessObservation?.content_hash ?? null,
      document: business.document,
    },
    landing_page: {
      status: page.status,
      canonical_url: requestedUrl,
      snapshot_id: input.approvedPageObservation?.id ?? null,
      approval_id: input.latestPageDecision?.decision === 'approved' ? input.latestPageDecision.id : null,
      content_hash: input.approvedPageObservation?.content_hash ?? null,
    },
  }

  if (!ready || !business.document || !page.document) {
    return {
      status: 'blocked',
      context_available_for_campaign_plan: false,
      blocker_codes: blockers,
      business_context: { ...lineage.business_context, document: null },
      landing_page: { ...lineage.landing_page, document: null },
    }
  }

  return {
    status: 'approved_current',
    context_available_for_campaign_plan: true,
    blocker_codes: [],
    business_context: {
      ...lineage.business_context,
      status: 'approved_current',
      document: business.document,
    },
    landing_page: {
      ...lineage.landing_page,
      status: 'approved_current',
      document: page.document,
    },
  }
}

type PlanningContextDb = ReturnType<typeof getAdminClient>

const businessVersionRowSchema = z.object({
  id: z.string(),
  ad_account_id: z.string(),
  revision: z.number().int(),
  schema_version: z.number().int(),
  document: z.unknown(),
  content_hash: z.string(),
  source_kind: z.string(),
  source_ref: z.string(),
  captured_at: z.string(),
  dedupe_key: z.string(),
  created_at: z.string(),
})
const businessApprovalRowSchema = z.object({
  id: z.string(),
  ad_account_id: z.string(),
  artifact_id: z.string(),
  artifact_hash: z.string(),
  decision: z.enum(['approved', 'withdrawn']),
  revision: z.number().int(),
  previous_approval_id: z.string().nullable(),
  reviewed_by: z.string(),
  reason: z.string(),
  review_due_at: z.string().nullable(),
  dedupe_key: z.string(),
  created_at: z.string(),
})
const pageSnapshotRowSchema = z.object({
  id: z.string(),
  ad_account_id: z.string(),
  requested_url: z.string(),
  final_url: z.string(),
  canonical_url: z.string(),
  revision: z.number().int(),
  schema_version: z.number().int(),
  document: z.unknown(),
  content_hash: z.string(),
  source_kind: z.string(),
  source_ref: z.string(),
  captured_at: z.string(),
  dedupe_key: z.string(),
  created_at: z.string(),
})
const pageApprovalRowSchema = z.object({
  id: z.string(),
  ad_account_id: z.string(),
  artifact_id: z.string(),
  artifact_hash: z.string(),
  canonical_url: z.string(),
  business_context_approval_id: z.string().nullable(),
  decision: z.enum(['approved', 'withdrawn']),
  revision: z.number().int(),
  previous_approval_id: z.string().nullable(),
  reviewed_by: z.string(),
  reason: z.string(),
  review_due_at: z.string().nullable(),
  dedupe_key: z.string(),
  created_at: z.string(),
})
const planningContextSnapshotSchema = z.object({
  latest_business_observation: businessVersionRowSchema.nullable(),
  latest_business_decision: businessApprovalRowSchema.nullable(),
  approved_business_observation: businessVersionRowSchema.nullable(),
  latest_page_observation: pageSnapshotRowSchema.nullable(),
  latest_page_decision: pageApprovalRowSchema.nullable(),
  approved_page_observation: pageSnapshotRowSchema.nullable(),
}).strict()

function failedContextReview(
  adAccountId: string,
  requestedLandingPageUrl: string | null,
  now: Date,
): GovernedPlanningContextReview {
  return {
    evaluation: evaluateGovernedPlanningContext({
      now,
      adAccountId,
      requestedLandingPageUrl,
      latestBusinessObservation: null,
      latestBusinessDecision: null,
      approvedBusinessObservation: null,
      latestPageObservation: null,
      latestPageDecision: null,
      approvedPageObservation: null,
      readError: true,
    }),
    snapshot: null,
  }
}

export async function readGovernedPlanningContextReviewForAccount(
  db: PlanningContextDb,
  adAccountId: string,
  requestedLandingPageUrl: string | null,
  now = new Date(),
): Promise<GovernedPlanningContextReview> {
  if (!adAccountId) return failedContextReview(adAccountId, requestedLandingPageUrl, now)

  try {
    const canonicalUrl = requestedLandingPageUrl
      ? normalizedUrlOrNull(requestedLandingPageUrl)
      : null
    const snapshotRead = await db.rpc('read_governed_planning_context', {
      p_ad_account_id: adAccountId,
      p_canonical_url: canonicalUrl,
    })
    if (snapshotRead.error) throw snapshotRead.error
    const parsedSnapshot = planningContextSnapshotSchema.safeParse(snapshotRead.data)
    if (!parsedSnapshot.success) throw new Error('Malformed governed planning-context snapshot')
    const snapshot = parsedSnapshot.data

    const evaluation = evaluateGovernedPlanningContext({
      now,
      adAccountId,
      requestedLandingPageUrl,
      latestBusinessObservation: snapshot.latest_business_observation,
      latestBusinessDecision: snapshot.latest_business_decision,
      approvedBusinessObservation: snapshot.approved_business_observation,
      latestPageObservation: snapshot.latest_page_observation,
      latestPageDecision: snapshot.latest_page_decision,
      approvedPageObservation: snapshot.approved_page_observation,
    })
    if (
      evaluation.status === 'blocked'
      && evaluation.blocker_codes.includes('planning_context_account_mismatch')
    ) {
      return { evaluation, snapshot: null }
    }
    return { evaluation, snapshot }
  } catch {
    return failedContextReview(adAccountId, requestedLandingPageUrl, now)
  }
}

export async function resolveGovernedPlanningContextForAccount(
  db: PlanningContextDb,
  adAccountId: string,
  requestedLandingPageUrl: string | null,
  now = new Date(),
): Promise<GovernedPlanningContext> {
  return (await readGovernedPlanningContextReviewForAccount(
    db,
    adAccountId,
    requestedLandingPageUrl,
    now,
  )).evaluation
}
