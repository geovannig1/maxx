import { vi } from 'vitest'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import type { ReportingRefreshDatabase, ReportingRefreshJob } from '@/lib/reporting/refresh-jobs'
import { canonicalReportingJson, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { snapshotContext, snapshotPacket } from './reporting-snapshot'

export const refreshScope = makeReportingSnapshotScope('meta', snapshotContext)
export const refreshId = '00000000-0000-4000-8000-000000001321'
export const refreshToken = '00000000-0000-4000-8000-000000001322'
export const refreshSnapshotId = '00000000-0000-4000-8000-000000001323'

export function refreshRecord(progress: ReportingPacket | null = null) {
  return {
    id: refreshId, ad_account_id: refreshScope.accountId, source: 'meta',
    scope_key: reportingFingerprint(refreshScope), scope_canonical: canonicalReportingJson(refreshScope),
    status: 'running', started_at: snapshotContext.asOf, lease_expires_at: '2026-09-05T17:02:00.000Z',
    lease_token: refreshToken, completed_at: null, failure_code: null, snapshot_id: null,
    progress_canonical: progress ? canonicalReportingJson(progress) : null,
    progress_fingerprint: progress ? reportingFingerprint(progress) : null,
    progress_at: progress ? '2026-09-05T17:00:01.000Z' : null, created_at: snapshotContext.asOf,
  }
}

export function refreshJob(): ReportingRefreshJob {
  return {
    id: refreshId, scope: refreshScope, scopeKey: reportingFingerprint(refreshScope), status: 'running',
    startedAt: snapshotContext.asOf, leaseExpiresAt: '2026-09-05T17:02:00.000Z', leaseToken: refreshToken,
    completedAt: null, failureCode: null, snapshotId: null, progress: null, createdAt: snapshotContext.asOf,
  }
}

export function pendingPacket(): ReportingPacket {
  const packet = structuredClone(snapshotPacket())
  return { ...packet, result: { ...packet.result, data: { ...packet.result.data!, detailState: 'loading' } } }
}

export function refreshDatabase(row: unknown = refreshRecord()) {
  const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }) }
  for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal'] as const) query[method].mockReturnValue(query)
  const from = vi.fn().mockReturnValue(query)
  const rpcResult = vi.fn<(name: string, args: unknown) => Promise<{ data: unknown; error: unknown }>>(async name => ({
    data: name === 'claim_reporting_refresh' ? { claimed: true, job: row }
      : name === 'finish_reporting_refresh' ? { committed: true, snapshot_id: refreshSnapshotId } : true,
    error: null,
  }))
  const rpcSignals: AbortSignal[] = []
  const rpc = vi.fn((name: string, args: unknown) => ({ abortSignal: (signal: AbortSignal) => {
    rpcSignals.push(signal)
    return rpcResult(name, args)
  } }))
  return { db: { from, rpc } as unknown as ReportingRefreshDatabase, from, query, rpc, rpcResult, rpcSignals }
}
