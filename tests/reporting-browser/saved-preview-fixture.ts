import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { mediaMovementFixture } from './media-movement-fixture'
import { customerReportingFixture } from './customer-fixture'
import { customerFollowupReportingFixture } from './customer-followup-fixture'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '../../src/lib/reporting/snapshot-contract'
import { ReportingPacketSchema, type ReportingSectionName } from '../../src/lib/reporting/contracts'
import type { StoredReportingSnapshot } from '../../src/lib/reporting/snapshot-store'

export const SAVED_PREVIEW_ACCOUNT = { id: '00000000-0000-4000-8000-000000001311', metaAccountId: 'act_123', name: 'Fictional saved-report studio' }
export const SAVED_PREVIEW_SOURCES = ['meta', 'business', 'website', 'measurement'] as const

/** Native raw-ledger builders with one explicit clock; no editing metric claims. */
export function savedPreviewSnapshots(mode: 'movement' | 'stable' | 'media' | 'followup' | 'legacy', from: string, to: string, at = new Date().toISOString()) {
  const observedAt = mode === 'followup' ? '2026-09-07T16:00:00Z' : at
  const base = mode === 'followup' ? customerFollowupReportingFixture(observedAt, SAVED_PREVIEW_ACCOUNT)
    : customerReportingFixture(from, to, mode === 'media' || mode === 'legacy' ? 'movement' : mode, SAVED_PREVIEW_ACCOUNT, observedAt)
  const intelligence = base.business.data?.intelligence, customers = intelligence?.customers.data
  const legacy = mode === 'legacy' && intelligence && customers ? (() => {
    const legacyCustomers = { metrics: customers.metrics, groups: customers.groups,
      historyFrom: customers.historyFrom, historyTo: customers.historyTo,
      identityBasis: customers.identityBasis, historyCoverage: customers.historyCoverage }
    return { ...base, business: { ...base.business, data: { ...base.business.data!,
      intelligence: { ...intelligence, customers: {
        ...intelligence.customers, data: legacyCustomers,
      } },
    } } }
  })() : base
  // Prepared storage accepts successful observations only. Retain independent fictional
  // business/web sources while selecting the dedicated native media counterexample.
  const data = mode === 'media' ? { ...legacy, meta: mediaMovementFixture(from, to, SAVED_PREVIEW_ACCOUNT, at).meta } : legacy
  return Object.fromEntries(SAVED_PREVIEW_SOURCES.map(source => {
    // The general live fixture includes empty optional detail arrays everywhere.
    // Native prepared packets omit these fields when no ad detail was requested.
    const result = source === 'meta' && data.meta.data ? { ...data.meta, data: { ...data.meta.data,
      entities: data.meta.data.entities.map(entity => Object.fromEntries(Object.entries(entity)
        .filter(([key]) => !['series', 'comparisonSeries', 'breakdowns'].includes(key)))),
    } } : data[source]
    const packet = ReportingPacketSchema.parse({ section: source, context: data.context, result,
      notes: ['Fictional saved-report preview. No connected Example Studio evidence.'] })
    const scope = makeReportingSnapshotScope(source, data.context)
    const snapshot = createReportingSnapshot(scope, packet, observedAt)
    return [source, { id: randomUUID(), fingerprint: reportingFingerprint(snapshot), createdAt: observedAt, snapshot }]
  })) as Record<ReportingSectionName, StoredReportingSnapshot>
}

/** Seed fictional historical observations as the isolated database owner. This
 * is fixture setup, not the production publication path or service-role access. */
export async function seedSavedPreviewSnapshot(db: PGlite, saved: StoredReportingSnapshot): Promise<StoredReportingSnapshot> {
  const { snapshot } = saved
  const scopeKey = reportingFingerprint(snapshot.scope)
  const scopeCanonical = canonicalReportingJson(snapshot.scope)
  const snapshotCanonical = canonicalReportingJson(snapshot)
  const inserted = await db.query<{ id: string; created_at: string }>(`INSERT INTO public.reporting_snapshots
    (id,ad_account_id,source,scope_key,scope_canonical,evidence_fingerprint,snapshot_canonical,retrieval_started_at,retrieval_completed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [saved.id, snapshot.scope.accountId, snapshot.scope.source,
    scopeKey, scopeCanonical, saved.fingerprint, snapshotCanonical, snapshot.retrieval.startedAt, snapshot.retrieval.completedAt])
    .catch(async error => {
      if ((error as { code?: string }).code !== '23505') throw error
      return { rows: [] }
    })
  const row = inserted.rows[0] ?? (await db.query<{ id: string; created_at: string }>(
    `SELECT id, created_at::text FROM public.reporting_snapshots
      WHERE ad_account_id=$1 AND source=$2 AND scope_key=$3 AND evidence_fingerprint=$4`,
    [snapshot.scope.accountId, snapshot.scope.source, scopeKey, saved.fingerprint],
  )).rows[0]
  return { ...saved, id: row.id, createdAt: row.created_at }
}
