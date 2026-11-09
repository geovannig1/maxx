// Offline, in-process benchmark of the Meta reporting packet build.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/bench/reporting-packet.ts [options]
//     --shapes 12x28,25x56,50x90,50x90h   campaigns x days; an `h` suffix adds 3 ad sets x 3 ads per
//                                         campaign, matching inventory and a selected parent history
//     --runs N                            timed runs per shape after one warm-up (default 3)
//     --stages                            attribute reader CPU samples to stages with the V8 profiler
//     --json PATH                         also write the measured rows as JSON
//
// Every Graph request is answered by a stubbed `fetch`; any other host throws, so the benchmark is
// fully offline and never reads credentials. The fixtures mirror the stress tests in
// tests/reporting-meta-daily-authority.test.ts and tests/reporting-meta-hierarchy-history.test.ts;
// the shapes live in tests/fixtures/reporting-meta-scale.ts, shared with the operation-count guard.
// The sha256 of the serialised packet is printed so a refactor can prove byte-identical output.
// Each run also encodes the stored form (packetVersion 2), prints its size (plain and gzip) and
// fails unless its expansion has the v1 packet's sha256.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { Session } from 'node:inspector/promises'
import type { MetaReport, ReportSection, ReportingContext } from '@/lib/reporting/contracts'
import { metaScaleContext, metaScaleResponse, parseMetaScaleShape, type MetaScaleShape } from '../../tests/fixtures/reporting-meta-scale'

interface Stub { calls: number; ms: number }
type Packet = { context: ReportingContext; section: 'meta'; result: ReportSection<MetaReport>; notes: string[] }

function installGraphStub(shape: MetaScaleShape, stub: Stub): void {
  globalThis.fetch = async function stubGraph(input: string | URL | Request): Promise<Response> {
    const started = performance.now()
    const url = new URL(input instanceof Request ? input.url : input.toString())
    // The stub never reaches a network; anything that is not a versioned Graph path fails loudly.
    const graphPath = /^\/v\d+\.\d+(\/.*)$/.exec(url.pathname)?.[1]
    if (!graphPath) throw new Error(`Benchmark is offline; refused ${url.origin}${url.pathname}`)
    const body = metaScaleResponse(shape, graphPath, Object.fromEntries(url.searchParams))
    const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    stub.calls += 1
    stub.ms += performance.now() - started
    return response
  }
}

// Innermost matching frame wins, so claim construction called from a projection counts as claims.
const STAGES: Array<[string, string[]]> = [
  ['fetch+transport', ['stubGraph', 'metaGet', 'fetchMetaGraph', 'readMetaPages', 'json']],
  ['normalisation', ['validateMetaReportRows', 'readInsights', 'readMetaInventory', 'uniqueInventory', 'parentHistoryReads']],
  ['claim construction', ['createMetricClaim', 'makeReportMetric', 'buildMetaMetrics', 'dailyMetaMetrics', 'selectMetaMetrics', 'buildMetaSeries', 'buildMetaBreakdowns']],
  ['assembly', ['assembleMetaReport', 'entities', 'projectMetaDailyAuthority', 'projectCampaignAuthority', 'reconcileReportOutcomes', 'omitUnavailableEntityMetrics']],
]

interface ProfileNode { id: number; callFrame: { functionName: string }; children?: number[] }
function attribute(profile: { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] }): Record<string, number> {
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const stageOf = new Map<number, string>()
  const resolve = (id: number): string => {
    const known = stageOf.get(id)
    if (known) return known
    const name = byId.get(id)!.callFrame.functionName
    const own = STAGES.find(([, names]) => names.includes(name))?.[0]
    const up = parent.get(id)
    const stage = own ?? (up === undefined ? 'other' : resolve(up))
    stageOf.set(id, stage)
    return stage
  }
  const totals: Record<string, number> = {}
  ;(profile.samples ?? []).forEach((id, index) => {
    const stage = resolve(id)
    totals[stage] = (totals[stage] ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000
  })
  return totals
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const shapes = (option('--shapes') ?? '12x28,25x56,50x90,50x90h').split(',').map(parseMetaScaleShape)
  const runs = Number(option('--runs') ?? 3)
  const stages = args.includes('--stages')
  // A placeholder so the real client reaches the stubbed transport; no credential is read or sent.
  process.env.META_ACCESS_TOKEN = 'offline'
  delete process.env.META_APPSECRET_PROOF_ENABLED
  // The Meta section is read through the ad-platform interface, as the reporting loader reads it.
  const { getAdPlatform, requireCapability } = await import('@/lib/platforms/registry')
  const readMetaReport = requireCapability(getAdPlatform('meta'), 'reporting').readReport
  const { validateReportingPacket } = await import('@/lib/reporting/validation')
  const { validateScopedReportingPacket } = await import('@/lib/reporting/packet-scope')
  const { makeReportingSnapshotScope } = await import('@/lib/reporting/snapshot-scope')
  const { compactReportingPacket, expandPacket } = await import('@/lib/reporting/packet-format')
  const session = stages ? new Session() : null
  session?.connect()
  const rows: Array<Record<string, string | number>> = []
  for (const shape of shapes) {
    const scope = metaScaleContext(shape)
    const historyEntity = shape.hierarchy ? { level: 'campaign' as const, id: '101' } : undefined
    const samples: Array<Record<string, number>> = []
    let digest = ''
    let bytes = 0
    let compactBytes = 0
    let compactGzip = 0
    for (let run = 0; run <= runs; run += 1) {
      const stub: Stub = { calls: 0, ms: 0 }
      installGraphStub(shape, stub)
      if (session && run === runs) { await session.post('Profiler.enable'); await session.post('Profiler.start') }
      let started = performance.now()
      const result = await readMetaReport(scope, historyEntity ? { historyEntity } : {})
      const read = performance.now() - started
      const profiled = session && run === runs ? attribute((await session.post('Profiler.stop')).profile as never) : {}
      const packet: Packet = { context: scope, section: 'meta', result, notes: [] }
      started = performance.now()
      validateReportingPacket(packet)
      const validate = performance.now() - started
      started = performance.now()
      validateScopedReportingPacket(packet, makeReportingSnapshotScope('meta', scope, { historyEntity }), scope.asOf)
      const scoped = performance.now() - started
      started = performance.now()
      const json = JSON.stringify(packet)
      const serialise = performance.now() - started
      const hash = createHash('sha256').update(json).digest('hex')
      if (digest && hash !== digest) throw new Error(`${shape.label}: packet bytes differ between runs`)
      digest = hash
      bytes = Buffer.byteLength(json)
      started = performance.now()
      const stored = JSON.stringify(compactReportingPacket(packet))
      const compact = performance.now() - started
      started = performance.now()
      const expanded = JSON.stringify(expandPacket(JSON.parse(stored)))
      const expand = performance.now() - started
      if (createHash('sha256').update(expanded).digest('hex') !== hash) throw new Error(`${shape.label}: v2 expansion differs from the v1 packet`)
      compactBytes = Buffer.byteLength(stored)
      if (run === runs) compactGzip = gzipSync(stored).byteLength
      if (run === 0) continue // warm-up: module compilation and JIT
      samples.push({ read, fetchStub: stub.ms, calls: stub.calls, validate, scoped, serialise, total: read + validate + scoped + serialise,
        compact, expand,
        ...Object.fromEntries(Object.entries(profiled).map(([key, value]) => [`cpu:${key}`, value])) })
    }
    const median = (key: string) => {
      // Profiled stages exist only on the last run; the median is over runs that measured the key.
      const values = samples.flatMap(sample => key in sample ? [sample[key]] : []).sort((a, b) => a - b)
      return values[Math.floor(values.length / 2)]
    }
    const keys = [...new Set(samples.flatMap(sample => Object.keys(sample)))]
    const row = { shape: shape.label, campaignDays: shape.campaigns * shape.days, bytes, sha256: digest, compactBytes, compactGzip,
      ...Object.fromEntries(keys.map(key => [key, key === 'calls' ? median(key) : Math.round(median(key) * 10) / 10])) }
    rows.push(row)
    console.log(JSON.stringify(row))
  }
  session?.disconnect()
  const path = option('--json')
  if (path) writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`)
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
