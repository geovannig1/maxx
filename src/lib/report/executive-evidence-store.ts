import { createHash } from 'node:crypto'
import type { getAdminClient } from '@/lib/supabase/admin'
import type { ExecutiveEvidenceSnapshotV1 } from './executive-evidence'

type Db = ReturnType<typeof getAdminClient>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface ExecutiveEvidenceGenerationRefV1 {
  id: string
  fingerprint: string
}

export interface ExecutiveEvidenceGenerationIdentityV1 {
  id: string
  accountId: string
  reportDate: string
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Executive evidence contains a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error('Executive evidence contains an unsupported value.')
}

function fingerprint(snapshot: ExecutiveEvidenceSnapshotV1): string {
  return `sha256:${createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex')}`
}

function validateSnapshot(snapshot: ExecutiveEvidenceSnapshotV1): void {
  if (snapshot.contract !== 'executive_evidence_snapshot' || snapshot.version !== 1) {
    throw new Error('Executive evidence contract is not current.')
  }
  if (!UUID_PATTERN.test(snapshot.account.id)) {
    throw new Error('Executive evidence account identity is invalid.')
  }
  if (!DATE_PATTERN.test(snapshot.lastCompleteDate)) {
    throw new Error('Executive evidence report date is invalid.')
  }
  if (!Number.isFinite(Date.parse(snapshot.generatedAt))) {
    throw new Error('Executive evidence generated timestamp is invalid.')
  }
  if (snapshot.authority.tier !== 'diagnostic_only' || snapshot.authority.moneyActionsAuthorized !== false) {
    throw new Error('Executive evidence must remain diagnostic-only and cannot authorize money.')
  }
}

/** Commit one append-only evidence snapshot before any current daily or weekly digest references it. */
export async function commitExecutiveEvidenceGeneration(
  db: Db,
  snapshot: ExecutiveEvidenceSnapshotV1,
): Promise<ExecutiveEvidenceGenerationRefV1> {
  validateSnapshot(snapshot)
  const evidenceFingerprint = fingerprint(snapshot)
  const { data, error } = await db
    .from('executive_evidence_generations')
    .insert({
      ad_account_id: snapshot.account.id,
      report_date: snapshot.lastCompleteDate,
      contract_version: 1,
      evidence_json: snapshot,
      evidence_fingerprint: evidenceFingerprint,
      source_generated_at: snapshot.generatedAt,
    })
    .select('id')
    .single()
  if (error) throw new Error(`Executive evidence generation commit failed: ${error.message}`)
  const id = (data as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new Error('Executive evidence generation commit returned an invalid id.')
  }
  return { id, fingerprint: evidenceFingerprint }
}

/** Read one exact immutable generation. Identity is verified twice: in the SQL predicate and again
 * inside the stored contract so a malformed/cross-account row can never be projected as current. */
export async function readExecutiveEvidenceGeneration(
  db: Db,
  identity: ExecutiveEvidenceGenerationIdentityV1,
): Promise<ExecutiveEvidenceSnapshotV1> {
  if (!UUID_PATTERN.test(identity.id) || !UUID_PATTERN.test(identity.accountId)
    || !DATE_PATTERN.test(identity.reportDate)) {
    throw new Error('Executive evidence generation identity is invalid.')
  }
  const { data, error } = await db
    .from('executive_evidence_generations')
    .select('id, evidence_json')
    .eq('id', identity.id)
    .eq('ad_account_id', identity.accountId)
    .eq('report_date', identity.reportDate)
    .maybeSingle()
  if (error) throw new Error(`Executive evidence generation read failed: ${error.message}`)
  const row = data as { id?: unknown; evidence_json?: unknown } | null
  if (row?.id !== identity.id || typeof row.evidence_json !== 'object' || row.evidence_json === null) {
    throw new Error('Executive evidence generation is unavailable.')
  }
  const snapshot = row.evidence_json as ExecutiveEvidenceSnapshotV1
  validateSnapshot(snapshot)
  if (snapshot.account.id !== identity.accountId || snapshot.lastCompleteDate !== identity.reportDate) {
    throw new Error('Executive evidence generation identity does not match its stored contract.')
  }
  return snapshot
}
