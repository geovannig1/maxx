import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { savedPreviewSnapshots } from './reporting-browser/saved-preview-fixture'
import { assembleSavedReportData } from '@/lib/reporting/saved-assembly'
import { deriveExpertReview } from '@/lib/reporting/review'
import { savedReportIdentity } from '@/lib/reporting/saved-identity'
import { readSavedReport } from '@/lib/reporting/saved-client'
import { expandReportingData } from '@/lib/reporting/packet-format'
import { SAVED_SOURCES, type OpenSavedReportingReportReply, type SavedReportSources } from '@/lib/reporting/saved-contract'

// An opened saved report carries every source's evidence; it travels as compact data (dataVersion 2) and
// the browser checks the saved data identity against the expansion.
const mocks = vi.hoisted(() => ({ auth: vi.fn(), owner: vi.fn(), account: vi.fn(), save: vi.fn(), list: vi.fn(), open: vi.fn(), admin: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.auth } }) }))
vi.mock('@/lib/auth/owner', () => ({ ownerGate: mocks.owner }))
vi.mock('@/lib/accounts/active-account', () => ({
  resolveOnlyActiveAccount: mocks.account,
  activeAccountErrorCode: (reason: string) => `ACTIVE_ACCOUNT_${reason.toUpperCase()}`,
}))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: mocks.admin }))
vi.mock('@/lib/reporting/saved-service', () => ({ saveReportingReport: mocks.save, listSavedReportingReports: mocks.list, openSavedReportingReport: mocks.open }))
import { GET as OPEN } from '@/app/api/reporting/saved/[id]/route'

async function savedReply(): Promise<OpenSavedReportingReportReply> {
  const snapshots = savedPreviewSnapshots('movement', '2026-09-02', '2026-09-04')
  const sources = Object.fromEntries(SAVED_SOURCES.map(source => {
    const stored = snapshots[source], snapshot = stored.snapshot
    return [source, { state: 'snapshot', receipt: { id: stored.id, fingerprint: stored.fingerprint, scope: snapshot.scope,
      retrievalStartedAt: snapshot.retrieval.startedAt, retrievalCompletedAt: snapshot.retrieval.completedAt, sourceAsOf: snapshot.sourceAsOf } }]
  })) as SavedReportSources
  const data = assembleSavedReportData(Object.fromEntries(SAVED_SOURCES.map(source => [source, snapshots[source].snapshot.packet])), sources)
  const review = deriveExpertReview(data)
  const notes = [...new Set(Object.values(snapshots).flatMap(stored => stored.snapshot.packet.notes))]
  const view = { pathname: '/dashboard' as const, query: { from: '2026-09-02', to: '2026-09-04' } }
  return { saved: { id: crypto.randomUUID(), title: 'Saved transport', createdAt: new Date().toISOString(), view, range: data.context.range,
    sourceSummary: sources, sources, reviewIdentity: await savedReportIdentity(review), dataIdentity: await savedReportIdentity(data),
    notesIdentity: await savedReportIdentity(notes),
    versions: { manifest: 'saved_report.v1', review: 'report_review.v1', playbook: review.playbookVersion, export: 'report_export.v1' } },
  data, review, notes }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ data: { user: { id: '00000000-0000-4000-8000-000000001403', email: 'owner@example.test' } } })
  mocks.owner.mockReturnValue({ allowed: true })
  mocks.admin.mockReturnValue({ rpc: 'db' })
})
afterEach(() => vi.unstubAllGlobals())

describe('saved report transport', () => {
  it('sends opened report data as dataVersion 2, and the browser reads the same validated reply', async () => {
    const reply = await savedReply()
    const context = reply.data.context
    mocks.account.mockResolvedValue({ ok: true, account: { id: context.account.id, accountId: context.account.metaAccountId, accountName: context.account.name } })
    mocks.open.mockResolvedValue(reply)
    const response = await OPEN(new NextRequest(`http://localhost/api/reporting/saved/${reply.saved.id}`), { params: Promise.resolve({ id: reply.saved.id }) })
    expect(response.status).toBe(200)
    const text = await response.clone().text()
    const body = JSON.parse(text) as { data: { dataVersion?: number } }
    expect(body.data.dataVersion).toBe(2)
    expect(JSON.stringify(expandReportingData(body.data))).toBe(JSON.stringify(reply.data))
    expect(text.length).toBeLessThan(JSON.stringify(reply).length)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response))
    expect(await readSavedReport(reply.saved.id, new AbortController().signal)).toEqual(reply)
  })

  it('refuses compact data whose expansion no longer matches the saved data identity', async () => {
    const reply = await savedReply()
    mocks.account.mockResolvedValue({ ok: true, account: { id: reply.data.context.account.id,
      accountId: reply.data.context.account.metaAccountId, accountName: reply.data.context.account.name } })
    mocks.open.mockResolvedValue(reply)
    const response = await OPEN(new NextRequest(`http://localhost/api/reporting/saved/${reply.saved.id}`), { params: Promise.resolve({ id: reply.saved.id }) })
    const body = await response.json() as { data: { compact: { values: unknown[] } } }
    const spend = reply.data.meta.data!.metrics.spend.current.value as number
    const position = body.data.compact.values.indexOf(spend)
    expect(position).toBeGreaterThanOrEqual(0)
    body.data.compact.values[position] = spend + 1
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })))
    await expect(readSavedReport(reply.saved.id, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('still reads a plain saved reply', async () => {
    const reply = await savedReply()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } })))
    expect(await readSavedReport(reply.saved.id, new AbortController().signal)).toEqual(reply)
  })
})
