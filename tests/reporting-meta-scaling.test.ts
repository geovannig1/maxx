import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readMetaReport } from '@/lib/platforms/meta/reporting/meta-reader'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { compactReportingPacket, expandPacket } from '@/lib/reporting/packet-format'
import { metaScaleContext, metaScaleResponse, type MetaScaleShape } from './fixtures/reporting-meta-scale'
import type { MetaRow } from '@/lib/reporting/meta-metrics'

// Operation-count guard for the Meta packet build. Wall time flakes on slow CI; counts do not.
// A 12-campaign/28-day build once took ~14 s because every claim built an Intl formatter and every
// campaign day built (then discarded) the full metric catalogue. Scans per entity were quadratic.
// Here the work counters must be EXACTLY affine in campaigns and in days: the second difference
// across three equally spaced sizes is zero, which any per-entity scan of all rows breaks.
const { get, history, claims } = vi.hoisted(() => ({ get: vi.fn(), history: vi.fn(), claims: { count: 0 } }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: get }))
vi.mock('@/lib/reporting/creative-assignment-reader', () => ({ readReportCreativeAssignmentEvidence: history }))
vi.mock('@/lib/cockpit/contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/cockpit/contracts')>()
  return { ...actual, createMetricClaim: (input: Parameters<typeof actual.createMetricClaim>[0]) => {
    claims.count += 1
    return actual.createMetricClaim(input)
  } }
})

interface Work { claims: number; rowReads: number; formatters: number; validationClaims: number; compactEntries: number }

/** Wraps native rows so every property the reader takes from them is counted. */
function readCounter() {
  let reads = 0
  return { reads: () => reads, wrap: (row: MetaRow) => new Proxy(row, { get(target, key, receiver) {
    reads += 1
    return Reflect.get(target, key, receiver)
  } }) }
}

/** Every native row is counted; `formatters` counts Intl.DateTimeFormat constructions. */
async function measure(campaigns: number, days: number): Promise<Work> {
  const shape: MetaScaleShape = { label: `${campaigns}x${days}h`, campaigns, days, hierarchy: true }
  const context = metaScaleContext(shape)
  const counter = readCounter()
  get.mockImplementation(async (path: string, params: Record<string, string>) => {
    const body = metaScaleResponse(shape, path, params)
    return body.data ? { ...body, data: body.data.map(counter.wrap) } : body
  })
  const Original = Intl.DateTimeFormat
  let formatters = 0
  Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    formatters += 1
    return new Original(...args)
  } as unknown as typeof Intl.DateTimeFormat
  try {
    claims.count = 0
    const result = await readMetaReport(context, { historyEntity: { level: 'campaign', id: '101' } })
    const built = claims.count
    expect(result.data?.entities.filter(entity => entity.level === 'campaign')).toHaveLength(campaigns)
    const packet = validateReportingPacket({ context, section: 'meta', result, notes: [] })
    const json = JSON.stringify(packet), compact = compactReportingPacket(packet)
    // The stored form must mean exactly the validated packet at every size.
    expect(JSON.stringify(expandPacket(JSON.parse(JSON.stringify(compact))))).toBe(json)
    return { claims: built, rowReads: counter.reads(), formatters, validationClaims: json.split('"claimId"').length - 1,
      compactEntries: compact.compact.values.length }
  } finally {
    Intl.DateTimeFormat = Original
  }
}

const secondDifference = (values: Work[], key: keyof Work) => values[2][key] - 2 * values[1][key] + values[0][key]
// Compact entries are distinct values, so two fixture numbers that happen to coincide share one entry and
// the count is affine only up to such coincidences (measured: at most 9 entries in ~9,600 per step). A
// table repeated per entity or per day would make the second difference comparable to the first.
const COMPACT_AFFINE_TOLERANCE = 0.005
const nearlyAffine = (values: number[]) => Math.abs(values[2] - 2 * values[1] + values[0]) <= COMPACT_AFFINE_TOLERANCE * (values[1] - values[0])

beforeEach(() => {
  get.mockReset()
  history.mockReset(); history.mockImplementation(async (scope: { account: { id: string }; asOf: string }) => ({ accountId: scope.account.id,
    asOf: scope.asOf, state: 'unavailable', observations: [], notes: ['Fictional history unavailable.'] }))
})

describe('Meta packet build scales linearly', () => {
  it('builds claims and reads native rows in exact proportion to campaigns and to days', async () => {
    await measure(2, 3) // warm module-level caches so every measured build starts from the same state
    const byCampaigns = [await measure(2, 6), await measure(4, 6), await measure(6, 6)]
    const byDays = [await measure(3, 4), await measure(3, 8), await measure(3, 12)]
    for (const series of [byCampaigns, byDays]) {
      // Control: the counters do grow with the population, so a zero difference is not a dead instrument.
      expect(series[2].claims).toBeGreaterThan(series[0].claims)
      expect(series[2].rowReads).toBeGreaterThan(series[0].rowReads)
      expect(secondDifference(series, 'claims')).toBe(0)
      expect(secondDifference(series, 'rowReads')).toBe(0)
      expect(secondDifference(series, 'validationClaims')).toBe(0)
      // Formatters are built once per timezone and reused, never once per claim or day.
      expect(series.map(work => work.formatters)).toEqual([0, 0, 0])
      expect(series[2].compactEntries).toBeGreaterThan(series[0].compactEntries)
      expect(nearlyAffine(series.map(work => work.compactEntries))).toBe(true)
    }
  })

  it('reports a nonzero second difference for a per-entity scan through the same row counter', () => {
    // Known-bad control for the instrument: the shape the reader used before (filter all rows per entity)
    // must be caught, and the one-pass grouping that replaced it must not be.
    const reads = (entities: number, grouped: boolean) => {
      const counter = readCounter()
      const rows = Array.from({ length: entities * 6 }, (_, index) => counter.wrap({ campaign_id: String(index % entities) }))
      const ids = Array.from({ length: entities }, (_, index) => String(index))
      if (grouped) {
        const groups = new Map<unknown, MetaRow[]>()
        for (const row of rows) groups.set(row.campaign_id, [...groups.get(row.campaign_id) ?? [], row])
        ids.forEach(id => groups.get(id))
      } else ids.forEach(id => rows.filter(row => row.campaign_id === id))
      return counter.reads()
    }
    const scan = [2, 4, 6].map(entities => reads(entities, false))
    const grouped = [2, 4, 6].map(entities => reads(entities, true))
    expect(scan[2] - 2 * scan[1] + scan[0]).toBeGreaterThan(0)
    expect(grouped[2] - 2 * grouped[1] + grouped[0]).toBe(0)
    // The compact tolerance still refuses quadratic growth and accepts a near-affine series.
    expect(nearlyAffine([2, 4, 6].map(entities => entities * entities * 1000))).toBe(false)
    expect(nearlyAffine([16124, 25734, 35335])).toBe(true)
  })
})
