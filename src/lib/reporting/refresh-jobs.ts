import { z } from 'zod'
import type { getAdminClient } from '@/lib/supabase/admin'
import type { ReportingPacket } from './contracts'
import { withReportingDeadline } from './deadline'
import {
  compactReportingPacket, CompactReportingPacketSchema, expandPacket, isCompactReportingPacket, type CompactReportingPacket,
} from './packet-format'
import {
  canonicalReportingJson, ReportingSnapshotScopeSchema, reportingFingerprint,
  storedReportingSnapshot, validateReportingPacketScope, validateReportingSnapshot, type ReportingSnapshot, type ReportingSnapshotScope,
} from './snapshot-contract'

export type ReportingRefreshDatabase = Pick<ReturnType<typeof getAdminClient>, 'from' | 'rpc'>
const failureCode = z.enum(['source_unavailable', 'invalid_report', 'storage_unavailable', 'interrupted'])
export type ReportingRefreshFailureCode = z.infer<typeof failureCode>
export interface ReportingRefreshJob {
  id: string
  scope: ReportingSnapshotScope
  scopeKey: string
  status: 'running' | 'complete' | 'failed'
  startedAt: string
  leaseExpiresAt: string
  leaseToken: string
  completedAt: string | null
  failureCode: ReportingRefreshFailureCode | null
  snapshotId: string | null
  progress: ReportingPacket | null
  /** The progress packet exactly as stored when it is v2, so a reply can send it without re-encoding. */
  storedProgress?: CompactReportingPacket
  createdAt: string
}

export class ReportingRefreshError extends Error {
  constructor(readonly kind: 'invalid' | 'unavailable') {
    super(kind === 'invalid' ? 'Reporting refresh could not be validated.' : 'Reporting refresh storage is temporarily unavailable.')
    this.name = 'ReportingRefreshError'
  }
}

const STORAGE_TIMEOUT_MS = 5_000
// Final publication validates the complete packet. Allow transport margin over
// its function-scoped 20s database budget; the 120s lease still fences writes.
const PUBLICATION_TIMEOUT_MS = 25_000
const LEASE_MS = 120_000
const MAX_PACKET_BYTES = 64 * 1024 * 1024
const uuid = z.string().uuid()
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestamp = z.string().datetime({ offset: true }).refine(value => {
  const fractional = value.match(/T\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? ''
  return !/[1-9]/.test(fractional.slice(3))
}).transform(value => new Date(value).toISOString())
const RowSchema = z.object({
  id: uuid, ad_account_id: uuid, source: z.enum(['meta', 'business', 'website', 'measurement']),
  scope_key: hash, scope_canonical: z.string(), status: z.enum(['running', 'complete', 'failed']),
  started_at: timestamp, lease_expires_at: timestamp, lease_token: uuid,
  completed_at: timestamp.nullable(), failure_code: failureCode.nullable(), snapshot_id: uuid.nullable(),
  progress_canonical: z.string().nullable(), progress_fingerprint: hash.nullable(),
  progress_at: timestamp.nullable(), created_at: timestamp,
}).strict()
const columns = 'id,ad_account_id,source,scope_key,scope_canonical,status,started_at,lease_expires_at,lease_token,completed_at,failure_code,snapshot_id,progress_canonical,progress_fingerprint,progress_at,created_at'

function checked<T>(operation: () => T): T {
  try { return operation() } catch { throw new ReportingRefreshError('invalid') }
}

function scopeIdentity(raw: ReportingSnapshotScope) {
  return checked(() => {
    const scope = ReportingSnapshotScopeSchema.parse(raw)
    return { scope, key: reportingFingerprint(scope), canonical: canonicalReportingJson(scope) }
  })
}

function canonicalContent(value: unknown): string {
  const canonical = canonicalReportingJson(value)
  if (Buffer.byteLength(canonical, 'utf8') > MAX_PACKET_BYTES) throw new ReportingRefreshError('invalid')
  return canonical
}

function validatePending(packet: unknown, scope: ReportingSnapshotScope, startedAt: string, observedUntil: string): ReportingPacket {
  return checked(() => {
    const value = validateReportingPacketScope(packet, scope, observedUntil)
    if (value.context.asOf !== startedAt || value.section !== 'meta'
      || value.result.state !== 'partial' || value.result.data?.detailState !== 'loading') {
      throw new ReportingRefreshError('invalid')
    }
    return value
  })
}

function validateRow(raw: unknown, scope: ReportingSnapshotScope): ReportingRefreshJob {
  return checked(() => {
    const row = RowSchema.parse(raw), identity = scopeIdentity(scope)
    const start = Date.parse(row.started_at), expiry = Date.parse(row.lease_expires_at)
    const completed = row.completed_at === null ? null : Date.parse(row.completed_at)
    if (row.ad_account_id !== scope.accountId || row.source !== scope.source
      || row.scope_key !== identity.key || row.scope_canonical !== identity.canonical
      || expiry - start !== LEASE_MS || row.created_at !== row.started_at
      || (completed !== null && completed < start)
      || (row.status === 'running' && (completed !== null || row.failure_code !== null || row.snapshot_id !== null))
      || (row.status === 'complete' && (completed === null || completed >= expiry || row.failure_code !== null || row.snapshot_id === null))
      || (row.status === 'failed' && (completed === null || row.failure_code === null || row.snapshot_id !== null))) {
      throw new ReportingRefreshError('invalid')
    }
    let progress: ReportingPacket | null = null
    let storedProgress: CompactReportingPacket | undefined
    if (row.progress_canonical === null) {
      if (row.progress_fingerprint !== null || row.progress_at !== null) throw new ReportingRefreshError('invalid')
    } else {
      if (Buffer.byteLength(row.progress_canonical, 'utf8') > MAX_PACKET_BYTES
        || row.progress_at === null || Date.parse(row.progress_at) < start || Date.parse(row.progress_at) >= expiry
        || (completed !== null && Date.parse(row.progress_at) > completed)) throw new ReportingRefreshError('invalid')
      const decoded: unknown = JSON.parse(row.progress_canonical)
      if (canonicalContent(decoded) !== row.progress_canonical || reportingFingerprint(decoded) !== row.progress_fingerprint) {
        throw new ReportingRefreshError('invalid')
      }
      storedProgress = isCompactReportingPacket(decoded) ? CompactReportingPacketSchema.parse(decoded) : undefined
      progress = validatePending(storedProgress ? expandPacket(storedProgress) : decoded, scope, row.started_at, row.progress_at)
    }
    return {
      id: row.id, scope: identity.scope, scopeKey: row.scope_key, status: row.status,
      startedAt: row.started_at, leaseExpiresAt: row.lease_expires_at, leaseToken: row.lease_token,
      completedAt: row.completed_at, failureCode: row.failure_code, snapshotId: row.snapshot_id,
      progress, ...(storedProgress ? { storedProgress } : {}), createdAt: row.created_at,
    }
  })
}

function validateOwnership(job: ReportingRefreshJob): ReportingSnapshotScope {
  return checked(() => {
    uuid.parse(job.id); uuid.parse(job.leaseToken)
    timestamp.parse(job.startedAt); timestamp.parse(job.leaseExpiresAt)
    const identity = scopeIdentity(job.scope)
    if (job.scopeKey !== identity.key) throw new ReportingRefreshError('invalid')
    return identity.scope
  })
}

async function rpc(db: ReportingRefreshDatabase, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  try {
    return await withReportingDeadline(async childSignal => {
      const { data, error } = await db.rpc(name, args).abortSignal(childSignal)
      if (error) throw new ReportingRefreshError('unavailable')
      return data
    }, name === 'finish_reporting_refresh' ? PUBLICATION_TIMEOUT_MS : STORAGE_TIMEOUT_MS, signal)
  } catch { throw new ReportingRefreshError('unavailable') }
}

export async function claimReportingRefresh(
  db: ReportingRefreshDatabase, rawScope: ReportingSnapshotScope, force: boolean, signal?: AbortSignal,
): Promise<{ claimed: boolean; job: ReportingRefreshJob | null }> {
  const { scope, canonical } = scopeIdentity(rawScope)
  checked(() => z.boolean().parse(force))
  const data = await rpc(db, 'claim_reporting_refresh', { p_scope_canonical: canonical, p_force: force }, signal)
  return checked(() => {
    const result = z.object({ claimed: z.boolean(), job: z.unknown() }).strict().parse(data)
    const job = result.job === null ? null : validateRow(result.job, scope)
    if ((result.claimed && job === null) || (job && job.status !== 'running')) throw new ReportingRefreshError('invalid')
    return { claimed: result.claimed, job }
  })
}

/** Read-only, including expired/historical attempts. The route owns authorization. */
export async function readReportingRefreshJob(
  db: ReportingRefreshDatabase, rawScope: ReportingSnapshotScope, jobId?: string, signal?: AbortSignal,
): Promise<ReportingRefreshJob | null> {
  const { scope, key } = scopeIdentity(rawScope)
  if (jobId !== undefined) checked(() => uuid.parse(jobId))
  try {
    return await withReportingDeadline(async childSignal => {
      const scoped = db.from('reporting_refresh_jobs').select(columns)
        .eq('ad_account_id', scope.accountId).eq('source', scope.source).eq('scope_key', key)
      const query = jobId === undefined ? scoped : scoped.eq('id', jobId)
      const { data, error } = await query.order('started_at', { ascending: false }).order('id', { ascending: false })
        .limit(1).abortSignal(childSignal).maybeSingle()
      if (error) throw new ReportingRefreshError('unavailable')
      if (data === null) return null
      const job = validateRow(data, scope)
      if (jobId !== undefined && job.id !== jobId) throw new ReportingRefreshError('invalid')
      return job
    }, STORAGE_TIMEOUT_MS, signal)
  } catch (error) { throw error instanceof ReportingRefreshError ? error : new ReportingRefreshError('unavailable') }
}

export async function publishReportingRefreshProgress(
  db: ReportingRefreshDatabase, job: ReportingRefreshJob, raw: ReportingPacket,
): Promise<boolean> {
  const scope = validateOwnership(job)
  const packet = validatePending(raw, scope, job.startedAt, new Date().toISOString())
  const content = checked(() => canonicalContent(compactReportingPacket(packet)))
  const result = await rpc(db, 'publish_reporting_refresh_progress', { p_job: job.id, p_token: job.leaseToken, p_packet_canonical: content })
  return checked(() => z.boolean().parse(result))
}

export async function finishReportingRefresh(
  db: ReportingRefreshDatabase, job: ReportingRefreshJob, raw: ReportingSnapshot,
): Promise<{ committed: boolean; snapshotId: string | null }> {
  const scope = validateOwnership(job)
  const content = checked(() => {
    const snapshot = validateReportingSnapshot(raw, scope)
    if (snapshot.retrieval.startedAt !== job.startedAt) throw new ReportingRefreshError('invalid')
    return canonicalContent(storedReportingSnapshot(snapshot))
  })
  const data = await rpc(db, 'finish_reporting_refresh', { p_job: job.id, p_token: job.leaseToken, p_snapshot_canonical: content })
  return checked(() => {
    const result = z.object({ committed: z.boolean(), snapshot_id: uuid.nullable() }).strict().parse(data)
    if (result.committed !== (result.snapshot_id !== null)) throw new ReportingRefreshError('invalid')
    return { committed: result.committed, snapshotId: result.snapshot_id }
  })
}

export async function failReportingRefresh(
  db: ReportingRefreshDatabase, job: ReportingRefreshJob, code: ReportingRefreshFailureCode,
): Promise<boolean> {
  validateOwnership(job)
  checked(() => failureCode.parse(code))
  const result = await rpc(db, 'fail_reporting_refresh', { p_job: job.id, p_token: job.leaseToken, p_code: code })
  return checked(() => z.boolean().parse(result))
}
