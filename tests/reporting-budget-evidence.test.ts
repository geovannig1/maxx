import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { resolveBudgetOwnership } from '@/lib/reporting/budget-evidence'
import { canonicalReportingJson, createReportingSnapshot, makeReportingSnapshotScope, reportingFingerprint } from '@/lib/reporting/snapshot-contract'
import { readLatestReportingSnapshot, type SnapshotDatabase } from '@/lib/reporting/snapshot-store'
import { compactReportingPacket } from '@/lib/reporting/packet-format'
import type { ReportingContext } from '@/lib/reporting/contracts'
import type { MetaRow } from '@/lib/reporting/meta-metrics'

const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
const context: ReportingContext = { account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional budget account' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z' }
const campaign = { id: '101', account_id: '123', name: 'Campaign', status: 'PAUSED', effective_status: 'PAUSED',
  daily_budget: '2000', lifetime_budget: '0', start_time: '2026-08-01T00:00:00-0400', stop_time: '2026-10-01T00:00:00-0400',
  updated_time: '2026-09-05T10:00:00-0400', is_adset_budget_sharing_enabled: true, is_budget_schedule_enabled: false }
const adset = { id: '201', account_id: '123', campaign_id: '101', name: 'Archived set', status: 'ARCHIVED', effective_status: 'CAMPAIGN_PAUSED',
  daily_budget: '0', lifetime_budget: '0', start_time: '2026-08-02T00:00:00-0400', end_time: '2026-09-30T00:00:00-0400',
  updated_time: '2026-09-05T11:00:00-0400', is_budget_schedule_enabled: true }
let campaigns: MetaRow[], adsets: MetaRow[]
function response(path: string, params: Record<string, string>): MetaRow {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: 'America/New_York' }
  if (path.endsWith('/campaigns')) return { data: campaigns }
  if (path.endsWith('/adsets')) return { data: adsets }
  if (path.endsWith('/ads') || path.endsWith('/customaudiences')) return { data: [] }
  if (path.endsWith('/insights')) {
    if (params.breakdowns || params.time_increment || params.level === 'ad') return { data: [] }
    const range = JSON.parse(params.time_range)
    return { data: [{ account_id: '123', campaign_id: '101', campaign_name: 'Campaign', adset_id: '201', adset_name: 'Archived set',
      date_start: range.since, date_stop: range.until, spend: '100', impressions: '1000',
      actions: [{ action_type: 'purchase', value: '2' }], action_values: [{ action_type: 'purchase', value: '200' }] }] }
  }
  throw new Error('Unexpected fictional request')
}
async function packet() {
  const result = await readMetaReport(context)
  const value = { context, section: 'meta' as const, result, notes: [] }
  expect(() => validateReportingPacket(value)).not.toThrow()
  return value
}
beforeEach(() => {
  campaigns = [{ ...campaign }]; adsets = [{ ...adset }]
  get.mockReset(); get.mockImplementation(response)
  history.mockReset(); history.mockResolvedValue({ accountId: context.account.id, asOf: context.asOf,
    state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] })
})

describe('native current budget evidence', () => {
  it('retains exact own amounts, statuses and outer times without applying them to the historical period', async () => {
    const { result } = await packet()
    const parent = result.data!.entities.find(item => item.level === 'campaign')!
    const child = result.data!.entities.find(item => item.level === 'adset')!
    expect(parent.budgetEvidence).toMatchObject({ version: 1, accountId: context.account.id, metaAccountId: '123',
      entity: { level: 'campaign', id: '101' }, campaignId: '101', observedAt: context.asOf,
      dailyBudget: { state: 'observed', minorUnits: 2000, majorUnits: 20 }, lifetimeBudget: { state: 'observed', minorUnits: 0, majorUnits: 0 },
      configuredStatus: { state: 'observed', value: 'PAUSED' }, effectiveStatus: { state: 'observed', value: 'PAUSED' },
      startTime: { state: 'observed', value: '2026-08-01T00:00:00-04:00' }, endTime: { state: 'observed', value: '2026-10-01T00:00:00-04:00' },
      metaUpdatedAt: { state: 'observed', value: '2026-09-05T10:00:00-04:00' },
      adsetBudgetSharing: { state: 'observed', value: true }, budgetScheduleEnabled: { state: 'observed', value: false } })
    expect(child.budgetEvidence).toMatchObject({ entity: { level: 'adset', id: '201' }, campaignId: '101',
      dailyBudget: { state: 'observed', minorUnits: 0, majorUnits: 0 }, configuredStatus: { value: 'ARCHIVED' },
      effectiveStatus: { value: 'CAMPAIGN_PAUSED' }, endTime: { value: '2026-09-30T00:00:00-04:00' },
      adsetBudgetSharing: { state: 'missing', value: null }, budgetScheduleEnabled: { state: 'observed', value: true } })
    expect(parent.metrics.spend.current.value).toBe(100)
    expect(parent.budgetEvidence).not.toHaveProperty('window')
    for (const [path, params] of get.mock.calls) if (path.endsWith('/campaigns') || path.endsWith('/adsets')) {
      expect(params).not.toHaveProperty('filtering')
      expect(params.fields).toContain('account_id')
      expect(params.fields).toContain('daily_budget')
    }
  })
  it.each(['20.00', '20oops', '-1', '1e3', ' 2000 ', '9007199254740992', 20])('does not permissively parse or double-convert invalid native minor units %s', async value => {
    campaigns = [{ ...campaign, daily_budget: value }]
    const { result } = await packet()
    expect(result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence?.dailyBudget)
      .toEqual({ state: 'invalid', minorUnits: null, majorUnits: null })
    expect(result.data!.metrics.spend.current.value).toBe(100)
  })
  it('distinguishes absent budget from observed zero and keeps unknown sharing unknown', async () => {
    campaigns = [{ id: '101', account_id: '123', daily_budget: '0' }]
    const { result } = await packet()
    expect(result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence).toMatchObject({
      dailyBudget: { state: 'observed', majorUnits: 0 }, lifetimeBudget: { state: 'missing', minorUnits: null, majorUnits: null },
      configuredStatus: { state: 'missing', value: null }, adsetBudgetSharing: { state: 'missing', value: null } })
  })
  it('removes only a rejected optional budget field and retains supported configuration without raw error text', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/campaigns') && params.fields.split(',').includes('daily_budget'))
        throw Object.assign(new Error('Unsupported field daily_budget synthetic-private-body'), { code: 100 })
      return response(path, params)
    })
    const { result } = await packet()
    expect(get.mock.calls.filter(([path]) => path.endsWith('/campaigns'))).toHaveLength(2)
    expect(result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence).toMatchObject({
      dailyBudget: { state: 'missing', majorUnits: null }, lifetimeBudget: { state: 'observed', majorUnits: 0 }, configuredStatus: { value: 'PAUSED' } })
    expect(result.notes.join(' ')).toContain('daily_budget')
    expect(result.notes.join(' ')).not.toContain('synthetic-private-body')
  })
  it.each(['foreign account', 'duplicate', 'parent conflict'])('does not attach rejected %s configuration to healthy native performance', async kind => {
    if (kind === 'foreign account') adsets = [{ ...adset, account_id: '999' }]
    if (kind === 'duplicate') adsets = [{ ...adset }, { ...adset, daily_budget: '9999' }]
    if (kind === 'parent conflict') adsets = [{ ...adset, campaign_id: '999' }]
    const { result } = await packet()
    const child = result.data!.entities.find(item => item.level === 'adset')!
    expect(child.budgetEvidence).toBeUndefined()
    expect(child.metrics.spend.current.value).toBe(100)
  })
  it('preserves native cents exactly, including a single cent and a lifetime budget', async () => {
    campaigns = [{ ...campaign, daily_budget: '1', lifetime_budget: '100000' }]
    const { result } = await packet()
    expect(result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence).toMatchObject({
      dailyBudget: { minorUnits: 1, majorUnits: 0.01 }, lifetimeBudget: { minorUnits: 100000, majorUnits: 1000 } })
  })
  it.each(['bad date', 'inverted dates', 'future update', 'wrong flags'])('keeps malformed %s local to that native field', async mode => {
    if (mode === 'bad date') campaigns = [{ ...campaign, start_time: '2026-02-30T00:00:00Z' }]
    if (mode === 'inverted dates') campaigns = [{ ...campaign, start_time: '2026-10-02T00:00:00Z' }]
    if (mode === 'future update') campaigns = [{ ...campaign, updated_time: '2026-09-05T16:00:00.000000001Z' }]
    if (mode === 'wrong flags') campaigns = [{ ...campaign, is_adset_budget_sharing_enabled: 'false', is_budget_schedule_enabled: 0 }]
    const { result } = await packet()
    const evidence = result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence!
    expect(evidence.dailyBudget.majorUnits).toBe(20)
    if (mode === 'future update') expect(evidence.metaUpdatedAt).toEqual({ state: 'invalid', value: null })
    else if (mode === 'wrong flags') {
      expect(evidence.adsetBudgetSharing).toEqual({ state: 'invalid', value: null })
      expect(evidence.budgetScheduleEnabled).toEqual({ state: 'invalid', value: null })
    } else expect(evidence.startTime).toEqual({ state: 'invalid', value: null })
  })
  it.each(['configuration', 'performance'])('preserves independent usable evidence when %s fails', async failed => {
    get.mockImplementation((path, params) => {
      if (failed === 'configuration' && (path.endsWith('/campaigns') || path.endsWith('/adsets')))
        throw new Error('Fictional configuration read failure')
      if (failed === 'performance' && path.endsWith('/insights')) throw new Error('Fictional performance read failure')
      return response(path, params)
    })
    const { result } = await packet()
    const parent = result.data!.entities.find(item => item.level === 'campaign')!
    if (failed === 'configuration') { expect(parent.budgetEvidence).toBeUndefined(); expect(parent.metrics.spend.current.value).toBe(100) }
    else { expect(parent.budgetEvidence!.dailyBudget.majorUnits).toBe(20); expect(parent.metrics.spend?.current.value ?? null).toBeNull() }
  })
  it('uses fixed-path native pagination without dropping inactive budgets or trusting a paging URL', async () => {
    get.mockImplementation((path, params) => path.endsWith('/campaigns') ? params.after
      ? { data: [{ ...campaign, id: '102', status: 'ARCHIVED', daily_budget: '500' }] }
      : { data: campaigns, paging: { next: 'https://untrusted.invalid/credentials', cursors: { after: 'next' } } }
      : response(path, params))
    const { result } = await packet()
    expect(result.data!.entities.find(item => item.id === '102')!.budgetEvidence?.dailyBudget.majorUnits).toBe(5)
    const calls = get.mock.calls.filter(([path]) => path.endsWith('/campaigns'))
    expect(calls).toHaveLength(2)
    expect(calls[1][0]).toBe('/act_123/campaigns')
    expect(calls[1][1].fields).toBe(calls[0][1].fields)
    expect(calls[1][1]).not.toHaveProperty('filtering')
  })
  it('bounds unspecified optional-field fallback and retains original required configuration fields', async () => {
    get.mockImplementation((path, params) => {
      if (path.endsWith('/campaigns') && params.fields.includes('daily_budget'))
        throw Object.assign(new Error('Invalid optional field combination fictional-private-message'), { code: 100 })
      return response(path, params)
    })
    const { result } = await packet()
    const calls = get.mock.calls.filter(([path]) => path.endsWith('/campaigns'))
    expect(calls).toHaveLength(2)
    expect(calls[1][1].fields).toBe('id,name,status,effective_status,objective,updated_time')
    expect(result.data!.entities.find(item => item.level === 'campaign')!.budgetEvidence).toMatchObject({
      configuredStatus: { value: 'PAUSED' }, dailyBudget: { state: 'missing', majorUnits: null } })
    expect(result.notes.join(' ')).not.toContain('fictional-private-message')
  })
  it('does not make configuration calls when the account currency is unverified', async () => {
    get.mockImplementation(() => ({ id: 'act_123', currency: 'EUR', timezone_name: 'America/New_York' }))
    const { result } = await packet()
    expect(result.data).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })
})

describe('budget ownership and immutable scope', () => {
  it('references one observed campaign budget without copying its allocation to the child', async () => {
    const { result } = await packet(); const entities = result.data!.entities
    const parent = entities.find(item => item.level === 'campaign')!, child = entities.find(item => item.level === 'adset')!
    expect(resolveBudgetOwnership(parent, entities)).toMatchObject({ state: 'own', owner: { entity: { id: '101' } } })
    expect(resolveBudgetOwnership(child, entities)).toMatchObject({ state: 'campaign', owner: { entity: { id: '101' }, dailyBudget: { majorUnits: 20 } } })
    expect(child.budgetEvidence?.dailyBudget.majorUnits).toBe(0)
  })
  it.each(['own', 'both', 'unknown', 'two types'])('qualifies %s native ownership without inferring isolated allocation or a zero budget', async mode => {
    if (mode === 'own') { campaigns = [{ ...campaign, daily_budget: '0' }]; adsets = [{ ...adset, daily_budget: '1500' }] }
    if (mode === 'both') adsets = [{ ...adset, daily_budget: '1500' }]
    if (mode === 'unknown') adsets = [{ id: '201', campaign_id: '101', account_id: '123' }]
    if (mode === 'two types') campaigns = [{ ...campaign, lifetime_budget: '100000' }]
    const { result } = await packet(); const entities = result.data!.entities
    const child = entities.find(item => item.level === 'adset')!
    const resolution = resolveBudgetOwnership(child, entities)
    expect(resolution.state).toBe(mode === 'own' ? 'own' : 'undetermined')
    expect(resolution.parent?.adsetBudgetSharing).toMatchObject({ state: 'observed', value: true })
    if (mode === 'own') expect(resolution.owner?.entity.id).toBe('201')
    else expect(resolution.owner).toBeNull()
  })
  it('validates old packets without adding current settings', async () => {
    const value = await packet()
    const legacy = { ...value, result: { ...value.result, data: { ...value.result.data!, entities: value.result.data!.entities.map(entity =>
      Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'budgetEvidence'))) } } }
    const before = JSON.stringify(legacy)
    const parsed = validateReportingPacket(legacy)
    expect(canonicalReportingJson(parsed)).toBe(canonicalReportingJson(legacy))
    expect(JSON.stringify(legacy)).toBe(before)
    expect(JSON.stringify(parsed)).not.toContain('budgetEvidence')
  })
  it.each(['account', 'meta account', 'entity', 'parent', 'future observed', 'future updated', 'double conversion', 'wrong time', 'reversed schedule', 'ad level'])('rejects altered %s budget evidence without weakening healthy packet validation', async mode => {
    const value = await packet(); const changed = structuredClone(value)
    const child = changed.result.data!.entities.find(item => item.level === 'adset')!, evidence = child.budgetEvidence!
    if (mode === 'account') evidence.accountId = 'foreign'
    if (mode === 'meta account') evidence.metaAccountId = '999'
    if (mode === 'entity') evidence.entity.id = 'foreign'
    if (mode === 'parent') evidence.campaignId = 'foreign'
    if (mode === 'future observed') { evidence.observedAt = '2026-09-05T16:00:00.000000001Z'; child.configurationAsOf = evidence.observedAt }
    if (mode === 'future updated') evidence.metaUpdatedAt = { state: 'observed', value: '2026-09-05T16:00:00.000000001Z' }
    if (mode === 'double conversion') evidence.dailyBudget = { state: 'observed', minorUnits: 2000, majorUnits: 0.2 }
    if (mode === 'wrong time') evidence.observedAt = '2026-09-05T15:00:00Z'
    if (mode === 'reversed schedule') evidence.startTime = { state: 'observed', value: '2026-10-01T00:00:00Z' }
    if (mode === 'ad level') child.level = 'ad'
    expect(() => validateReportingPacket(changed)).toThrow()
  })
})

// the budget amount was keyed `usd` before. Stored snapshots are fingerprinted, so one written with
// `usd` keeps its bytes and is upgraded when read, in either stored packet version.
describe('stored budget evidence written with the legacy `usd` key', () => {
  const completedAt = '2026-09-05T17:00:40.000Z'
  function legacyKeyed<T>(value: T): T {
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk)
      if (v === null || typeof v !== 'object') return v
      const entries = Object.entries(v as Record<string, unknown>)
      const isAmount = entries.some(([key]) => key === 'minorUnits') && entries.some(([key]) => key === 'majorUnits')
      return Object.fromEntries(entries.map(([key, entry]) => [isAmount && key === 'majorUnits' ? 'usd' : key, walk(entry)]))
    }
    return walk(value) as T
  }
  function database(stored: { retrieval: { startedAt: string } }, scope: ReturnType<typeof makeReportingSnapshotScope>) {
    const data = { id: '00000000-0000-4000-8000-000000001414', ad_account_id: scope.accountId, source: scope.source,
      scope_key: reportingFingerprint(scope), scope_canonical: canonicalReportingJson(scope),
      evidence_fingerprint: reportingFingerprint(stored), snapshot_canonical: canonicalReportingJson(stored),
      retrieval_started_at: stored.retrieval.startedAt, retrieval_completed_at: completedAt, created_at: '2026-09-05T17:00:41.000Z' }
    const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) }
    for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal'] as const) query[method].mockReturnValue(query)
    return { from: vi.fn().mockReturnValue(query) } as unknown as SnapshotDatabase
  }
  async function current() {
    const value = await packet()
    const scope = makeReportingSnapshotScope('meta', value.context)
    return { scope, snapshot: createReportingSnapshot(scope, value, completedAt) }
  }

  it('reads a current stored snapshot as stored (harness control)', async () => {
    const { scope, snapshot } = await current()
    expect(canonicalReportingJson(snapshot)).toContain('"majorUnits":20')
    expect((await readLatestReportingSnapshot(database(snapshot, scope), scope))?.snapshot).toEqual(snapshot)
  })

  it.each(['v1', 'v2'] as const)('reads a stored %s snapshot keyed `usd` as the current one, keeping its fingerprint', async version => {
    const { scope, snapshot } = await current()
    const legacy = legacyKeyed(snapshot)
    expect(canonicalReportingJson(legacy)).toContain('"usd":20')
    expect(canonicalReportingJson(legacy)).not.toContain('majorUnits')
    const stored = version === 'v1' ? legacy : { ...legacy, packet: compactReportingPacket(legacy.packet) }
    const read = await readLatestReportingSnapshot(database(stored, scope), scope)
    expect(read?.snapshot).toEqual(snapshot)
    expect(read?.fingerprint).toBe(reportingFingerprint(stored))
    // A legacy v2 packet is never handed out as stored: its bytes still carry the old key.
    expect(read?.storedPacket).toBeUndefined()
  })

  // before the v1 release the legacy amount was minorUnits / 100 for EVERY currency, so a JPY packet stored
  // 20 for a 2000-yen budget. minorUnits is exact; the upgrade recomputes the amount in the packet's
  // currency, and the fingerprint still covers the stored bytes.
  it.each(['v1', 'v2'] as const)('reads an old JPY %s snapshot whose `usd` was minorUnits / 100', async version => {
    get.mockImplementation((path: string, params: Record<string, string>) =>
      path === '/act_123' ? { id: 'act_123', currency: 'JPY', timezone_name: 'America/New_York' } : response(path, params))
    const jpy = { ...context, currency: 'JPY' }
    const value = { context: jpy, section: 'meta' as const, result: await readMetaReport(jpy), notes: [] }
    const scope = makeReportingSnapshotScope('meta', jpy)
    const snapshot = createReportingSnapshot(scope, value, completedAt)
    expect(canonicalReportingJson(snapshot)).toContain('"majorUnits":2000,"minorUnits":2000')
    // What the legacy writer stored: the same key renamed, and the amount computed as minorUnits / 100.
    const centsFor = (value: unknown, amount: (minor: number) => number): unknown => {
      if (Array.isArray(value)) return value.map(item => centsFor(item, amount))
      if (value === null || typeof value !== 'object') return value
      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.entries(record).map(([key, entry]) =>
        [key, key === 'usd' && typeof record.minorUnits === 'number' ? amount(record.minorUnits) : centsFor(entry, amount)]))
    }
    const legacy = centsFor(legacyKeyed(snapshot), minor => minor / 100) as typeof snapshot
    expect(canonicalReportingJson(legacy)).toContain('"minorUnits":2000,"state":"observed","usd":20')
    const stored = version === 'v1' ? legacy : { ...legacy, packet: compactReportingPacket(legacy.packet) }
    const read = await readLatestReportingSnapshot(database(stored, scope), scope)
    expect(read?.snapshot).toEqual(snapshot)
    expect(read?.fingerprint).toBe(reportingFingerprint(stored))
    // Control: an amount that was never minorUnits / 100 is not repaired; the read still fails closed.
    const corrupt = centsFor(legacyKeyed(snapshot), minor => minor / 100 + 1) as typeof snapshot
    const corruptStored = version === 'v1' ? corrupt : { ...corrupt, packet: compactReportingPacket(corrupt.packet) }
    await expect(readLatestReportingSnapshot(database(corruptStored, scope), scope)).rejects.toThrow()
  })
})
