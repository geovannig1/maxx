import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMetricClaim, MetricClaimSchema, type MetricClaim } from '@/lib/cockpit/contracts'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { ReportingPacketSchema, type ReportMetricMap, type ReportingPacket } from '@/lib/reporting/contracts'
import { dailyMetaMetrics } from '@/lib/reporting/meta-breakdowns'
import { compactReportingPacket, expandPacket } from '@/lib/reporting/packet-format'
import { metaScaleContext, metaScaleResponse, type MetaScaleShape } from './fixtures/reporting-meta-scale'
import { snapshotPacket } from './fixtures/reporting-snapshot'
import { purchasePacket } from './fixtures/reporting-purchase'
import { platformData } from './fixtures/reporting-business-platform'

// Each distinct claim is validated once:
// - a daily series claim was zod-parsed when built, then parsed again in full only to append `:daily` to
//   its id. Re-identifying now validates only the fields that change (the ids);
// - an expanded compact packet shares one frozen object per distinct claim; packet validation now
//   validates each distinct frozen claim once instead of once per occurrence.
// Equivalence with the previous behaviour is checked on the existing fixtures: same success, same
// output, same issues.

const { get, history } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

beforeEach(() => {
  get.mockReset()
  history.mockReset(); history.mockImplementation(async (scope: { account: { id: string }; asOf: string }) => ({ accountId: scope.account.id,
    asOf: scope.asOf, state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] }))
})
afterEach(() => vi.restoreAllMocks())

async function scalePacket(campaigns: number, days: number): Promise<ReportingPacket> {
  const shape: MetaScaleShape = { label: `once-${campaigns}x${days}`, campaigns, days, hierarchy: true }
  get.mockImplementation(async (path: string, params: Record<string, string>) => metaScaleResponse(shape, path, params))
  const context = metaScaleContext(shape)
  return { context, section: 'meta', result: await readMetaReport(context, { historyEntity: { level: 'campaign', id: '101' } }), notes: [] }
}

/** The previous dailyMetaMetrics: every claim re-parsed in full. */
function previousDailyMetaMetrics(metrics: ReportMetricMap): ReportMetricMap {
  const ids = new Map(Object.values(metrics).flatMap(metric => [metric.current, metric.previous].flatMap(claim => claim ? [[claim.claimId, `${claim.claimId}:daily`] as const] : [])))
  const claim = (value: MetricClaim) => createMetricClaim({ ...value, claimId: ids.get(value.claimId)!, inputClaimIds: value.inputClaimIds.map(id => ids.get(id) ?? id) })
  return Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, { ...metric, current: claim(metric.current), previous: metric.previous ? claim(metric.previous) : null }]))
}

const outcome = (run: () => unknown) => {
  try { return { ok: true, value: JSON.stringify(run()) } } catch (error) { return { ok: false, value: error instanceof Error ? error.name : String(error) } }
}

function claimsOf(value: unknown, out: unknown[] = []): unknown[] {
  if (value && typeof value === 'object') {
    if ('claimId' in value && 'inputClaimIds' in value) out.push(value)
    else for (const child of Object.values(value)) claimsOf(child, out)
  }
  return out
}

function fixturePackets(scale: ReportingPacket): Array<[string, ReportingPacket]> {
  const data = platformData()
  return [
    ['meta scale (hierarchy, daily series)', scale],
    ['meta snapshot', snapshotPacket()],
    ['meta purchase', purchasePacket()],
    ['business', { section: 'business', context: data.context, notes: [], result: data.business }],
  ]
}

describe('daily series claims are re-identified without a second full parse', () => {
  it('matches the previous full re-parse on the fixture metric maps', async () => {
    const packet = await scalePacket(3, 4)
    const data = packet.result.data as { metrics: ReportMetricMap; entities: Array<{ metrics: ReportMetricMap }> }
    for (const metrics of [data.metrics, ...data.entities.map((entity) => entity.metrics)]) {
      expect(JSON.stringify(dailyMetaMetrics(metrics))).toBe(JSON.stringify(previousDailyMetaMetrics(metrics)))
    }
  })

  it('fails exactly where the full re-parse fails: an id beyond 240 characters', () => {
    const metrics = snapshotPacket().result.data!.metrics as ReportMetricMap
    const long = Object.fromEntries(Object.entries(metrics).map(([key, metric]) => [key, {
      ...metric, current: createMetricClaim({ ...metric.current, claimId: 'x'.repeat(236) + key.slice(0, 1) }),
    }])) as ReportMetricMap
    const before = outcome(() => previousDailyMetaMetrics(long))
    expect(before.ok).toBe(false)
    expect(outcome(() => dailyMetaMetrics(long))).toEqual(before)
  })

  it('validates each daily claim once (no full parse for re-identification)', async () => {
    const packet = await scalePacket(2, 3)
    const metrics = (packet.result.data as { metrics: ReportMetricMap }).metrics
    const parse = vi.spyOn(MetricClaimSchema, 'parse')
    dailyMetaMetrics(metrics)
    expect(parse).not.toHaveBeenCalled()
  })
})

describe('packet validation validates each distinct claim once', () => {
  it('gives the same result for an expanded compact packet as for the plain packet', async () => {
    for (const [name, packet] of fixturePackets(await scalePacket(3, 4))) {
      const plain = ReportingPacketSchema.safeParse(wire(packet))
      const expanded = ReportingPacketSchema.safeParse(expandPacket(wire(compactReportingPacket(packet))))
      expect(expanded.success, name).toBe(plain.success)
      expect(JSON.stringify(expanded.data), name).toBe(JSON.stringify(plain.data))
    }
  })

  it('parses each claim of an expanded packet once, and none again when the parsed packet is validated again', async () => {
    const packet = await scalePacket(3, 4)
    const expanded = expandPacket(wire(compactReportingPacket(packet)))
    const claims = new Set(claimsOf(expanded))
    const parse = vi.spyOn(MetricClaimSchema, 'safeParse')
    const first = ReportingPacketSchema.safeParse(expanded)
    expect(first.success).toBe(true)
    expect(parse).toHaveBeenCalledTimes(claims.size)
    parse.mockClear()
    // A second parse of the same expanded packet, and validation of the parsed result (what
    // validateReportingPacket does after the route parsed it), parse no claim again.
    expect(ReportingPacketSchema.safeParse(expanded).success).toBe(true)
    expect(ReportingPacketSchema.safeParse(first.data).success).toBe(true)
    expect(parse).not.toHaveBeenCalled()
  })

  it('validates a packet built from constructed claims without parsing any claim again', async () => {
    const packet = await scalePacket(2, 3)
    const parse = vi.spyOn(MetricClaimSchema, 'safeParse')
    const parsed = ReportingPacketSchema.safeParse(packet)
    expect(parsed.success).toBe(true)
    expect(parse).not.toHaveBeenCalled()
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(ReportingPacketSchema.parse(wire(packet))))
  })

  it('still validates in full anything not frozen (control): a plain JSON packet parses every claim', async () => {
    const packet = wire(await scalePacket(2, 3))
    const parse = vi.spyOn(MetricClaimSchema, 'safeParse')
    expect(ReportingPacketSchema.safeParse(packet).success).toBe(true)
    expect(parse).toHaveBeenCalledTimes(claimsOf(packet).length)
  })

  it('reports the same issues for an invalid claim, plain or expanded', async () => {
    const packet = wire(await scalePacket(2, 3))
    const data = packet.result.data as { metrics: Record<string, { current: { value: unknown; availability: { state: string } } }> }
    const first = Object.values(data.metrics).find((metric) => metric.current.availability.state === 'available')!
    first.current.value = null // an available claim without a value
    const plain = ReportingPacketSchema.safeParse(wire(packet))
    const expanded = ReportingPacketSchema.safeParse(expandPacket(wire(compactReportingPacket(packet as ReportingPacket))))
    expect(plain.success).toBe(false)
    expect(expanded.success).toBe(false)
    expect(JSON.stringify(expanded.error?.issues)).toBe(JSON.stringify(plain.error?.issues))
  })
})
