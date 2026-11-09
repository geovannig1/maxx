import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { freshSchemaDb, insertAdAccount } from './schema-db'

export const ACCOUNT = '00000000-0000-4000-8000-000000001311'
export const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000001312'
export const STARTED = '2026-09-05T12:00:00.000Z'
export const COMPLETED = '2026-09-05T12:01:00.000Z'
/** The extensions the shipped schema installs; a reopened file-backed database must load them too. */
export const SCHEMA_EXTENSIONS = { uuid_ossp, pgcrypto }

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

export function snapshotFixture(source = 'meta', startedAt = STARTED, completedAt = COMPLETED) {
  const scope = {
    version: 1, policyVersion: 'reporting-v1', source, accountId: ACCOUNT,
    metaAccountId: 'act_123', requestedRange: { from: '2026-09-01', to: '2026-09-04' },
    range: { from: '2026-09-01', to: '2026-09-04' },
    comparison: { from: '2026-08-28', to: '2026-08-31' },
    timezone: 'America/New_York', currency: 'USD', detailIds: source === 'meta' ? ['ad_1', 'ad_2'] : [],
  }
  const reports: Record<string, Record<string, unknown>> = {
    meta: { metrics: {}, entities: [], series: [], comparisonSeries: [], breakdowns: [], observations: [],
      attributionWindow: '7d_click', reportingTime: 'impression', sourceDescription: 'Synthetic Meta fixture', detailState: 'complete' },
    business: { metrics: {}, series: [], comparisonSeries: [], types: [], sourceDescription: 'Synthetic Acuity fixture' },
    website: { metrics: {}, rows: [], events: [], metadata: { timezone: null, currency: null,
      subjectToThresholding: null, dataLossFromOtherRow: null, sampled: null, returnedRows: 0, totalRows: null },
    sourceDescription: 'Synthetic GA4 fixture' },
    measurement: { paidAssociation: {}, capi: {}, paidAssociationNotes: [], capiNotes: [], sourceDescription: 'Synthetic measurement fixture' },
  }
  return {
    contract: 'maxx_reporting_snapshot', version: 1, scope,
    packet: { context: { account: { id: ACCOUNT, name: 'Synthetic studio', metaAccountId: scope.metaAccountId },
      range: scope.range, comparison: scope.comparison, timezone: scope.timezone, currency: scope.currency, asOf: startedAt },
    section: source, result: { state: 'available', data: reports[source], asOf: '2026-09-05T11:45:00.000Z', notes: [] }, notes: [] },
    retrieval: { startedAt, completedAt }, sourceAsOf: '2026-09-05T11:45:00.000Z',
  }
}

export function rowFor(value: unknown = snapshotFixture(), scope: unknown = (value as ReturnType<typeof snapshotFixture>).scope,
  overrides: Record<string, string | null> = {}) {
  const scopeText = canonical(scope), snapshotText = canonical(value)
  return { ad_account_id: ACCOUNT, source: 'meta', scope_key: fingerprint(scopeText), scope_canonical: scopeText,
    evidence_fingerprint: fingerprint(snapshotText), snapshot_canonical: snapshotText,
    retrieval_started_at: STARTED, retrieval_completed_at: COMPLETED, ...overrides }
}

export function edit(value: unknown, keys: string[], replacement: unknown): unknown {
  if (!keys.length) return replacement
  const object = value as Record<string, unknown>, [head, ...tail] = keys
  return Object.fromEntries(Object.entries(object).flatMap(([key, item]) => key !== head ? [[key, item]]
    : replacement === undefined && !tail.length ? [] : [[key, edit(item, tail, replacement)]]))
}

/**
 * The full shipped schema with the two fixture accounts. With a data directory the same schema image is
 * written to disk so restart tests reopen real files. Supabase's service_role holds BYPASSRLS, and the
 * reporting tables rely on it (they ship no service_role policy), so the fixture grants it as Supabase does.
 */
export async function prepareDb(dataDir?: string): Promise<PGlite> {
  let db = await freshSchemaDb()
  if (dataDir) {
    const image = await db.dumpDataDir('none')
    await db.close()
    db = new PGlite(dataDir, { extensions: SCHEMA_EXTENSIONS, loadDataDir: image })
  }
  await db.exec('ALTER ROLE service_role BYPASSRLS')
  await insertAdAccount(db, ACCOUNT)
  await insertAdAccount(db, OTHER_ACCOUNT)
  return db
}

export function insertRow(db: PGlite, row = rowFor()) {
  const columns = Object.keys(row)
  return db.query<{ id: string; created_at: Date; snapshot_canonical: string }>(`
    INSERT INTO public.reporting_snapshots(${columns.join(',')})
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})
    RETURNING id, created_at, snapshot_canonical
  `, Object.values(row))
}
