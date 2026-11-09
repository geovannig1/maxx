import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { prepareSavedDb, savedTestClient } from './reporting-saved-fixture'
import { claim, finish } from './reporting-refresh-fixture'
import { missingSource, publishSavedEvidence, SAVED_USER } from '../fixtures/reporting-saved'
import { snapshotContext } from '../fixtures/reporting-snapshot'
import { buildBusinessReport } from '@/lib/reporting/business-metrics'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric } from '@/lib/reporting/claims'
import type { ReportingContext, ReportingPacket } from '@/lib/reporting/contracts'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint,
  type ReportingSnapshot } from '@/lib/reporting/snapshot-contract'
import { readReportingSnapshotById, type StoredReportingSnapshot } from '@/lib/reporting/snapshot-store'
import { readSavedReportManifest, type SavedReportArtifact, type SavedReportingDatabase,
  type StoredSavedReport } from '@/lib/reporting/saved-store'
import { openSavedReportingReport, saveReportingReport } from '@/lib/reporting/saved-service'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import type { SaveReportingReportInput, SavedReportSources } from '@/lib/reporting/saved-contract'
import { upgradeLegacyVocabulary } from '@/lib/outcomes/legacy-vocabulary'
import { getOutcomeAdapter } from '@/lib/outcomes/registry'

// reporting snapshots and saved reports are fingerprinted, so the vocabulary migration cannot rewrite
// them. A document a legacy writer stored keeps its bytes; the repository verifies those bytes first and
// upgrades the vocabulary after. This test stores such documents through the real write RPCs and reads
// them back through the real repository functions against the shipped schema.

const LEGACY_USER = '00000000-0000-4000-8000-000000001404'
const vocabulary = getOutcomeAdapter('acuity')!.legacyVocabulary!
type Rule = 'exact' | 'qualifier' | 'prefix' | 'identifier' | 'unit'

/** The inverse of the reference adapter's legacy vocabulary: what a legacy writer put in the same place. */
function legacyToken(token: string, used: Set<Rule>): string {
  const exact = Object.entries(vocabulary.exact).find(([, to]) => to === token)
  if (exact) { used.add('exact'); return exact[0] }
  for (const [from, to] of vocabulary.qualifiers ?? []) {
    if (token.startsWith(to)) { used.add('qualifier'); return from + legacyToken(token.slice(to.length), used) }
  }
  for (const [from, to] of vocabulary.prefixes) if (token.startsWith(to)) { used.add('prefix'); return from + token.slice(to.length) }
  const [oldWord, newWord] = vocabulary.identifierWord!
  const lower = (word: string) => word[0].toLowerCase() + word.slice(1)
  if (/^[a-z][A-Za-z0-9]*$/.test(token)) {
    if (token.includes(newWord)) { used.add('identifier'); return token.split(newWord).join(oldWord) }
    if (token.startsWith(lower(newWord)) && /^[A-Z]/.test(token.slice(newWord.length))) {
      used.add('identifier'); return lower(oldWord) + token.slice(newWord.length)
    }
  }
  return token
}
function legacyDocument<T>(value: T, used: Set<Rule>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return legacyToken(v, used)
    if (Array.isArray(v)) return v.map(walk)
    if (v === null || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([key, entry]) => [legacyToken(key, used),
      key === 'unit' && entry === 'money' ? (used.add('unit'), 'usd') : walk(entry)]))
  }
  return walk(value) as T
}
/** Every key and string in a JSON value that still names the legacy source or unit. */
function legacyResidue(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return /acuity/i.test(value) ? [`${path}=${value}`] : []
  if (Array.isArray(value)) return value.flatMap((entry, i) => legacyResidue(entry, `${path}[${i}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(/acuity/i.test(key) ? [`${path}.${key}`] : []),
    ...(key === 'unit' && entry === 'usd' ? [`${path}.unit=usd`] : []),
    ...legacyResidue(entry, `${path}.${key}`)])
}

function businessPacket(context: ReportingContext): Extract<ReportingPacket, { section: 'business' }> {
  const row = (id: number, price: number) => ({ id, price, amount_paid: price, canceled: false,
    booking_date_et: context.range.from, appointment_type: 'Studio Rental' })
  const report = buildBusinessReport(context, [row(1, 100), row(2, 150)], [{ ...row(3, 90), booking_date_et: context.comparison.from }])
  // Beyond the builder's own output, two more shared-vocabulary positions: a metric keyed by an exact legacy
  // token, and one keyed by a camelCase identifier whose claim is blocked by a source-qualified code.
  const extra = (key: string, label: string, current: number | null, unit: 'money' | 'count', reason?: string) => makeReportMetric({
    context, key, label, definition: `Synthetic ${label.toLowerCase()}`, source: 'outcomes', unit, current, reason,
    coverage: current === null ? undefined : COMPLETE_FIELD_COVERAGE })
  const metrics = { ...report.metrics, recordedOutcomeValue: extra('recordedOutcomeValue', 'Recorded value', 250, 'money'),
    priorOutcomeWeeks: extra('priorOutcomeWeeks', 'Prior weeks', null, 'count', 'outcomes:outcome_ledger_window_not_covered:2026-09-02..2026-09-04') }
  return { section: 'business', context, notes: [], result: { state: 'available', asOf: context.asOf, notes: [], data: { ...report, metrics } } }
}
const SNAPSHOT_INSERT = `INSERT INTO public.reporting_snapshots (ad_account_id, source, scope_key, scope_canonical,
  evidence_fingerprint, snapshot_canonical, retrieval_started_at, retrieval_completed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`
function snapshotRowValues(snapshot: ReportingSnapshot, text = canonicalReportingJson(snapshot), print = reportingFingerprint(snapshot)) {
  return [snapshot.scope.accountId, snapshot.scope.source, reportingFingerprint(snapshot.scope),
    canonicalReportingJson(snapshot.scope), print, text, snapshot.retrieval.startedAt, snapshot.retrieval.completedAt]
}
/** The real repository read, with the stored row altered in transit (the table's CHECKs refuse such rows). */
function snapshotsInTransit(client: SavedReportingDatabase, edit: (row: Record<string, unknown>) => Record<string, unknown>): SavedReportingDatabase {
  return { ...client, from: ((table: string) => ({ select: (columns: string) => {
    const query = client.from(table).select(columns), read = query.maybeSingle.bind(query)
    query.maybeSingle = (async () => {
      const result = await read()
      return { ...result, data: result.data && edit(result.data as unknown as Record<string, unknown>) }
    }) as unknown as typeof query.maybeSingle
    return query
  } })) as unknown as SavedReportingDatabase['from'] }
}
function manifestsInTransit(client: SavedReportingDatabase, edit: (row: Record<string, unknown>) => Record<string, unknown>): SavedReportingDatabase {
  return { ...client, rpc: ((name: string, args: Record<string, unknown>) => {
    const call = client.rpc(name, args)
    return { abortSignal: (signal: AbortSignal) => call.abortSignal(signal).then(result =>
      ({ ...result, data: result.data && edit(result.data as Record<string, unknown>) })) }
  }) as unknown as SavedReportingDatabase['rpc'] }
}
const flipByteAfter = (text: string, marker: string) => {
  const at = text.indexOf(marker) + marker.length
  if (at < marker.length) throw new Error(`marker not found: ${marker}`)
  return text.slice(0, at) + (text[at] === 'x' ? 'y' : 'x') + text.slice(at + 1)
}

describe('legacy-vocabulary saved report and snapshot read through the real repository', () => {
  let db: PGlite
  let client: SavedReportingDatabase
  let businessScope: ReturnType<typeof makeReportingSnapshotScope>
  let current: StoredReportingSnapshot
  let legacy: { id: string; fingerprint: string; snapshot: ReportingSnapshot; rules: Set<Rule> }
  let fresh: Awaited<ReturnType<typeof saveReportingReport>>
  let currentManifest: StoredSavedReport
  let legacyArtifact: SavedReportArtifact
  let legacyManifestId: string
  const artifactRules = new Set<Rule>()

  beforeAll(async () => {
    db = await prepareSavedDb()
    client = savedTestClient(db)
    const meta = await publishSavedEvidence(db, 3)
    // A legacy writer: its refresh lease published the business snapshot in the old vocabulary.
    businessScope = makeReportingSnapshotScope('business', snapshotContext)
    const lease = (await claim(db, businessScope)).job!
    const snapshot = createReportingSnapshot(businessScope,
      businessPacket({ ...snapshotContext, asOf: new Date(lease.started_at).toISOString() }), new Date().toISOString())
    const rules = new Set<Rule>(), old = legacyDocument(snapshot, rules)
    const published = await finish(db, lease, old)
    if (!published.committed || !published.snapshot_id) throw new Error('legacy snapshot publication refused')
    legacy = { id: published.snapshot_id, fingerprint: reportingFingerprint(old), snapshot: old, rules }
    // The same observation in the current vocabulary, stored by the owner with identical retrieval times.
    const id = (await db.query<{ id: string }>(SNAPSHOT_INSERT, snapshotRowValues(snapshot))).rows[0].id
    current = (await readReportingSnapshotById(client, businessScope, id))!

    // A current saved report over Meta + current business evidence, written by the real service.
    const sources: SavedReportSources = { meta: { state: 'snapshot', receipt: receipt(meta) },
      business: { state: 'snapshot', receipt: receipt(current) }, website: missingSource, measurement: missingSource }
    const data = assembleSavedReportData({ meta: meta.snapshot.packet, business: current.snapshot.packet }, sources)
    const input: SaveReportingReportInput = { requestId: '00000000-0000-4000-8000-0000000014aa', title: 'Legacy vocabulary report',
      view: { pathname: '/dashboard', query: { from: businessScope.requestedRange.from, to: businessScope.requestedRange.to } },
      sources, reviewIdentity: reportingFingerprint(deriveExpertReview(data)) }
    fresh = await saveReportingReport(client, snapshotContext.account, SAVED_USER, input)
    currentManifest = (await readSavedReportManifest(client, snapshotContext.account.id, { id: fresh.saved.id }))!

    // The same report as a legacy writer stored it: old vocabulary, bound to the legacy business snapshot,
    // every stored identity computed over the old bytes, saved through the real write RPC.
    const old2 = legacyDocument(currentManifest.artifact, artifactRules)
    const bound = { ...old2, input: { ...old2.input, sources: { ...old2.input.sources,
      business: { state: 'snapshot' as const, receipt: { ...receipt(current), id: legacy.id, fingerprint: legacy.fingerprint } } } } }
    legacyArtifact = { ...bound, input: { ...bound.input, reviewIdentity: reportingFingerprint(bound.review) },
      notesIdentity: reportingFingerprint(bound.notes), dataIdentity: reportingFingerprint(legacyDocument(data, new Set())) }
    legacyManifestId = (await db.query<{ value: { id: string } }>('SELECT public.save_reporting_report($1,$2,$3,$4) value',
      [snapshotContext.account.id, LEGACY_USER, input.requestId, canonicalReportingJson(legacyArtifact)])).rows[0].value.id
  }, 120_000)
  afterAll(async () => { await db?.close() })

  function receipt(stored: StoredReportingSnapshot) {
    const { snapshot } = stored
    return { id: stored.id, fingerprint: stored.fingerprint, scope: snapshot.scope, retrievalStartedAt: snapshot.retrieval.startedAt,
      retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf }
  }

  it('derives genuinely old documents that exercise every rule kind and round-trip exactly (preconditions)', () => {
    expect([...legacy.rules].sort()).toEqual(['exact', 'identifier', 'prefix', 'qualifier', 'unit'])
    for (const rule of ['exact', 'prefix', 'unit'] as const) expect(artifactRules, rule).toContain(rule)
    const metrics = (legacy.snapshot.packet.result.data as { metrics: Record<string, { current: Record<string, unknown> }> }).metrics
    expect(metrics.acuityRecordedRevenue.current).toMatchObject({ metricKey: 'acuity.recordedOutcomeValue', unit: 'usd',
      source: { system: 'acuity', evidencePlane: 'acuity_business' } })
    expect(metrics.priorAcuityWeeks.current).toMatchObject({ availability: { state: 'unavailable',
      blockerCodes: ['acuity:acuity_ledger_window_not_covered:2026-09-02..2026-09-04'] } })
    expect(legacyResidue(legacy.snapshot).length).toBeGreaterThan(0)
    expect(legacyResidue(legacyArtifact).length).toBeGreaterThan(0)
    expect(legacyResidue(current.snapshot)).toEqual([])
    expect(legacyResidue(currentManifest.artifact)).toEqual([])
    expect(upgradeLegacyVocabulary(legacy.snapshot)).toEqual(current.snapshot)
    expect(legacy.fingerprint).not.toBe(current.fingerprint)
  })

  it('reads a current snapshot unchanged and a legacy snapshot as the same current observation', async () => {
    expect(current.fingerprint).toBe(reportingFingerprint(current.snapshot))
    const read = (await readReportingSnapshotById(client, businessScope, legacy.id))!
    expect(read.snapshot).toEqual(current.snapshot)
    // The stored fingerprint still names the stored (old) bytes; the content is the upgraded observation.
    expect(read.fingerprint).toBe(legacy.fingerprint)
    expect(reportingFingerprint(read.snapshot)).toBe(current.fingerprint)
    expect(legacyResidue(read.snapshot)).toEqual([])
  })

  it('reads a current manifest without the upgrade flag (known-present control)', () => {
    expect(currentManifest.upgradedVocabulary).toBeUndefined()
    expect(currentManifest.artifact.input.reviewIdentity).toBe(fresh.saved.reviewIdentity)
  })

  it('reads a legacy manifest as the current artifact, flagged, with only documented identities differing', async () => {
    const read = (await readSavedReportManifest(client, snapshotContext.account.id, { id: legacyManifestId }))!
    expect(read.upgradedVocabulary).toBe(true)
    expect(read.userId).toBe(LEGACY_USER)
    expect(legacyResidue(read.artifact)).toEqual([])
    const expected: SavedReportArtifact = { ...currentManifest.artifact,
      input: { ...currentManifest.artifact.input, sources: { ...currentManifest.artifact.input.sources,
        business: { state: 'snapshot', receipt: { ...receipt(current), id: legacy.id, fingerprint: legacy.fingerprint } } } },
      // The manifest keeps the data identity it stored; the service re-derives it from the upgraded snapshots.
      dataIdentity: legacyArtifact.dataIdentity }
    expect(read.artifact).toEqual(expected)
    expect(read.artifact.input.reviewIdentity).toBe(currentManifest.artifact.input.reviewIdentity)
    expect(read.artifact.notesIdentity).toBe(currentManifest.artifact.notesIdentity)
  })

  it('reopens the legacy saved report through the service exactly as the fresh one', async () => {
    const reopened = await openSavedReportingReport(client, snapshotContext.account, legacyManifestId)
    const original = await openSavedReportingReport(client, snapshotContext.account, fresh.saved.id)
    const binding = { state: 'snapshot', receipt: { ...receipt(current), id: legacy.id, fingerprint: legacy.fingerprint } }
    expect(reopened).toEqual({ ...original, saved: { ...original.saved, id: legacyManifestId, createdAt: reopened.saved.createdAt,
      sources: { ...original.saved.sources, business: binding }, sourceSummary: { ...original.saved.sourceSummary, business: binding } } })
    expect(legacyResidue(reopened)).toEqual([])
  })

  // Found by this test: a legacy writer built claim ids as `report:${source}:...` (src/lib/reporting/claims.ts
  // before b3744a1), i.e. `report:acuity:business:...`. The reference adapter's legacy vocabulary now upgrades that
  // claim-id prefix too, so an upgraded observation never names `outcomes` as its system under an `acuity` claim id.
  it('upgrades the legacy source name inside claim ids written as report:<source>:...', async () => {
    // The legacy document is built by inverting the adapter's vocabulary, so it carries the old claim ids.
    expect(canonicalReportingJson(legacy.snapshot)).toContain('"report:acuity:business:')
    const read = (await readReportingSnapshotById(client, businessScope, legacy.id))!
    expect(legacyResidue(read.snapshot)).toEqual([])
    const booked = (read.snapshot.packet.result.data as { metrics: Record<string, { current: { claimId: string; source: { system: string } } }> }).metrics.booked_value.current
    expect(booked.source.system).toBe('outcomes')
    expect(booked.claimId.startsWith('report:outcomes:business:')).toBe(true)
  })

  it('refuses rows whose fingerprint does not bind their bytes at the table (why controls run in transit)', async () => {
    const text = canonicalReportingJson(legacy.snapshot)
    await expect(db.query(SNAPSHOT_INSERT, snapshotRowValues(legacy.snapshot, flipByteAfter(text, '"sourceDescription":"'), legacy.fingerprint)))
      .rejects.toMatchObject({ code: '23514' })
    await expect(db.query(SNAPSHOT_INSERT, snapshotRowValues(legacy.snapshot, text, current.fingerprint)))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('rejects a legacy snapshot tampered by one byte, though the same bytes with their own fingerprint read', async () => {
    const tampered = (row: Record<string, unknown>) => flipByteAfter(row.snapshot_canonical as string, '"sourceDescription":"')
    const honest = snapshotsInTransit(client, row => ({ ...row, snapshot_canonical: tampered(row),
      evidence_fingerprint: reportingFingerprint(JSON.parse(tampered(row))) }))
    expect((await readReportingSnapshotById(honest, businessScope, legacy.id))!.snapshot.packet.result.state).toBe('available')
    const forged = snapshotsInTransit(client, row => ({ ...row, snapshot_canonical: tampered(row) }))
    await expect(readReportingSnapshotById(forged, businessScope, legacy.id)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('rejects a legacy snapshot whose fingerprint was computed over the upgraded bytes', async () => {
    const upgraded = snapshotsInTransit(client, row => ({ ...row,
      evidence_fingerprint: reportingFingerprint(upgradeLegacyVocabulary(JSON.parse(row.snapshot_canonical as string))) }))
    await expect(readReportingSnapshotById(upgraded, businessScope, legacy.id)).rejects.toMatchObject({ kind: 'invalid' })
  })

  it('rejects a legacy manifest tampered by one byte, though the same bytes with their own fingerprint read', async () => {
    const tampered = (row: Record<string, unknown>) => flipByteAfter(row.artifact_canonical as string, '"title":"')
    const honest = manifestsInTransit(client, row => ({ ...row, artifact_canonical: tampered(row),
      artifact_fingerprint: reportingFingerprint(JSON.parse(tampered(row))) }))
    const read = (await readSavedReportManifest(honest, snapshotContext.account.id, { id: legacyManifestId }))!
    expect(read.upgradedVocabulary).toBe(true)
    expect(read.artifact.input.title).not.toBe(legacyArtifact.input.title)
    const forged = manifestsInTransit(client, row => ({ ...row, artifact_canonical: tampered(row) }))
    await expect(readSavedReportManifest(forged, snapshotContext.account.id, { id: legacyManifestId })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('rejects a legacy manifest whose fingerprint was computed over the upgraded bytes', async () => {
    const upgraded = manifestsInTransit(client, row => ({ ...row,
      artifact_fingerprint: reportingFingerprint(upgradeLegacyVocabulary(JSON.parse(row.artifact_canonical as string))) }))
    await expect(readSavedReportManifest(upgraded, snapshotContext.account.id, { id: legacyManifestId })).rejects.toMatchObject({ code: 'invalid' })
  })
})
