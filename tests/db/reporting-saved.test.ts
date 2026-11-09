import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { prepareSavedDb } from './reporting-saved-fixture'
import { savedTestClient } from './reporting-saved-fixture'
import { publishSavedEvidence, savedInput, SAVED_USER } from '../fixtures/reporting-saved'
import { snapshotContext } from '../fixtures/reporting-snapshot'
import { openSavedReportingReport, saveReportingReport, listSavedReportingReports } from '@/lib/reporting/saved-service'
import { buildReportCsv, metricsToExportRows } from '@/lib/reporting/export'
import { readSavedReportManifest, insertSavedReportManifest } from '@/lib/reporting/saved-store'
import { canonicalReportingJson, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PGlite as Database } from '@electric-sql/pglite'

describe('saved manifest database foundation', () => {
  let db: PGlite
  beforeAll(async () => { db = await prepareSavedDb() })
  afterAll(async () => { await db?.close() })
  it('provides an immutable manifest independently of existing snapshot publication', async () => {
    const result = await db.query<{ name: string | null }>("SELECT to_regclass('public.reporting_saved_reports')::text name")
    expect(result.rows[0].name).toBe('reporting_saved_reports')
  })
  it('saves A, publishes B, and reopens exact A numbers, review and export through real SDK and SQL', async () => {
    const client = savedTestClient(db), a = await publishSavedEvidence(db, 0), input = savedInput(a)
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, input)
    const b = await publishSavedEvidence(db, 19)
    expect(b.snapshot.packet.section === 'meta' && b.snapshot.packet.result.data?.metrics.clicks.current.value).toBe(19)
    const reopened = await openSavedReportingReport(client, snapshotContext.account, saved.saved.id)
    expect(reopened).toEqual(saved)
    expect(reopened.data.meta.data?.metrics.clicks.current.value).toBe(0)
    expect(reopened.notes).toEqual(a.snapshot.packet.notes)
    expect(reopened.saved.notesIdentity).toBe(reportingFingerprint(a.snapshot.packet.notes))
    const csv = (value: typeof saved) => buildReportCsv(metricsToExportRows(value.data.meta.data!.metrics, 'Account', value.data.context))
    expect(csv(reopened)).toBe(csv(saved))
    expect((await listSavedReportingReports(client, snapshotContext.account.id)).reports.map(row => row.id)).toContain(saved.saved.id)
  })
  it('preserves retained A and unavailable-source context/meaning on an idempotent retry', async () => {
    const client = savedTestClient(db), a = await publishSavedEvidence(db), initial = savedInput(a)
    const input = savedInput(a, { meta: { ...initial.sources.meta, state: 'retained_snapshot', code: 'refresh_failed' } as never,
      website: { state: 'unavailable', code: 'source_unavailable', context: a.snapshot.packet.context } })
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, input)
    const retry = await saveReportingReport(client, snapshotContext.account, SAVED_USER, input)
    expect(retry.saved.id).toBe(saved.saved.id)
    expect(retry.saved.sources.meta.state).toBe('retained_snapshot')
    expect(retry.data.website).toMatchObject({ state: 'unavailable', data: null, notes: ['This source was unavailable in this report.'] })
    await expect(saveReportingReport(client, snapshotContext.account, SAVED_USER, { ...input, title: 'Different retry' })).rejects.toMatchObject({ code: 'changed' })
    await expect(openSavedReportingReport(client, { ...snapshotContext.account, id: '00000000-0000-4000-8000-000000001312' }, saved.saved.id)).rejects.toMatchObject({ code: 'not_found' })
  })
  it.each(['UPDATE public.reporting_saved_reports SET artifact_canonical=artifact_canonical',
    'DELETE FROM public.reporting_saved_reports', 'TRUNCATE public.reporting_saved_reports'])('rejects immutable manifest mutation: %s', async sql => {
    await expect(db.exec(sql)).rejects.toThrow(/immutable|append-only/)
  })
  it.each(['anon', 'authenticated'])('denies %s manifest RPCs and table reads', async role => {
    await db.exec(`SET ROLE ${role}`)
    try {
      await expect(db.query('SELECT * FROM public.reporting_saved_reports')).rejects.toMatchObject({ code: '42501' })
      await expect(db.query('SELECT public.list_saved_reporting_reports($1,NULL,NULL)', [snapshotContext.account.id])).rejects.toMatchObject({ code: '42501' })
      await expect(db.query('SELECT public.read_saved_reporting_report($1,NULL,NULL,NULL)', [snapshotContext.account.id])).rejects.toMatchObject({ code: '42501' })
      await expect(db.query('SELECT public.save_reporting_report($1,$2,$3,$4)', [snapshotContext.account.id, SAVED_USER, randomUUID(), '{}'])).rejects.toMatchObject({ code: '42501' })
    } finally { await db.exec('RESET ROLE') }
  })
  it('allows scoped service RPCs but denies direct service table/snapshot publication', async () => {
    await db.exec('SET ROLE service_role')
    try {
      expect((await db.query<{ value: unknown[] }>('SELECT public.list_saved_reporting_reports($1,NULL,NULL) value', [snapshotContext.account.id])).rows[0].value.length).toBeGreaterThan(0)
      await expect(db.exec('INSERT INTO public.reporting_saved_reports DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' })
      await expect(db.exec('INSERT INTO public.reporting_snapshots DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' })
    } finally { await db.exec('RESET ROLE') }
  })
  it('stores foreign keys to each exact source and refuses a wrong receipt fingerprint at SQL publication', async () => {
    const client = savedTestClient(db), a = await publishSavedEvidence(db), input = savedInput(a)
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, input)
    const stored = (await readSavedReportManifest(client, snapshotContext.account.id, { id: saved.saved.id }))!
    const links = (await db.query<{ meta_snapshot_id: string; count: number }>('SELECT meta_snapshot_id FROM public.reporting_saved_reports WHERE id=$1', [saved.saved.id])).rows[0]
    expect(links.meta_snapshot_id).toBe(a.id)
    const constraints = await db.query<{ count: number }>("SELECT count(*)::int count FROM pg_constraint WHERE conrelid='public.reporting_saved_reports'::regclass AND confrelid='public.reporting_snapshots'::regclass")
    expect(constraints.rows[0].count).toBe(4)
    const artifact = structuredClone(stored.artifact), request = randomUUID()
    artifact.input.requestId = request
    if (!('receipt' in artifact.input.sources.meta)) throw new Error()
    artifact.input.sources.meta.receipt.fingerprint = `sha256:${'0'.repeat(64)}`
    await expect(db.query('SELECT public.save_reporting_report($1,$2,$3,$4)', [snapshotContext.account.id, SAVED_USER, request, canonicalReportingJson(artifact)])).rejects.toMatchObject({ code: '23514' })
  })
  it('reopens original historical playbook text without deriving the current playbook', async () => {
    const client = savedTestClient(db), original = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(db)))
    const stored = (await readSavedReportManifest(client, snapshotContext.account.id, { id: original.saved.id }))!
    const artifact = structuredClone(stored.artifact)
    artifact.input.requestId = randomUUID(); artifact.versions.playbook = 'historical-supported-playbook.v1'; artifact.review.playbookVersion = artifact.versions.playbook
    artifact.review.findings[0].observation.text = 'Original preserved assessment, before a later playbook.'
    artifact.input.reviewIdentity = reportingFingerprint(artifact.review)
    const historical = await insertSavedReportManifest(client, snapshotContext.account.id, SAVED_USER, artifact)
    const reopened = await openSavedReportingReport(client, snapshotContext.account, historical.id)
    expect(reopened.review.findings[0].observation.text).toBe(artifact.review.findings[0].observation.text)
    expect(reopened.review.playbookVersion).toBe('historical-supported-playbook.v1')
  })
  it('lists all account records with stable pagination and no repeated page members', async () => {
    const client = savedTestClient(db), original = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(db)))
    const stored = (await readSavedReportManifest(client, snapshotContext.account.id, { id: original.saved.id }))!
    for (let i = 0; i < 22; i++) await insertSavedReportManifest(client, snapshotContext.account.id, SAVED_USER,
      { ...stored.artifact, input: { ...stored.artifact.input, requestId: randomUUID(), title: `Page member ${i}` } })
    const first = await listSavedReportingReports(client, snapshotContext.account.id)
    expect(first.reports).toHaveLength(20); expect(first.nextCursor).not.toBeNull()
    const second = await listSavedReportingReports(client, snapshotContext.account.id, first.nextCursor)
    expect(second.reports.length).toBeGreaterThan(0)
    expect(second.reports.some(row => first.reports.some(prior => prior.id === row.id))).toBe(false)
    expect(await listSavedReportingReports(client, '00000000-0000-4000-8000-000000001312')).toEqual({ reports: [], nextCursor: null })
    await expect(listSavedReportingReports(client, snapshotContext.account.id, 'malformed')).rejects.toMatchObject({ code: 'invalid' })
  })
  it('lists unsupported historical formats, while exact open explicitly refuses them', async () => {
    const client = savedTestClient(db), original = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(db)))
    const stored = (await readSavedReportManifest(client, snapshotContext.account.id, { id: original.saved.id }))!
    const artifact = { ...stored.artifact, input: { ...stored.artifact.input, requestId: randomUUID() },
      versions: { ...stored.artifact.versions, export: 'report_export.unsupported' } }
    // Isolated owner fixture represents a record produced by another historical contract.
    await db.exec('ALTER TABLE public.reporting_saved_reports DISABLE TRIGGER reporting_saved_binding_trg')
    let id: string
    try { id = (await db.query<{ id: string }>(`INSERT INTO public.reporting_saved_reports
      (ad_account_id,created_by_user_id,request_id,artifact_canonical,artifact_fingerprint,meta_snapshot_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [snapshotContext.account.id, SAVED_USER, artifact.input.requestId,
      canonicalReportingJson(artifact), reportingFingerprint(artifact), original.saved.sources.meta.state === 'snapshot' ? original.saved.sources.meta.receipt.id : null])).rows[0].id
    } finally { await db.exec('ALTER TABLE public.reporting_saved_reports ENABLE TRIGGER reporting_saved_binding_trg') }
    await expect(openSavedReportingReport(client, snapshotContext.account, id)).rejects.toMatchObject({ code: 'incompatible' })
    const list = await listSavedReportingReports(client, snapshotContext.account.id)
    expect(list.reports.find(row => row.id === id)?.versions.export).toBe('report_export.unsupported')
  })
  it('persists exact evidence and review across a closed and reopened database', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'maxx-saved-restart-'))
    let persistent: PGlite | undefined
    try {
      persistent = await prepareSavedDb(directory)
      const original = await saveReportingReport(savedTestClient(persistent), snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(persistent, 7)))
      await persistent.close(); persistent = new Database(directory)
      const reopened = await openSavedReportingReport(savedTestClient(persistent), snapshotContext.account, original.saved.id)
      expect(reopened).toEqual(original)
    } finally { await persistent?.close(); await rm(directory, { recursive: true, force: true }) }
  })
  it.each(['missing', 'corrupt'] as const)('refuses %s original snapshot without switching to a newer same-scope publication', async fault => {
    const client = savedTestClient(db), original = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(db, 2)))
    await publishSavedEvidence(db, 30)
    const broken = { ...client, from: ((table: string) => ({ select: (columns: string) => {
      const query = client.from(table).select(columns), read = query.maybeSingle.bind(query)
      query.maybeSingle = (async () => {
        const result = await read()
        return { ...result, data: fault === 'missing' ? null : { ...(result.data as unknown as Record<string, unknown>), snapshot_canonical: '{}' } }
      }) as unknown as typeof query.maybeSingle
      return query
    } })) as typeof client.from }
    await expect(openSavedReportingReport(broken, snapshotContext.account, original.saved.id)).rejects.toMatchObject({ code: fault === 'missing' ? 'not_found' : 'invalid' })
    expect((await openSavedReportingReport(client, snapshotContext.account, original.saved.id)).data.meta.data?.metrics.clicks.current.value).toBe(2)
  })
  it('preserves original snapshot notes and the verified request-clamp explanation exactly', async () => {
    const client = savedTestClient(db), a = await publishSavedEvidence(db, 1, '2026-09-09')
    const saved = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(a))
    expect(saved.notes).toEqual([...a.snapshot.packet.notes,
      'The requested end date included an open or future account day. Reporting ends yesterday in the account timezone.'])
    expect((await openSavedReportingReport(client, snapshotContext.account, saved.saved.id)).notes).toEqual(saved.notes)
  })
  it('rejects stored notes that do not match their exact snapshot even when their own hash matches', async () => {
    const client = savedTestClient(db), original = await saveReportingReport(client, snapshotContext.account, SAVED_USER, savedInput(await publishSavedEvidence(db)))
    const stored = (await readSavedReportManifest(client, snapshotContext.account.id, { id: original.saved.id }))!
    const notes = ['A different interpretation presented as a source note.']
    const changed = await insertSavedReportManifest(client, snapshotContext.account.id, SAVED_USER, {
      ...stored.artifact, input: { ...stored.artifact.input, requestId: randomUUID() }, notes, notesIdentity: reportingFingerprint(notes),
    })
    await expect(openSavedReportingReport(client, snapshotContext.account, changed.id)).rejects.toMatchObject({ code: 'invalid' })
    expect((await openSavedReportingReport(client, snapshotContext.account, original.saved.id)).notes).toEqual(original.notes)
  })
})
