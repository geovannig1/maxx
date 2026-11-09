import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import { loadReportingSection } from '@/lib/reporting/loader'
import { runReportingRefresh } from '@/lib/reporting/refresh-worker'
import { pendingPacket, refreshDatabase, refreshJob, refreshSnapshotId } from './fixtures/reporting-refresh'
import { snapshotPacket } from './fixtures/reporting-snapshot'
import { expandPacket } from '@/lib/reporting/packet-format'

vi.mock('@/lib/reporting/loader', () => ({ loadReportingSection: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-05T17:00:05.000Z')
  vi.mocked(loadReportingSection).mockReset().mockResolvedValue(snapshotPacket())
})
afterEach(() => vi.useRealTimers())

describe('owned prepared reporting refresh worker', () => {
  it('carries the exact selected parent into its isolated source generation', async () => {
    const fake = refreshDatabase(), historyEntity = { level: 'adset', id: 'set-7' } as const
    const job = refreshJob()
    await runReportingRefresh(fake.db, { ...job, scope: { ...job.scope, historyEntity } }, 'Studio')
    expect(vi.mocked(loadReportingSection).mock.calls[0][6]).toEqual({ isolateGeneration: true, historyEntity })
  })
  it('preserves a missing account display name in the source context', async () => {
    const fake = refreshDatabase()
    expect((await runReportingRefresh(fake.db, refreshJob(), null)).status).toBe('complete')
    expect(vi.mocked(loadReportingSection).mock.calls[0][1].account.name).toBeNull()
  })

  it('forces an isolated source generation from the SQL start clock and atomically stores actual completion', async () => {
    const fake = refreshDatabase()
    expect(await runReportingRefresh(fake.db, refreshJob(), 'Current account name'))
      .toEqual({ status: 'complete', snapshotId: refreshSnapshotId })
    expect(loadReportingSection).toHaveBeenCalledWith('meta', {
      account: { id: refreshJob().scope.accountId, metaAccountId: 'act_123', name: 'Current account name' },
      range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
      timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T17:00:00.000Z',
    }, true, [], expect.any(Function), undefined, { isolateGeneration: true })
    const [name, args] = fake.rpc.mock.calls[0]
    expect(name).toBe('finish_reporting_refresh')
    const snapshot = JSON.parse((args as { p_snapshot_canonical: string }).p_snapshot_canonical)
    expect(snapshot.retrieval).toEqual({ startedAt: '2026-09-05T17:00:00.000Z', completedAt: '2026-09-05T17:00:05.000Z' })
    expect(snapshot.packet.packetVersion).toBe(2)
    expect((expandPacket(snapshot.packet) as typeof snapshot.packet).result.data.metrics.clicks.current.value).toBe(0)
    expect(fake.from).not.toHaveBeenCalled()
  })

  it('publishes validated pending Meta while optional reads are delayed and awaits publication before finish', async () => {
    const fake = refreshDatabase()
    let finishSource!: (packet: ReportingPacket) => void
    let finishProgress!: (value: { data: boolean; error: null }) => void
    fake.rpcResult.mockImplementation(async name => name === 'publish_reporting_refresh_progress'
      ? new Promise(resolve => { finishProgress = resolve })
      : { data: { committed: true, snapshot_id: refreshSnapshotId }, error: null })
    vi.mocked(loadReportingSection).mockImplementation(async (_section, _context, _refresh, _ids, progress) => {
      progress?.(pendingPacket())
      return new Promise(resolve => { finishSource = resolve })
    })
    const outcome = runReportingRefresh(fake.db, refreshJob(), 'Studio')
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['publish_reporting_refresh_progress'])
    finishSource(snapshotPacket())
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.rpc).toHaveBeenCalledTimes(1)
    finishProgress({ data: true, error: null })
    expect(await outcome).toEqual({ status: 'complete', snapshotId: refreshSnapshotId })
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['publish_reporting_refresh_progress', 'finish_reporting_refresh'])
  })

  it('allows a valid final report after progress storage fails without an unhandled rejection', async () => {
    const fake = refreshDatabase()
    fake.rpcResult.mockImplementation(async name => ({
      data: name === 'finish_reporting_refresh' ? { committed: true, snapshot_id: refreshSnapshotId } : null,
      error: name === 'publish_reporting_refresh_progress' ? { message: 'private store failure' } : null,
    }))
    vi.mocked(loadReportingSection).mockImplementation(async (_section, _context, _refresh, _ids, progress) => {
      progress?.(pendingPacket())
      return snapshotPacket()
    })
    expect(await runReportingRefresh(fake.db, refreshJob(), 'Studio')).toEqual({ status: 'complete', snapshotId: refreshSnapshotId })
  })

  it('does not publish malformed progress or continue accepting progress after terminal completion', async () => {
    const fake = refreshDatabase()
    let notify: ((packet: ReportingPacket) => void) | undefined
    vi.mocked(loadReportingSection).mockImplementation(async (_section, _context, _refresh, _ids, progress) => {
      notify = progress
      const wrong = pendingPacket()
      wrong.context.account.metaAccountId = 'act_999'
      progress?.(wrong)
      return snapshotPacket()
    })
    expect((await runReportingRefresh(fake.db, refreshJob(), 'Studio')).status).toBe('complete')
    notify?.(pendingPacket())
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['finish_reporting_refresh'])
  })

  it.each(['failed', 'complete', 'expired'] as const)('rejects %s ownership before any source read', async state => {
    const job = refreshJob()
    const invalid = state === 'expired' ? { ...job, leaseExpiresAt: '2026-09-05T17:00:05.000Z' }
      : { ...job, status: state }
    expect(await runReportingRefresh(refreshDatabase().db, invalid, 'Studio')).toEqual({ status: 'superseded' })
    expect(loadReportingSection).not.toHaveBeenCalled()
  })

  it('does not claim publication when the fenced finish loses ownership', async () => {
    const fake = refreshDatabase()
    fake.rpcResult.mockResolvedValue({ data: { committed: false, snapshot_id: null }, error: null })
    expect(await runReportingRefresh(fake.db, refreshJob(), 'Studio')).toEqual({ status: 'superseded' })
    expect(fake.rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['source_unavailable', () => { throw new Error('private source details') }],
    ['source_unavailable', () => ({ ...snapshotPacket(), result: { state: 'unavailable', data: null, asOf: null, notes: [] } })],
    ['invalid_report', () => ({ malformed: true })],
    ['invalid_report', () => pendingPacket()],
    ['invalid_report', () => {
      const packet = structuredClone(snapshotPacket())
      packet.context.asOf = '2026-09-05T17:00:01.000Z'
      return packet
    }],
  ] as const)('marks bounded %s failure for invalid or unavailable source results', async (code, result) => {
    const fake = refreshDatabase()
    vi.mocked(loadReportingSection).mockImplementation(async () => result() as ReportingPacket)
    expect(await runReportingRefresh(fake.db, refreshJob(), 'Studio')).toEqual({ status: 'failed', failureCode: code })
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['fail_reporting_refresh'])
    expect(fake.rpc.mock.calls[0][1]).toMatchObject({ p_code: code })
  })

  it('marks final storage failure without exposing database detail and bounds failed failure-recording', async () => {
    const fake = refreshDatabase()
    fake.rpcResult.mockResolvedValue({ data: null, error: { message: 'secret database detail' } })
    expect(await runReportingRefresh(fake.db, refreshJob(), 'Studio')).toEqual({ status: 'failed', failureCode: 'storage_unavailable' })
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(['finish_reporting_refresh', 'fail_reporting_refresh'])
    fake.rpcResult.mockReturnValue(new Promise(() => {}))
    vi.mocked(loadReportingSection).mockRejectedValue(new Error('private upstream exception'))
    const pending = runReportingRefresh(fake.db, refreshJob(), 'Studio')
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await pending).toEqual({ status: 'failed', failureCode: 'source_unavailable' })
    expect(fake.rpcSignals.at(-1)?.aborted).toBe(true)
  })
})
