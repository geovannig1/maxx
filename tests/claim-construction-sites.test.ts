import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as cockpitClaims from '@/lib/cockpit/contracts'
import * as metaReader from '@/lib/platforms/meta/reporting/meta-reader'
import { clearReportingCache, loadReportingSection } from '@/lib/reporting/loader'
import { validateReportingPacket } from '@/lib/reporting/validation'
import { createReportingSnapshot, makeReportingSnapshotScope } from '@/lib/reporting/snapshot-contract'
import { streamReportingReport } from '@/lib/reporting/stream-response'
import { COMPLETE_FIELD_COVERAGE, makeReportMetric } from '@/lib/reporting/claims'
import type { MetaReport, ReportingContext, ReportingPacket } from '@/lib/reporting/contracts'

/**
 * Every place that builds MetricClaims must be guarded, and the places are ENUMERATED, not recalled.
 *
 * `assertNoCrossPlaneLineage` was added to the cockpit assembler and described as making a blended
 * cost-per-booking unconstructible. That was true of one file. `metric-claim-binding.ts` builds a
 * derived CPA with real lineage and was never guarded — safe only by the accident that it hardcodes
 * `evidencePlane: 'meta_delivery'`, which is not a property anyone asserted and stops holding the
 * moment a business-truth metric is bound there.
 *
 * The mechanism behind that miss is the one this repo keeps repeating: a guard is verified against the
 * site its author was looking at, and the population is never enumerated. So this test asks git for
 * every module that constructs a claim and requires each to be guarded or exempted in writing. A new
 * construction site fails here on the PR that introduces it.
 */

const GUARD = 'assertNoCrossPlaneLineage'

// Reporting fragments can reference campaign inputs elsewhere in the packet. Their guard must
// run after assembly, not against an isolated fragment that cannot resolve those inputs. Each
// enumerated site has a runtime witness below; this is not a no-lineage exemption or path prefix.
const REPORTING_ASSEMBLED_SITES: [string, (report: MetaReport) => cockpitClaims.MetricClaim][] = [
  ['src/lib/reporting/claims.ts', report => report.metrics.spend.current],
  ['src/lib/reporting/meta-breakdowns.ts', report => report.entities.find(entity => entity.level === 'campaign')!.series![0].metrics.bookings.current],
  ['src/lib/reporting/meta-campaign-authority.ts', report => report.metrics.bookings.current],
  ['src/lib/reporting/meta-daily-authority.ts', report => report.series[0].metrics.bookings.current],
]
const assembledSites = new Set(REPORTING_ASSEMBLED_SITES.map(([file]) => file))

/** Modules under src/ that call createMetricClaim, from git rather than from memory. */
function claimConstructionSites(): string[] {
  const out = execFileSync('git', ['grep', '-l', 'createMetricClaim(', '--', 'src'], {
    cwd: process.cwd(), encoding: 'utf8',
  })
  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort()
}

/**
 * Sites that construct claims but cannot produce cross-plane lineage. Each needs a written reason —
 * an unexplained entry is how a real gap gets waved through, which is the same failure one level up.
 */
const EXEMPT = new Map<string, string>([
  ['src/lib/cockpit/contracts.ts', 'defines createMetricClaim and the guard itself; constructs nothing'],
  // Found BY this test, not by the review that preceded it — a third construction site nobody had
  // enumerated, which is the point. Verified exempt rather than assumed: it builds one synthetic
  // fixture claim for the adversarial preflight with `inputClaimIds: []`, so it has no lineage to
  // cross. If it ever gains inputs the exemption is wrong and must be deleted.
  ['src/lib/eval/maxx-governance.ts', 'builds one synthetic preflight fixture with inputClaimIds: [] — no lineage exists to cross'],
])

describe('every MetricClaim construction site is guarded', () => {
  const sites = claimConstructionSites()

  it('finds the construction sites at all (guards against enumerating nothing)', () => {
    expect(sites.length).toBeGreaterThan(1)
    expect(sites).toContain('src/lib/cockpit/builder.ts')
  })

  it.each(sites)('%s is guarded locally, at its verified assembly boundary, or exempt with a reason', (file) => {
    if (EXEMPT.has(file)) {
      expect(EXEMPT.get(file)!.length).toBeGreaterThan(20)
      return
    }
    // A CALL, not a mention. The first version asserted `toContain(GUARD)`, and deleting the call
    // left the import line behind — which satisfied it. That is the identical substring failure this
    // repo has now shipped three times (`toContain('npm run test:db')` matching
    // `npm run test:db:integration`, an `evidencePlane:` scan blind to `plane:`), reproduced inside
    // the test written to stop it. Import lines are stripped before matching, and the match requires
    // the open paren.
    const source = readFileSync(assembledSites.has(file) ? 'src/lib/reporting/validation.ts' : file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(import\b|\s*[A-Za-z_$][\w$]*,?\s*$)/.test(line) || !line.includes(GUARD))
      .join('\n')
    expect(source).toMatch(new RegExp(`${GUARD}\\(`))
  })

  it('keeps the exemption list honest: every entry still constructs claims', () => {
    for (const file of EXEMPT.keys()) expect(sites).toContain(file)
    for (const file of assembledSites) expect(sites).toContain(file)
  })

  it('no exempt site has quietly grown lineage', () => {
    // The exemptions rest on those files having no inputClaimIds to cross. That is a fact about their
    // current contents, not a permanent property, so it is checked rather than trusted.
    for (const file of EXEMPT.keys()) {
      if (file.endsWith('contracts.ts')) continue
      const source = readFileSync(file, 'utf8')
      const populated = [...source.matchAll(/inputClaimIds: (?!\[\])/g)]
      expect(populated, `${file} now populates inputClaimIds; its exemption is void`).toEqual([])
    }
  })
})

const api = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/platforms/meta/client', () => ({ metaGet: api.get }))
const context: ReportingContext = {
  account: { id: '00000000-0000-4000-8000-000000001311', metaAccountId: '123', name: 'Fictional guard account' },
  range: { from: '2026-09-02', to: '2026-09-04' }, comparison: { from: '2026-08-30', to: '2026-09-01' },
  timezone: 'America/New_York', currency: 'USD', asOf: '2026-09-05T16:00:00Z',
}
function metaResponse(path: string, params: Record<string, string>) {
  if (path === '/act_123') return { id: 'act_123', currency: 'USD', timezone_name: context.timezone }
  if (!path.endsWith('/insights') || params.breakdowns) return { data: [] }
  const range = JSON.parse(params.time_range)
  const count = params.level === 'account' ? 0 : range.since === context.range.from ? 2 : 1
  return { data: [{ date_start: range.since, date_stop: params.time_increment ? range.since : range.until,
    account_id: '123', campaign_id: '101', campaign_name: 'Campaign', adset_id: '201', adset_name: 'Set', ad_id: '301', ad_name: 'Ad',
    spend: '100', impressions: '1000',
    results: [{ indicator: 'AppointmentConfirmed', values: [
      { value: String(count), attribution_windows: ['default'] },
      { value: String(count), attribution_windows: ['7d_click'] }, { value: '0', attribution_windows: ['1d_view'] },
    ] }], conversion_values: [{ action_type: 'AppointmentConfirmed', value: String(count * 100) }],
  }] }
}

describe('reporting construction sites are guarded after all inputs are assembled', () => {
  beforeEach(() => { clearReportingCache(); api.get.mockReset(); api.get.mockImplementation(metaResponse) })
  afterEach(() => { vi.restoreAllMocks(); clearReportingCache() })

  it.each(REPORTING_ASSEMBLED_SITES)('%s reaches the assembled guard and cannot publish orphan lineage', async (_file, witness) => {
    const guard = vi.spyOn(cockpitClaims, 'assertNoCrossPlaneLineage')
    const packet = await loadReportingSection('meta', context)
    if (packet.section !== 'meta' || !packet.result.data) throw new Error('Expected production reader output')
    const report = packet.result.data
    expect(report.metrics.bookings.current.value).toBe(2)
    expect(report.series[0].metrics.bookings.current.value).toBe(2)
    expect(report.metrics.bookings.current.claimId).toMatch(/:campaign-canonical$/)
    expect(report.series[0].metrics.bookings.current.claimId).toMatch(/:campaign-daily-canonical$/)
    expect(report.entities.find(entity => entity.level === 'campaign')!.series![0].metrics.bookings.current.claimId).toMatch(/:daily$/)
    const claim = witness(report)
    const graph = guard.mock.calls.at(-1)?.[0]
    expect(graph?.[claim.claimId]).toEqual(claim)
    const derived = Object.values(graph ?? {}).filter(item => item.inputClaimIds.length > 0)
    expect(derived.length).toBeGreaterThan(0)
    for (const item of derived) for (const id of item.inputClaimIds) expect(graph?.[id]).toBeDefined()
    const scope = makeReportingSnapshotScope('meta', context)
    expect(createReportingSnapshot(scope, packet, context.asOf).packet).toEqual(packet)

    // Corrupt actual constructor output, retaining valid shape/population/value. A regex match or
    // schema-only validator cannot reject this; the assembled lineage check must still execute.
    const forged = structuredClone(packet)
    witness(forged.result.data!).inputClaimIds = ['missing-construction-guard-input']
    expect(() => validateReportingPacket(forged)).toThrow(/input lineage does not resolve/)
    expect(() => createReportingSnapshot(scope, forged, context.asOf)).toThrow(/could not be validated/)
    clearReportingCache()
    vi.spyOn(metaReader, 'readMetaReport').mockImplementation(async (_context, options) => {
      options?.onProgress?.(forged.result)
      return forged.result
    })
    const progress: ReportingPacket[] = []
    const rejected = await loadReportingSection('meta', context, true, [], packet => { progress.push(packet) })
    expect(rejected.result).toMatchObject({ state: 'unavailable', data: null })
    expect(progress).toEqual([])
    const response = streamReportingReport('meta', context, true, [], new AbortController().signal, [])
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ kind: 'complete', packet: { result: { state: 'unavailable', data: null } } })
  })

  it('executes the cross-plane guard on a complete mixed-source packet, accepting separate lanes and rejecting a forged derivation', () => {
    const guard = vi.spyOn(cockpitClaims, 'assertNoCrossPlaneLineage')
    const metric = (source: 'first_party_attribution' | 'capi', key: string, inputMetrics?: ReturnType<typeof makeReportMetric>[]) => makeReportMetric({
      context, source, key, label: key, definition: key, current: 2, unit: 'count',
      entity: { level: 'business', id: context.account.id }, basis: 'booking_created_date_et', coverage: COMPLETE_FIELD_COVERAGE,
      ...(inputMetrics ? { inputMetrics, measurementKind: 'derived' as const } : {}),
    })
    const linked = metric('first_party_attribution', 'linked_bookings'), transported = metric('capi', 'accepted_confirmations')
    const packet = (input: typeof linked): ReportingPacket => ({ section: 'measurement', context, notes: [], result: {
      state: 'available', asOf: context.asOf, notes: [], data: {
        paidAssociation: { linked_bookings: linked, checked_bookings: metric('first_party_attribution', 'checked_bookings', [input]) },
        capi: { accepted_confirmations: transported }, paidAssociationNotes: [], capiNotes: [], sourceDescription: 'Fictional separate evidence lanes',
      },
    } })
    const valid = packet(linked)
    expect(validateReportingPacket(valid)).toEqual(valid)
    expect(guard.mock.calls.at(-1)?.[0][transported.current.claimId]).toEqual(transported.current)
    const invalid = packet(transported), calls = guard.mock.calls.length
    expect(() => validateReportingPacket(invalid)).toThrow(/across evidence planes/)
    expect(guard.mock.calls).toHaveLength(calls + 1)
    expect(() => createReportingSnapshot(makeReportingSnapshotScope('measurement', context), invalid, context.asOf)).toThrow(/could not be validated/)
  })
})
