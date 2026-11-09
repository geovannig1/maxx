import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import {
  businessContextDocumentV1Schema,
  containsSensitivePlanningContextData,
  hashCanonicalDocument,
  landingPageSnapshotDocumentV1Schema,
  normalizeCanonicalUrl,
  normalizeCtaDestination,
} from './contracts'

const sourceKindSchema = z.enum(['owner_entry', 'marketing_team_export', 'browser_probe', 'admin_import'])
const dedupeKeySchema = z.string().trim().min(1).max(200)
const contactEmailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const contactPhonePattern = /(?:^|[^\d])(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/
const nonSensitiveCommandText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !containsSensitivePlanningContextData(value)
    && !contactEmailPattern.test(value)
    && !contactPhonePattern.test(value),
  'governed command metadata must not contain secrets or personal contact data',
)
const canonicalHttpUrlSchema = z.string().refine((value) => {
  try {
    normalizeCanonicalUrl(value)
    return true
  } catch {
    return false
  }
}, 'URL must use HTTP or HTTPS and contain no credentials')
const reviewFields = {
  expected_previous_approval_id: z.string().uuid().nullable(),
  reason: nonSensitiveCommandText(2000),
  review_due_at: z.iso.datetime(),
  dedupe_key: dedupeKeySchema,
}

export const planningContextCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('commit_business'),
    document: businessContextDocumentV1Schema,
    source_kind: sourceKindSchema,
    source_ref: nonSensitiveCommandText(2000),
    captured_at: z.iso.datetime(),
    dedupe_key: dedupeKeySchema,
  }).strict(),
  z.object({
    action: z.literal('approve_business'),
    artifact_id: z.string().uuid(),
    ...reviewFields,
  }).strict(),
  z.object({
    action: z.literal('withdraw_business'),
    expected_current_approval_id: z.string().uuid(),
    reason: nonSensitiveCommandText(2000),
    dedupe_key: dedupeKeySchema,
  }).strict(),
  z.object({
    action: z.literal('commit_page'),
    document: landingPageSnapshotDocumentV1Schema,
    source_kind: sourceKindSchema,
    source_ref: nonSensitiveCommandText(2000),
    captured_at: z.iso.datetime(),
    dedupe_key: dedupeKeySchema,
  }).strict(),
  z.object({
    action: z.literal('approve_page'),
    artifact_id: z.string().uuid(),
    business_context_approval_id: z.string().uuid(),
    ...reviewFields,
  }).strict(),
  z.object({
    action: z.literal('withdraw_page'),
    canonical_url: canonicalHttpUrlSchema,
    expected_current_approval_id: z.string().uuid(),
    reason: nonSensitiveCommandText(2000),
    dedupe_key: dedupeKeySchema,
  }).strict(),
])

export type PlanningContextCommand = z.infer<typeof planningContextCommandSchema>
type PlanningContextDb = ReturnType<typeof getAdminClient>

export class PlanningContextStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function normalizeBusinessDocument(document: z.infer<typeof businessContextDocumentV1Schema>) {
  return {
    ...document,
    offers: document.offers.map((offer) => ({
      ...offer,
      booking_url: offer.booking_url ? normalizeCanonicalUrl(offer.booking_url) : null,
    })),
  }
}

function normalizePageDocument(document: z.infer<typeof landingPageSnapshotDocumentV1Schema>) {
  return {
    ...document,
    requested_url: normalizeCanonicalUrl(document.requested_url),
    final_url: normalizeCanonicalUrl(document.final_url),
    canonical_url: normalizeCanonicalUrl(document.canonical_url),
    ctas: document.ctas.map((cta) => ({
      ...cta,
      destination: cta.destination ? normalizeCtaDestination(cta.kind, cta.destination) : null,
    })),
  }
}

function mapRpcError(error: { message?: string } | null): PlanningContextStoreError {
  const message = error?.message ?? 'Governed planning-context command failed.'
  if (/requires (?:the sole|an) active ad account/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_ACTIVE_ACCOUNT_CHANGED', 409, message)
  }
  if (/dedupe collision/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_IDEMPOTENCY_COLLISION', 409, message)
  }
  if (/stale head/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_STALE_HEAD', 409, message)
  }
  if (/newer .* observation|not current/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_NEWER_OBSERVATION', 409, message)
  }
  if (/hash mismatch|integrity/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_INTEGRITY_MISMATCH', 409, message)
  }
  if (/not found|account mismatch/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_ARTIFACT_NOT_FOUND', 404, message)
  }
  if (/review deadline|future capture|runtime observation|provenance|source ref/i.test(message)) {
    return new PlanningContextStoreError('CONTEXT_INPUT_REJECTED', 400, message)
  }
  return new PlanningContextStoreError('CONTEXT_COMMAND_FAILED', 500, message)
}

async function callRpc(
  db: PlanningContextDb,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await db.rpc(name, params)
  if (error) throw mapRpcError(error)
  return data
}

const businessArtifactSchema = z.object({
  id: z.string().uuid(),
  ad_account_id: z.string().uuid(),
  schema_version: z.number().int(),
  document: z.unknown(),
  content_hash: z.string(),
})
const pageArtifactSchema = businessArtifactSchema.extend({
  requested_url: z.string(),
  final_url: z.string(),
  canonical_url: z.string(),
})

async function readArtifact(
  db: PlanningContextDb,
  table: 'business_context_versions' | 'landing_page_snapshots',
  accountId: string,
  artifactId: string,
): Promise<unknown> {
  const { data, error } = await db.from(table)
    .select(table === 'business_context_versions'
      ? 'id,ad_account_id,schema_version,document,content_hash'
      : 'id,ad_account_id,requested_url,final_url,canonical_url,schema_version,document,content_hash')
    .eq('ad_account_id', accountId)
    .eq('id', artifactId)
    .maybeSingle()
  if (error) throw new PlanningContextStoreError('CONTEXT_READ_FAILED', 503, 'Context artifact could not be read.')
  if (!data) throw new PlanningContextStoreError('CONTEXT_ARTIFACT_NOT_FOUND', 404, 'Context artifact was not found.')
  return data
}

async function verifiedBusinessArtifact(db: PlanningContextDb, accountId: string, artifactId: string) {
  const row = businessArtifactSchema.safeParse(await readArtifact(db, 'business_context_versions', accountId, artifactId))
  if (!row.success || row.data.ad_account_id !== accountId || row.data.schema_version !== 1) {
    throw new PlanningContextStoreError('CONTEXT_INTEGRITY_MISMATCH', 409, 'Business context artifact is malformed.')
  }
  const document = businessContextDocumentV1Schema.safeParse(row.data.document)
  if (!document.success || hashCanonicalDocument(document.data) !== row.data.content_hash) {
    throw new PlanningContextStoreError('CONTEXT_INTEGRITY_MISMATCH', 409, 'Business context digest does not match its document.')
  }
  return row.data
}

async function verifiedPageArtifact(db: PlanningContextDb, accountId: string, artifactId: string) {
  const row = pageArtifactSchema.safeParse(await readArtifact(db, 'landing_page_snapshots', accountId, artifactId))
  if (!row.success || row.data.ad_account_id !== accountId || row.data.schema_version !== 1) {
    throw new PlanningContextStoreError('CONTEXT_INTEGRITY_MISMATCH', 409, 'Landing-page artifact is malformed.')
  }
  const document = landingPageSnapshotDocumentV1Schema.safeParse(row.data.document)
  if (
    !document.success
    || hashCanonicalDocument(document.data) !== row.data.content_hash
    || normalizeCanonicalUrl(document.data.requested_url) !== normalizeCanonicalUrl(row.data.requested_url)
    || normalizeCanonicalUrl(document.data.final_url) !== normalizeCanonicalUrl(row.data.final_url)
    || normalizeCanonicalUrl(document.data.canonical_url) !== normalizeCanonicalUrl(row.data.canonical_url)
  ) {
    throw new PlanningContextStoreError('CONTEXT_INTEGRITY_MISMATCH', 409, 'Landing-page digest or URL does not match its document.')
  }
  return row.data
}

export async function executePlanningContextCommand(
  db: PlanningContextDb,
  accountId: string,
  actor: string,
  rawCommand: PlanningContextCommand,
): Promise<unknown> {
  const command = planningContextCommandSchema.parse(rawCommand)
  if (command.action === 'commit_business') {
    const document = normalizeBusinessDocument(command.document)
    return callRpc(db, 'commit_business_context_version', {
      p_ad_account_id: accountId,
      p_schema_version: document.schema_version,
      p_document: document,
      p_content_hash: hashCanonicalDocument(document),
      p_source_kind: command.source_kind,
      p_source_ref: command.source_ref,
      p_captured_at: command.captured_at,
      p_dedupe_key: command.dedupe_key,
    })
  }
  if (command.action === 'commit_page') {
    const document = normalizePageDocument(command.document)
    if (document.runtime.observed_at != null
      && new Date(document.runtime.observed_at).getTime() > new Date(command.captured_at).getTime()) {
      throw new PlanningContextStoreError(
        'CONTEXT_INPUT_REJECTED',
        400,
        'Landing-page runtime evidence cannot postdate its declared capture time.',
      )
    }
    return callRpc(db, 'commit_landing_page_snapshot', {
      p_ad_account_id: accountId,
      p_schema_version: document.schema_version,
      p_requested_url: document.requested_url,
      p_final_url: document.final_url,
      p_canonical_url: document.canonical_url,
      p_document: document,
      p_content_hash: hashCanonicalDocument(document),
      p_source_kind: command.source_kind,
      p_source_ref: command.source_ref,
      p_captured_at: command.captured_at,
      p_dedupe_key: command.dedupe_key,
    })
  }
  if (command.action === 'approve_business') {
    const artifact = await verifiedBusinessArtifact(db, accountId, command.artifact_id)
    return callRpc(db, 'approve_business_context_version', {
      p_ad_account_id: accountId,
      p_artifact_id: artifact.id,
      p_expected_hash: artifact.content_hash,
      p_expected_previous_approval_id: command.expected_previous_approval_id,
      p_reviewed_by: actor,
      p_reason: command.reason,
      p_review_due_at: command.review_due_at,
      p_dedupe_key: command.dedupe_key,
    })
  }
  if (command.action === 'approve_page') {
    const artifact = await verifiedPageArtifact(db, accountId, command.artifact_id)
    return callRpc(db, 'approve_landing_page_snapshot', {
      p_ad_account_id: accountId,
      p_artifact_id: artifact.id,
      p_expected_hash: artifact.content_hash,
      p_business_context_approval_id: command.business_context_approval_id,
      p_expected_previous_approval_id: command.expected_previous_approval_id,
      p_reviewed_by: actor,
      p_reason: command.reason,
      p_review_due_at: command.review_due_at,
      p_dedupe_key: command.dedupe_key,
    })
  }
  if (command.action === 'withdraw_business') {
    return callRpc(db, 'withdraw_business_context_approval', {
      p_ad_account_id: accountId,
      p_expected_current_approval_id: command.expected_current_approval_id,
      p_reviewed_by: actor,
      p_reason: command.reason,
      p_dedupe_key: command.dedupe_key,
    })
  }
  return callRpc(db, 'withdraw_landing_page_approval', {
    p_ad_account_id: accountId,
    p_canonical_url: normalizeCanonicalUrl(command.canonical_url),
    p_expected_current_approval_id: command.expected_current_approval_id,
    p_reviewed_by: actor,
    p_reason: command.reason,
    p_dedupe_key: command.dedupe_key,
  })
}
