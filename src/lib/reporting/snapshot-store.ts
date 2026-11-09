import { z } from 'zod'
import { LEGACY_BUDGET_AMOUNT_KEY, upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'
import type { getAdminClient } from '@/lib/supabase/admin'
import { withReportingDeadline } from './deadline'
import { CompactReportingPacketSchema, expandPacket, isCompactReportingPacket, type CompactReportingPacket } from './packet-format'
import { compactJsonTokens } from './compact-json'
import {
  canonicalReportingJson, ReportingSnapshotError, ReportingSnapshotScopeSchema,
  reportingFingerprint, validateReportingSnapshot, type ReportingSnapshot, type ReportingSnapshotScope,
} from './snapshot-contract'

export type SnapshotDatabase = Pick<ReturnType<typeof getAdminClient>, 'from'>
const STORAGE_TIMEOUT_MS = 5_000
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const columns = 'id,ad_account_id,source,scope_key,scope_canonical,evidence_fingerprint,snapshot_canonical,retrieval_started_at,retrieval_completed_at,created_at'
const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestamp = z.string().datetime({ offset: true })
const RowSchema = z.object({
  id: z.string().uuid(), ad_account_id: z.string().uuid(),
  source: z.enum(['meta', 'business', 'website', 'measurement']),
  scope_key: fingerprint, scope_canonical: z.string(), evidence_fingerprint: fingerprint, snapshot_canonical: z.string(),
  retrieval_started_at: timestamp, retrieval_completed_at: timestamp, created_at: timestamp,
}).strict()

export interface StoredReportingSnapshot {
  id: string
  fingerprint: string
  createdAt: string
  snapshot: ReportingSnapshot
  /** The packet exactly as stored when it is v2; the fingerprint covers it, not the expansion. */
  storedPacket?: CompactReportingPacket
}

function scopeIdentity(raw: ReportingSnapshotScope): { scope: ReportingSnapshotScope; key: string; canonical: string } {
  try {
    const scope = ReportingSnapshotScopeSchema.parse(raw)
    return { scope, key: reportingFingerprint(scope), canonical: canonicalReportingJson(scope) }
  } catch { throw new ReportingSnapshotError('invalid') }
}

function validateRow(raw: unknown, scope: ReportingSnapshotScope): StoredReportingSnapshot {
  try {
    const row = RowSchema.parse(raw)
    if (Buffer.byteLength(row.snapshot_canonical, 'utf8') > MAX_SNAPSHOT_BYTES) throw new ReportingSnapshotError('invalid')
    const identity = scopeIdentity(scope)
    const decoded = JSON.parse(row.snapshot_canonical)
    if (row.ad_account_id !== scope.accountId || row.source !== scope.source || row.scope_key !== identity.key
      || row.scope_canonical !== identity.canonical || row.snapshot_canonical !== canonicalReportingJson(decoded)
      || row.evidence_fingerprint !== reportingFingerprint(decoded)) throw new ReportingSnapshotError('invalid')
    // Integrity is proven on the stored bytes above; a v2 packet is expanded and legacy source-named
    // vocabulary upgraded after, then the snapshot is validated exactly as a v1 snapshot.
    const compact = isCompactReportingPacket(decoded?.packet) ? CompactReportingPacketSchema.parse(decoded.packet) : undefined
    const expanded = compact ? { ...decoded, packet: expandPacket(compact) } : decoded
    // A v2 packet that needs no upgrade is sent as stored; one that does is sent as upgraded, like v1.
    const storedPacket = compact && !legacyVocabularyIn(compact) ? compact : undefined
    const snapshot = validateReportingSnapshot(storedPacket ? expanded : upgradeLegacyVocabulary(expanded), scope)
    if (Date.parse(row.retrieval_started_at) !== Date.parse(snapshot.retrieval.startedAt)
      || Date.parse(row.retrieval_completed_at) !== Date.parse(snapshot.retrieval.completedAt)) throw new ReportingSnapshotError('invalid')
    return { id: row.id, fingerprint: row.evidence_fingerprint, createdAt: row.created_at, snapshot, ...(storedPacket ? { storedPacket } : {}) }
  } catch { throw new ReportingSnapshotError('invalid') }
}

/** Whether the legacy vocabulary upgrade would change a v2 packet, read from its distinct strings and keys
 * (the upgrade rewrites only whole strings, keys, a `unit` of 'usd' and a budget amount keyed 'usd' beside
 * `minorUnits`). v2 is written in the current
 * vocabulary, so this is normally false and the stored packet is exactly the packet's meaning. */
function legacyVocabularyIn(packet: CompactReportingPacket): boolean {
  const { strings, keys } = compactJsonTokens(packet.compact)
  return [...strings].some(value => upgradeLegacyVocabulary(value) !== value)
    || [...keys].some(key => !Object.hasOwn(upgradeLegacyVocabulary({ [key]: null }), key))
    || keys.has('unit') && strings.has('usd')
    || keys.has('minorUnits') && keys.has(LEGACY_BUDGET_AMOUNT_KEY)
}

function failed(error: unknown): never {
  throw error instanceof ReportingSnapshotError ? error : new ReportingSnapshotError('unavailable')
}

/** A completed refresh resolves its own publication, even if a later job has
 * already published a newer observation for the same scope. */
export async function readReportingSnapshotById(
  db: SnapshotDatabase, rawScope: ReportingSnapshotScope, id: string, signal?: AbortSignal,
): Promise<StoredReportingSnapshot | null> {
  const { scope, key } = scopeIdentity(rawScope)
  if (!z.string().uuid().safeParse(id).success) throw new ReportingSnapshotError('invalid')
  try {
    return await withReportingDeadline(async childSignal => {
      const { data, error } = await db.from('reporting_snapshots').select(columns)
        .eq('ad_account_id', scope.accountId).eq('source', scope.source).eq('scope_key', key)
        .eq('id', id).abortSignal(childSignal).maybeSingle()
      if (error) throw new ReportingSnapshotError('unavailable')
      if (data === null) return null
      const saved = validateRow(data, scope)
      if (saved.id !== id) throw new ReportingSnapshotError('invalid')
      return saved
    }, STORAGE_TIMEOUT_MS, signal)
  } catch (error) { return failed(error) }
}

/** Reads never trigger a source refresh or mutate a stored observation. The route
 * must authorize the owner and resolve the account before supplying this scope. */
export async function readLatestReportingSnapshot(
  db: SnapshotDatabase, rawScope: ReportingSnapshotScope, signal?: AbortSignal,
): Promise<StoredReportingSnapshot | null> {
  const { scope, key } = scopeIdentity(rawScope)
  try {
    return await withReportingDeadline(async childSignal => {
      const { data, error } = await db.from('reporting_snapshots').select(columns)
        .eq('ad_account_id', scope.accountId).eq('source', scope.source).eq('scope_key', key)
        .order('retrieval_started_at', { ascending: false }).order('retrieval_completed_at', { ascending: false })
        .order('id', { ascending: false }).limit(1).abortSignal(childSignal).maybeSingle()
      if (error) throw new ReportingSnapshotError('unavailable')
      return data === null ? null : validateRow(data, scope)
    }, STORAGE_TIMEOUT_MS, signal)
  } catch (error) { return failed(error) }
}
