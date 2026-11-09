import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReportInputData } from '@/lib/report/prompt-builder'

// WRITER/READER CONTRACT for GA4 evidence.
//
// THE DEFECT: evidence-gate read `report_json.ga4.paidBookings`. No writer ever produced that field —
// generator.ts stores `todayPaidBookings` / `paidBookings30`. So the read returned null on EVERY
// production run and silently disabled the plane-conflict cap. Nothing failed, because nothing
// checked that the reader's field name existed in the writer's shape.
//
// A naive rename would have been worse: `paidBookings30` is a ROLLING 30-day total repeated on every
// daily row, so summing it across a 30-day window multiplies the true figure by ~30.

/** The exact GA4 shape the report writer emits, taken from the type it must satisfy. */
type Ga4Written = NonNullable<ReportInputData['ga4']>

const EVIDENCE_GATE = resolve(process.cwd(), 'src/lib/recommendations/evidence-gate.ts')
/** Source with comment lines stripped — a comment DESCRIBING the removed defect is documentation,
 *  not a dependency on it. Only executable lines may be asserted against. */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
}

describe('GA4 writer/reader field contract', () => {
  it('the writer shape has NO field named paidBookings — the old reader could never match', () => {
    // Compile-time proof: naming a non-existent key is a type error, so this documents the absence.
    const written: Ga4Written = {
      todayPaidConfirmationEvents: 1, todayPaidEventValue: 100,
      todayOrganicConfirmationEvents: 2, todayOrganicEventValue: 200,
      paidConfirmationEvents30: 30, paidEventValue30: 3000,
      organicConfirmationEvents30: 40, organicEventValue30: 4000, zeroValueEvents30: 0
    }
    expect(Object.keys(written)).not.toContain('paidBookings')
    expect(Object.keys(written)).toContain('todayPaidConfirmationEvents')
    expect(Object.keys(written)).toContain('paidConfirmationEvents30')
    // No field on the GA writer shape may be named `bookings` or `revenue` at all.
    expect(Object.keys(written).filter((k) => /bookings|revenue/i.test(k))).toEqual([])
  })

  it('the reader NO LONGER depends on report_json at all', () => {
    const src = codeOnly(EVIDENCE_GATE)
    // The whole class of writer/reader drift is removed by not round-tripping through a stored blob.
    expect(src).not.toMatch(/report_json/)
    expect(src).not.toMatch(/paidBookings\b/)
    // ...and it reads GA4 directly.
    expect(src).toMatch(/getGa4ConfirmationTelemetryBySource/)
  })

  it('the reader NEVER sums a rolling 30-day field across rows', () => {
    const src = codeOnly(EVIDENCE_GATE)
    expect(src).not.toMatch(/paidBookings30/)
    expect(src).not.toMatch(/total \+= .*30/)
  })

  it('the reader uses the META-SCOPED paid bucket, not blended paid', () => {
    const src = codeOnly(EVIDENCE_GATE)
    expect(src).toMatch(/metaPaid\.confirmationEvents/)
    // Blending all paid channels would attribute Google/other bookings to Meta.
    expect(src).not.toMatch(/\br\.paid\.bookings\b/)
  })
})

describe('GA4 evidence read — runtime behaviour', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/ga4/client') })

  const gatherWith = async (ga4: unknown) => {
    vi.doMock('@/lib/ga4/client', () => ({ getGa4ConfirmationTelemetryBySource: vi.fn(async () => ga4) }))
    const { gatherAccountEvidence } = await import('@/lib/recommendations/evidence-gate')
    // Minimal chainable stub: every table read returns an empty, error-free result.
    const q: Record<string, unknown> = {}
    const chain = () => q
    Object.assign(q, {
      select: chain, eq: chain, gte: chain, lte: chain, in: chain, not: chain, limit: chain,
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null }),
    })
    const db = { from: () => q } as never
    return gatherAccountEvidence(db, 'acct-1', 'act_1', { today: '2026-07-26', windowDays: 30 })
  }

  it('a REAL Meta-paid value reaches the evidence readings', async () => {
    const e = await gatherWith({
      available: true, paid: { confirmationEvents: 99, eventValue: 9900 }, organic: { confirmationEvents: 0, eventValue: 0 },
      metaPaid: { confirmationEvents: 7, eventValue: 700 }, byChannel: [],
    })
    const ga4Reading = e.optimizationEvents.readings.find((r) => r.tier === 'ga4_web_observed')
    expect(ga4Reading).toBeDefined()
    // The META-scoped 7, not the blended 99.
    expect(ga4Reading!.count).toBe(7)
    expect(ga4Reading!.provenance).toMatch(/Meta-scoped/)
  })

  it('GA4 unavailable yields UNKNOWN (no reading), never a confident zero', async () => {
    const e = await gatherWith({ available: false, reason: 'not configured', paid: { confirmationEvents: 0, eventValue: 0 }, organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 0, eventValue: 0 }, byChannel: [] })
    expect(e.optimizationEvents.readings.find((r) => r.tier === 'ga4_web_observed')).toBeUndefined()
    expect(e.gatherWarnings.join(' ')).toMatch(/UNKNOWN, not zero/)
  })

  it('a THROWN GA4 error is caught and reported as unknown', async () => {
    vi.doMock('@/lib/ga4/client', () => ({
      getGa4ConfirmationTelemetryBySource: vi.fn(async () => { throw new Error('quota exceeded') }),
    }))
    const { gatherAccountEvidence } = await import('@/lib/recommendations/evidence-gate')
    const q: Record<string, unknown> = {}
    const chain = () => q
    Object.assign(q, {
      select: chain, eq: chain, gte: chain, lte: chain, in: chain, not: chain, limit: chain,
      then: (res: (v: { data: unknown[]; error: null }) => unknown) => res({ data: [], error: null }),
    })
    const e = await gatherAccountEvidence({ from: () => q } as never, 'acct-1', 'act_1', { today: '2026-07-26', windowDays: 30 })
    expect(e.gatherWarnings.join(' ')).toMatch(/GA4 read threw/)
    expect(e.optimizationEvents.readings.find((r) => r.tier === 'ga4_web_observed')).toBeUndefined()
  })
})

describe('first-party evidence — account scoping and error handling', () => {
  it('the ledger read is ACCOUNT-SCOPED', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/recommendations/evidence-gate.ts'), 'utf8')
    const block = src.slice(src.indexOf('fetchFirstPartyEvidence'), src.indexOf('async function fetchGa4MetaPaidBookings'))
    expect(block).toMatch(/from\('v_business_outcomes'\)[\s\S]{0,200}\.eq\('ad_account_id', adAccountDbId\)/)
    expect(block).toMatch(/\.eq\('source_enabled', true\)/)
  })

  it('the delivery read checks its error and selects LIVE acceptances only', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/recommendations/evidence-gate.ts'), 'utf8')
    expect(src).toMatch(/if \(delErr\) throw new Error\(delErr\.message\)/)
    // Live acceptance has its own column (`live_accepted_at`), which is a stronger predicate than
    // filtering on the accepted mode.
    expect(src).toMatch(/\.not\('live_accepted_at', 'is', null\)/)
    expect(src).toMatch(/UNKNOWN, not zero/)
  })
})


// PostgREST reports permission/schema failures in `error` rather than throwing, so destructuring
// only `data` produced EMPTY campaign maps with no warning. Decisions still failed closed, but the
// operator was never told WHY campaign/CBO context had disappeared.
describe('campaign read errors are SURFACED, not swallowed', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('@/lib/ga4/client') })

  it('a campaign permission error produces an explicit gather warning', async () => {
    vi.doMock('@/lib/ga4/client', () => ({
      getGa4ConfirmationTelemetryBySource: vi.fn(async () => ({ available: false, reason: 'n/a', paid: { confirmationEvents: 0, eventValue: 0 }, organic: { confirmationEvents: 0, eventValue: 0 }, metaPaid: { confirmationEvents: 0, eventValue: 0 }, byChannel: [] })),
    }))
    const { gatherAccountEvidence } = await import('@/lib/recommendations/evidence-gate')

    // Only the campaigns table errors; every other read succeeds.
    const makeChain = (result: { data: unknown[]; error: { message: string } | null }) => {
      const q: Record<string, unknown> = {}
      const chain = () => q
      Object.assign(q, {
        select: chain, eq: chain, gte: chain, lte: chain, in: chain, not: chain, limit: chain,
        then: (res: (v: typeof result) => unknown) => res(result),
      })
      return q
    }
    const db = {
      from: (t: string) => t === 'campaigns'
        ? makeChain({ data: [], error: { message: 'permission denied for table campaigns' } })
        : makeChain({ data: [], error: null }),
    } as never

    const e = await gatherAccountEvidence(db, 'acct-1', 'act_1', { today: '2026-07-26', windowDays: 30 })
    const warnings = e.gatherWarnings.join(' ')
    expect(warnings).toMatch(/campaign budget read failed/)
    expect(warnings).toMatch(/permission denied for table campaigns/)
    // ...and it says what the operator loses, not just that something failed.
    expect(warnings).toMatch(/campaign\/CBO context is UNAVAILABLE/)
    expect(warnings).toMatch(/resolve to unknown and freeze/)
    // The maps really are empty, so decisions fail closed.
    expect(e.budgetStructureByCampaign.size).toBe(0)
  })
})
