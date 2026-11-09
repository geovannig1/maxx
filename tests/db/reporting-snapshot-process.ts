// Invoked only by the isolated restart regression. Never loads app credentials.
import { PGlite } from '@electric-sql/pglite'
import {
  canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint, type ReportingSnapshot,
} from '../../src/lib/reporting/snapshot-contract'
import { readLatestReportingSnapshot } from '../../src/lib/reporting/snapshot-store'
import { snapshotContext, snapshotPacket } from '../fixtures/reporting-snapshot'
import { snapshotTestClient } from './reporting-snapshot-transport'
import { SCHEMA_EXTENSIONS, prepareDb } from './reporting-snapshot-fixture'

/** Stores one immutable observation as the database owner, in the columns the repository reads back. */
async function storeAsOwner(db: PGlite, snapshot: ReportingSnapshot): Promise<{ id: string; fingerprint: string }> {
  const fingerprint = reportingFingerprint(snapshot)
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO public.reporting_snapshots (ad_account_id, source, scope_key, scope_canonical, evidence_fingerprint,
       snapshot_canonical, retrieval_started_at, retrieval_completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [snapshot.scope.accountId, snapshot.scope.source, reportingFingerprint(snapshot.scope), canonicalReportingJson(snapshot.scope),
      fingerprint, canonicalReportingJson(snapshot), snapshot.retrieval.startedAt, snapshot.retrieval.completedAt])
  return { id: rows[0].id, fingerprint }
}

async function main() {
  const [operation, directory] = process.argv.slice(2)
  if (!['write', 'read'].includes(operation) || !directory) throw new Error('Choose a test operation and temporary database directory')
  // The write builds the full shipped schema on disk (its fixture account is snapshotContext.account.id);
  // the read reopens those files in this new process.
  const db = operation === 'write' ? await prepareDb(directory) : new PGlite(directory, { extensions: SCHEMA_EXTENSIONS })
  try {
    // service_role holds only SELECT on reporting_snapshots (publication goes through
    // the leased refresh RPC), so the fixture rows are stored by the database owner and the repository
    // read runs as service_role.
    if (operation === 'read') await db.exec('SET ROLE service_role')
    const client = snapshotTestClient(db), scope = makeReportingSnapshotScope('meta', snapshotContext)
    if (operation === 'write') {
      const old = createReportingSnapshot(scope, snapshotPacket(), '2026-09-05T17:03:00.000Z')
      const context = { ...snapshotContext, asOf: '2026-09-05T17:00:40.000Z' }
      const newer = createReportingSnapshot(scope, snapshotPacket(context), '2026-09-05T17:02:00.000Z')
      const published = await storeAsOwner(db, newer)
      await storeAsOwner(db, old)
      console.log(JSON.stringify({ id: published.id, fingerprint: published.fingerprint, pid: process.pid }))
    } else {
      const saved = await readLatestReportingSnapshot(client, scope)
      if (!saved || saved.snapshot.packet.section !== 'meta') throw new Error('Expected persisted Meta evidence')
      const otherScope = { ...scope, detailIds: ['another-ad'] }
      console.log(JSON.stringify({ id: saved.id, fingerprint: saved.fingerprint, pid: process.pid,
        start: saved.snapshot.retrieval.startedAt, finish: saved.snapshot.retrieval.completedAt,
        zero: saved.snapshot.packet.result.data!.metrics.clicks.current.value,
        unknown: saved.snapshot.packet.result.data!.metrics.missing.current.value,
        otherScope: await readLatestReportingSnapshot(client, otherScope),
      }))
    }
  } finally { await db.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
