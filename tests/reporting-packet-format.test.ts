import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { buildWebsiteReport } from '@/lib/reporting/website-metrics'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric } from '@/lib/reporting/claims'
import type { ReportingPacket } from '@/lib/reporting/contracts'
import {
  compactReportingData, compactReportingPacket, expandPacket, expandReportingData, readStoredReportingPacket,
  REPORTING_PACKET_VERSION,
} from '@/lib/reporting/packet-format'
import { metaScaleContext, metaScaleResponse, type MetaScaleShape } from './fixtures/reporting-meta-scale'
import { snapshotPacket } from './fixtures/reporting-snapshot'
import { purchasePacket } from './fixtures/reporting-purchase'
import { platformContext, platformData } from './fixtures/reporting-business-platform'

const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown
type Tamperable = { section: string; context: { asOf: string }; notes: string[]; packetVersion: number; extra?: boolean
  result: { state: string; asOf: string | null; notes: string[]; data: object | null } }

beforeEach(() => {
  get.mockReset()
  history.mockReset(); history.mockImplementation(async (scope: { account: { id: string }; asOf: string }) => ({ accountId: scope.account.id,
    asOf: scope.asOf, state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] }))
})

async function scalePacket(label: string, campaigns: number, days: number): Promise<ReportingPacket> {
  const shape: MetaScaleShape = { label, campaigns, days, hierarchy: true }
  get.mockImplementation(async (path: string, params: Record<string, string>) => metaScaleResponse(shape, path, params))
  const context = metaScaleContext(shape)
  const result = await readMetaReport(context, { historyEntity: { level: 'campaign', id: '101' } })
  return { context, section: 'meta', result, notes: [] }
}

function websitePacket(): ReportingPacket {
  const totals = { sessions: 10, engagedSessions: 4, engagementRate: 0.4, users: 8, pageViews: 16 }
  const { report } = buildWebsiteReport(platformContext, { currentTotals: totals, previousTotals: totals,
    rows: [{ ...totals, landingPage: '/rentals', device: 'mobile', channel: 'Paid Social' }],
    events: [{ name: 'begin_checkout', device: 'mobile', channel: 'Paid Social', eventCount: 3 }],
    metadata: { timezone: platformContext.timezone, currency: platformContext.currency, subjectToThresholding: null,
      dataLossFromOtherRow: false, sampled: false, returnedRows: 2, totalRows: 2 } })
  return { section: 'website', context: platformContext, notes: [], result: { state: 'available', asOf: platformContext.asOf, notes: [], data: report } }
}

function measurementPacket(): ReportingPacket {
  const metric = makeReportMetric({ context: platformContext, source: 'capi', key: 'accepted_live_confirmations',
    label: 'Accepted live confirmations', definition: 'Confirmed delivery receipts for the selected confirmation cohort.',
    current: 4, unit: 'count', entity: { level: 'business', id: platformContext.account.id }, basis: 'booking_created_date_et',
    coverage: COMPLETE_FIELD_COVERAGE })
  return { section: 'measurement', context: platformContext, notes: ['Fictional.'], result: { state: 'partial', asOf: platformContext.asOf,
    notes: [], data: { paidAssociation: {}, capi: { accepted_live_confirmations: metric }, paidAssociationNotes: [], capiNotes: [],
      sourceDescription: 'Booking linkage and transport.' } } }
}

function fixturePackets(): Array<[string, ReportingPacket]> {
  const data = platformData()
  return [
    ['meta snapshot fixture', snapshotPacket()],
    ['meta purchase fixture', purchasePacket()],
    ['business fixture', { section: 'business', context: data.context, notes: [], result: data.business }],
    ['website fixture', websitePacket()],
    ['measurement fixture', measurementPacket()],
    ['unavailable meta', { section: 'meta', context: data.context, notes: ['n'], result: { state: 'unavailable', data: null, asOf: null, notes: ['x'] } }],
  ]
}

describe('compact report packet (packetVersion 2)', () => {
  it('expands to the exact bytes of every fixture packet', () => {
    for (const [name, packet] of fixturePackets()) {
      const compact = wire(compactReportingPacket(packet))
      const expanded = JSON.stringify(expandPacket(compact))
      expect(sha256(expanded), name).toBe(sha256(JSON.stringify(packet)))
      expect(validateReportingPacket(expandPacket(compact)), name).toEqual(validateReportingPacket(packet))
    }
  })

  it('expands a Meta build with hierarchy to the exact bytes, at a fraction of the size', async () => {
    for (const [campaigns, days] of [[3, 4], [12, 28]] as const) {
      const packet = await scalePacket(`${campaigns}x${days}h`, campaigns, days)
      const v1 = JSON.stringify(packet)
      const v2 = JSON.stringify(compactReportingPacket(packet))
      expect(sha256(JSON.stringify(expandPacket(JSON.parse(v2))))).toBe(sha256(v1))
      // Each claim and each metric definition is stored once, not once per occurrence.
      expect(v2.length).toBeLessThan(v1.length / (campaigns === 12 ? 8 : 4))
    }
  })

  it('keeps the fields storage triggers read at the top level of the stored packet', () => {
    const packet = snapshotPacket()
    const compact = compactReportingPacket(packet)
    expect(packet.result.data!.detailState).toBe('complete')
    expect(compact.packetVersion).toBe(REPORTING_PACKET_VERSION)
    expect(compact.section).toBe('meta')
    expect(compact.context).toEqual(packet.context)
    expect(compact.result).toEqual({ state: packet.result.state, data: { detailState: 'complete' }, asOf: packet.result.asOf, notes: packet.result.notes })
    const withoutDetail = { ...packet.result.data! }
    delete withoutDetail.detailState
    expect(compactReportingPacket({ ...packet, result: { ...packet.result, data: withoutDetail } }).result.data).toEqual({})
    const unavailable = fixturePackets().at(-1)![1]
    expect(compactReportingPacket(unavailable).result.data).toBeNull()
  })

  it('rejects a stored index that disagrees with the packet it describes', () => {
    const packet = snapshotPacket()
    const compact = wire(compactReportingPacket(packet)) as Record<string, unknown>
    expect(() => expandPacket(compact)).not.toThrow() // control
    const tampered: Array<(value: Tamperable) => void> = [
      value => { value.section = 'business' },
      value => { value.context.asOf = '2026-09-06T00:00:00.000Z' },
      value => { value.notes = ['changed'] },
      value => { value.result.state = 'available' },
      value => { value.result.asOf = null },
      value => { value.result.notes = ['changed'] },
      value => { value.result.data = { detailState: 'loading' } },
      value => { value.result.data = {} },
      value => { value.result.data = null },
      value => { value.packetVersion = 3 },
      value => { value.extra = true },
    ]
    for (const tamper of tampered) {
      const copy = structuredClone(compact) as Tamperable
      tamper(copy)
      expect(() => expandPacket(copy), tamper.toString()).toThrow()
    }
  })

  it('carries a changed table entry into every occurrence, where hashing and validation see it', () => {
    const packet = snapshotPacket()
    const original = wire(compactReportingPacket(packet)) as { compact: { values: unknown[] } }
    // A shared value changes everywhere it is used: the expansion's bytes (and so any fingerprint) differ.
    const value = structuredClone(original)
    const spend = packet.result.data!.metrics.clicks.current.value
    const position = value.compact.values.indexOf(spend)
    expect(position).toBeGreaterThanOrEqual(0)
    value.compact.values[position] = Number(spend) + 1
    expect(sha256(JSON.stringify(expandPacket(value)))).not.toBe(sha256(JSON.stringify(packet)))
    // A comparison date is shared by every prior-period claim; moving it takes them out of their period.
    const window = structuredClone(original)
    const start = window.compact.values.indexOf(packet.context.comparison.from)
    expect(start).toBeGreaterThanOrEqual(0)
    window.compact.values[start] = '2026-01-01'
    // The context holds the same date, so the stored index no longer describes the packet either.
    expect(() => expandPacket(window)).toThrow(/index/)
    expect(() => validateReportingPacket(expandPacket(original))).not.toThrow() // control
  })

  it('reads a stored v1 packet unchanged and dispatches a v2 packet to the expansion', () => {
    const packet = snapshotPacket()
    expect(readStoredReportingPacket(packet)).toBe(packet)
    expect(JSON.stringify(readStoredReportingPacket(wire(compactReportingPacket(packet))))).toBe(JSON.stringify(packet))
    expect(() => readStoredReportingPacket({ ...wire(compactReportingPacket(packet)) as object, packetVersion: 3 })).toThrow()
    expect(() => readStoredReportingPacket({ ...packet, packetVersion: 1 })).toThrow()
  })

  it('compacts assembled report data for transport and expands it to the exact bytes', () => {
    const data = platformData()
    const compact = wire(compactReportingData(data))
    expect(JSON.stringify(expandReportingData(compact))).toBe(JSON.stringify(data))
    expect(expandReportingData(data)).toBe(data)
    expect(() => expandReportingData({ dataVersion: 3, compact: (compact as { compact: unknown }).compact })).toThrow()
  })
})
