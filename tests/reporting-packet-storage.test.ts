import { describe, expect, it, vi } from 'vitest'
import { snapshotContext, snapshotPacket } from './fixtures/reporting-snapshot'
import { pendingPacket, refreshDatabase, refreshJob, refreshRecord, refreshScope } from './fixtures/reporting-refresh'
import { preparedKey } from './fixtures/reporting-prepared'
import {
  canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint, type ReportingSnapshot,
} from '@/lib/reporting/snapshot-contract'
import { readLatestReportingSnapshot, type SnapshotDatabase } from '@/lib/reporting/snapshot-store'
import { finishReportingRefresh, publishReportingRefreshProgress, readReportingRefreshJob } from '@/lib/reporting/refresh-jobs'
import { compactReportingPacket, expandPacket } from '@/lib/reporting/packet-format'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { preparedReportingReply } from '@/lib/reporting/prepared-response'
import { validatePreparedReportingReply } from '@/lib/reporting/prepared-validation'
import { preparedEvidenceDelivery } from '@/lib/reporting/saved-delivery'

// New writes store packetVersion 2; stored v1 bytes are never rewritten and still read. Either way the
// fingerprint covers the stored bytes and the reader returns the same validated v1 meaning.
const scope = makeReportingSnapshotScope('meta', snapshotContext)
const completedAt = '2026-09-05T17:00:40.000Z'
const snapshot = () => createReportingSnapshot(scope, snapshotPacket(), completedAt)
const compactSnapshot = (value: ReportingSnapshot = snapshot()) => ({ ...value, packet: compactReportingPacket(value.packet) })
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown

function row(stored: object) {
  return {
    id: '00000000-0000-4000-8000-000000001313', ad_account_id: scope.accountId, source: scope.source,
    scope_key: reportingFingerprint(scope), scope_canonical: canonicalReportingJson(scope),
    evidence_fingerprint: reportingFingerprint(stored), snapshot_canonical: canonicalReportingJson(stored),
    retrieval_started_at: snapshotContext.asOf, retrieval_completed_at: completedAt, created_at: '2026-09-05T17:00:41.000Z',
  }
}
function database(value: unknown) {
  const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: value, error: null }) }
  for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal'] as const) query[method].mockReturnValue(query)
  return { from: vi.fn().mockReturnValue(query) } as unknown as SnapshotDatabase
}

describe('report packet storage versions', () => {
  it('publishes a completed refresh as packetVersion 2 whose expansion is the validated packet', async () => {
    const fake = refreshDatabase()
    const value = createReportingSnapshot(refreshScope, snapshotPacket(), '2026-09-05T17:00:30.000Z')
    await finishReportingRefresh(fake.db, refreshJob(), value)
    const [name, args] = fake.rpc.mock.calls.at(-1)!
    expect(name).toBe('finish_reporting_refresh')
    const content = (args as { p_snapshot_canonical: string }).p_snapshot_canonical
    expect(content).toBe(canonicalReportingJson(compactSnapshot(value)))
    const stored = JSON.parse(content)
    expect(stored.packet.packetVersion).toBe(2)
    expect(canonicalReportingJson(expandPacket(stored.packet))).toBe(canonicalReportingJson(value.packet))
  })

  it('reads a stored v2 snapshot as the same validated snapshot and keeps the stored packet for its fingerprint', async () => {
    const stored = compactSnapshot()
    const read = await readLatestReportingSnapshot(database(row(stored)), scope)
    expect(read?.snapshot).toEqual(snapshot())
    expect(read?.fingerprint).toBe(reportingFingerprint(stored))
    expect(reportingFingerprint({ ...read!.snapshot, packet: read!.storedPacket })).toBe(read!.fingerprint)
  })

  it('still reads a stored v1 snapshot, unchanged and without a compact copy', async () => {
    const stored = snapshot()
    const read = await readLatestReportingSnapshot(database(row(stored)), scope)
    expect(read?.snapshot).toEqual(stored)
    expect(read?.fingerprint).toBe(reportingFingerprint(stored))
    expect(read?.storedPacket).toBeUndefined()
  })

  it('upgrades legacy vocabulary in a v2 snapshot like v1, and then does not offer the stored packet as its meaning', async () => {
    const packet = snapshotPacket()
    const legacy = createReportingSnapshot(scope, { ...packet, result: { ...packet.result, notes: ['acuity'] } }, completedAt)
    const read = await readLatestReportingSnapshot(database(row(compactSnapshot(legacy))), scope)
    expect(read?.snapshot.packet.result.notes).toEqual(['outcomes'])
    expect(read?.storedPacket).toBeUndefined()
    expect(read?.fingerprint).toBe(reportingFingerprint(compactSnapshot(legacy)))
  })

  it('refuses a v2 snapshot whose bytes changed, or whose rehashed table no longer matches its index', async () => {
    const stored = compactSnapshot()
    const base = row(stored)
    await expect(readLatestReportingSnapshot(database({ ...base, snapshot_canonical: base.snapshot_canonical.replace('Studio', 'Changed') }), scope))
      .rejects.toMatchObject({ kind: 'invalid' })
    const altered = structuredClone(stored)
    altered.packet.result.notes = ['Rewritten after storage.']
    await expect(readLatestReportingSnapshot(database(row(altered)), scope)).rejects.toMatchObject({ kind: 'invalid' })
    const forward = structuredClone(stored)
    forward.packet.compact.values.push([-1, forward.packet.compact.values.length])
    await expect(readLatestReportingSnapshot(database(row(forward)), scope)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('publishes progress as packetVersion 2 and reads it back as the pending packet', async () => {
    const fake = refreshDatabase()
    await publishReportingRefreshProgress(fake.db, refreshJob(), pendingPacket())
    const content = (fake.rpc.mock.calls.at(-1)![1] as { p_packet_canonical: string }).p_packet_canonical
    // Encoded from the validated packet, so key order (kept by v2) is the schema's.
    expect(content).toBe(canonicalReportingJson(compactReportingPacket(validateReportingPacket(pendingPacket()))))
    const compact = JSON.parse(content)
    const record = { ...refreshRecord(), progress_canonical: content, progress_fingerprint: reportingFingerprint(compact),
      progress_at: '2026-09-05T17:00:01.000Z' }
    expect((await readReportingRefreshJob(refreshDatabase(record).db, refreshScope))?.progress).toEqual(pendingPacket())
    // Stored v1 progress still reads.
    expect((await readReportingRefreshJob(refreshDatabase(refreshRecord(pendingPacket())).db, refreshScope))?.progress).toEqual(pendingPacket())
  })
})

describe('prepared report transport', () => {
  const stored = (value: ReportingSnapshot) => ({ id: '00000000-0000-4000-8000-000000001401', fingerprint: reportingFingerprint(compactSnapshot(value)),
    createdAt: value.retrieval.completedAt, snapshot: value, storedPacket: compactReportingPacket(value.packet) })

  it('sends the stored v2 packet, and the browser verifies its fingerprint and reads the v1 meaning', async () => {
    const value = snapshot()
    const reply = preparedReportingReply(scope, stored(value), null)
    expect(reply.packet).toEqual(compactReportingPacket(value.packet))
    const validated = validatePreparedReportingReply(wire(reply), 'meta', preparedKey)
    expect(validated.packet).toEqual(value.packet)
    const delivery = await preparedEvidenceDelivery(validated)
    expect(delivery?.receipt?.fingerprint).toBe(reportingFingerprint(compactSnapshot(value)))
    expect(delivery?.packet).toEqual(value.packet)
  })

  it('refuses a transported v2 packet that differs from the fingerprinted bytes', async () => {
    const value = snapshot()
    const reply = wire(preparedReportingReply(scope, stored(value), null)) as { packet: { compact: { values: unknown[] } } }
    const position = reply.packet.compact.values.indexOf('Fictional data')
    expect(position).toBeGreaterThanOrEqual(0)
    reply.packet.compact.values[position] = 'Different data'
    const validated = validatePreparedReportingReply(reply, 'meta', preparedKey)
    await expect(preparedEvidenceDelivery(validated)).rejects.toThrow()
  })

  it('sends running progress compact and the browser expands it to the pending packet', () => {
    const progress = pendingPacket()
    const job = { ...refreshJob(), progress }
    const reply = preparedReportingReply(refreshScope, null, job, Date.parse('2026-09-05T17:00:10.000Z'))
    expect(reply.packet).toEqual(compactReportingPacket(progress))
    expect(validatePreparedReportingReply(wire(reply), 'meta', preparedKey).packet).toEqual(progress)
  })

  it('still accepts a plain v1 packet from the server', () => {
    const value = snapshot()
    const reply = preparedReportingReply(scope, { id: '00000000-0000-4000-8000-000000001401', fingerprint: reportingFingerprint(value),
      createdAt: completedAt, snapshot: value }, null)
    expect(reply.packet).toEqual(value.packet)
    expect(validatePreparedReportingReply(wire(reply), 'meta', preparedKey).packet).toEqual(value.packet)
  })
})
