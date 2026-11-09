import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readComparisonWindows } from '@/lib/cockpit/loader'
import { comparisonWindowKey, type CockpitRange, type MetaDeliveryEvidence } from '@/lib/cockpit/evidence'

/**
 * The trend reads, and every way they are allowed to fail.
 *
 * Nothing here can produce a WRONG trend — only a missing one that names its cause. That is the
 * property under test: an unreadable window, or a window nothing can be compared over, must leave a
 * blocker and an absent entry, never a silently substituted window.
 */

const ACCOUNT = { id: '00000000-0000-4000-8000-000000000001', accountId: 'act_123' }

const range = (start: string, end: string): CockpitRange => ({
  start, end, basis: 'closed_account_days', timezone: 'America/New_York',
})

const REQUESTED_DELIVERY = { spend: 999, marker: 'the-already-read-copy' } as unknown as MetaDeliveryEvidence

/** Records the windows queried; optionally throws for chosen ones. */
function fakeDb(options: { throwFor?: string[] } = {}) {
  const queried: string[] = []
  const db = {
    from() {
      let from: string | null = null
      let to: string | null = null
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: (_c: string, v: string) => { from = v; return builder },
        lte: (_c: string, v: string) => {
          to = v
          const key = `${from}:${to}`
          if (!queried.includes(key)) queried.push(key)
          if (options.throwFor?.includes(key)) throw new Error(`read failed for ${key}`)
          return builder
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      }
      return builder
    },
  }
  return { db, queried }
}

describe('the trend reads fetch the prior period', () => {
  it('reads the equal-length window before the request', async () => {
    const { db, queried } = fakeDb()
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-02'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(queried).toContain('2026-07-30:2026-07-31')
    expect(evidence.blockerCodes).toEqual([])
  })

  it('reuses the already-read requested window instead of querying it again', async () => {
    // Re-reading would be a second query for the same rows, and would let the two copies disagree if
    // a sync landed between them.
    const { db, queried } = fakeDb()
    const requested = range('2026-08-01', '2026-08-02')
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, requested, '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(queried).not.toContain('2026-08-01:2026-08-02')
    expect(evidence.deliveryByWindow[comparisonWindowKey(requested)]).toBe(REQUESTED_DELIVERY)
  })

  it('reads TWO different prior windows when the request is partly settling', async () => {
    // Spend is stamped settled and compares over all 20 days; classifier-governed claims compare only
    // through the 2026-08-13 boundary. Different windows, which is the whole reason this is per claim.
    const { db, queried } = fakeDb()
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(queried).toContain('2026-07-12:2026-07-31')   // prior 20 days, for spend
    expect(queried).toContain('2026-08-01:2026-08-13')   // the settled part of the request
    expect(queried).toContain('2026-07-19:2026-07-31')   // prior 13 days, for conversions
    expect(evidence.blockerCodes).toEqual([])
  })
})

describe('a window that cannot be read leaves a blocker, never a substitute', () => {
  it('names the window whose read threw', async () => {
    const { db } = fakeDb({ throwFor: ['2026-07-30:2026-07-31'] })
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-02'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(evidence.blockerCodes).toContain('cockpit_trend_window_read_failed:2026-07-30:2026-07-31')
    expect(evidence.deliveryByWindow['2026-07-30:2026-07-31']).toBeUndefined()
  })

  it('keeps the windows that DID read, so one failure does not blank every trend', async () => {
    const { db } = fakeDb({ throwFor: ['2026-07-19:2026-07-31'] })
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(evidence.deliveryByWindow['2026-07-12:2026-07-31']).toBeDefined()
    expect(evidence.deliveryByWindow['2026-07-19:2026-07-31']).toBeUndefined()
    expect(evidence.blockerCodes).toEqual(['cockpit_trend_window_read_failed:2026-07-19:2026-07-31'])
  })

  it('does not throw — the cockpit must still load without its trends', async () => {
    const { db } = fakeDb({ throwFor: ['2026-07-30:2026-07-31'] })
    await expect(readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-02'), '2026-08-21', REQUESTED_DELIVERY,
    )).resolves.toBeDefined()
  })
})

describe('a window nothing can be compared over says so', () => {
  it('blocks the classifier maturity when the whole request is inside the settle boundary', async () => {
    // 2026-08-18..2026-08-21 against a 2026-08-21 clock: the boundary is 2026-08-13, so nothing in
    // the request has settled. Spend is still comparable; conversions are not.
    const { db, queried } = fakeDb()
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-18', '2026-08-21'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(evidence.blockerCodes).toContain('cockpit_trend_window_uncomparable:settling')
    // The settled maturity still yields its pair, so spend keeps a trend.
    expect(queried).toContain('2026-08-14:2026-08-17')
  })

  it('the blocker names WHICH maturity could not be compared', async () => {
    const { db } = fakeDb()
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-18', '2026-08-21'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(evidence.blockerCodes.every((code) => code.includes(':'))).toBe(true)
    expect(evidence.blockerCodes).not.toContain('cockpit_trend_window_uncomparable:settled')
  })

  it('blocker codes are SORTED, so the surface is stable across runs', async () => {
    // Says "sorted", not "sorted and unique". Replacing the backing `Set` with a plain list survives
    // the whole suite, and that is correct rather than a gap: read-failure keys come from a Map and
    // are unique by construction, and the uncomparable branch cannot fire twice for one maturity. The
    // Set is defence-in-depth, not a tested behaviour, and the test name should not claim it is.
    // THREE blockers, and the expected order written out. Two is not enough: the insertion order of a
    // two-element case here is exactly its reverse-sorted order, so `sort()` and `reverse()` produce
    // the same array and the mutation was invisible. Comparing the array against its OWN sorted copy
    // was the deeper mistake — that assertion holds for any input by construction.
    const { db } = fakeDb({ throwFor: [
      '2026-07-12:2026-07-31', '2026-08-01:2026-08-13', '2026-07-19:2026-07-31',
    ] })
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-08-21', REQUESTED_DELIVERY,
    )
    // Insertion order is 07-12, 08-01, 07-19 — neither sorted nor reverse-sorted.
    expect(evidence.blockerCodes).toEqual([
      'cockpit_trend_window_read_failed:2026-07-12:2026-07-31',
      'cockpit_trend_window_read_failed:2026-07-19:2026-07-31',
      'cockpit_trend_window_read_failed:2026-08-01:2026-08-13',
    ])
  })
})

describe('the trend reads do not sit on the page critical path', () => {
  /**
   * `readMetaDelivery` is three Supabase queries PLUS an uncached live Meta Graph call
   * (`readNativePeriodDelivery`), and a straddling window issues three of them. Awaiting the
   * comparison reads AFTER `readPartialToday` added a full Meta round trip to a server-rendered page
   * for no structural reason — neither depends on the other.
   *
   * Asserted against the SHIPPED source. A timing test would be flaky, and what actually matters is
   * that the two calls share one `Promise.all` rather than running in sequence.
   */
  const source = readFileSync(join(process.cwd(), 'src/lib/cockpit/loader.ts'), 'utf8')

  it('issues the partial-today and comparison reads in ONE batch', () => {
    const batch = /const \[partialToday, comparison\] = await Promise\.all\(\[([\s\S]*?)\]\)/.exec(source)
    expect(batch, 'the two reads are no longer batched together').not.toBeNull()
    expect(batch![1]).toContain('readPartialToday(')
    expect(batch![1]).toContain('readComparisonWindows(')
  })

  it('does not await either one separately', () => {
    // A second `await readComparisonWindows` anywhere would put it back on the critical path.
    expect(source).not.toMatch(/await readComparisonWindows\(/)
    expect(source).not.toMatch(/await readPartialToday\(/)
  })

  it('skips the comparison reads entirely when trends are off', () => {
    // Off must cost nothing, not "read them and discard".
    expect(source).toContain('cockpitTrendsEnabled()')
    const batch = /const \[partialToday, comparison\] = await Promise\.all\(\[([\s\S]*?)\]\)/.exec(source)!
    expect(batch[1]).toContain('cockpitTrendsEnabled()')
    expect(batch[1]).toContain('Promise.resolve(undefined)')
  })

  /**
   * BEHAVIOUR, not source text. The three tests above assert a character sequence — a
   * behaviour-identical refactor (hoisting the two promises into locals, or
   * `Promise.resolve<undefined>(undefined)`) fails them while a genuine regression in a differently
   * shaped rewrite would not. This one runs the thing.
   *
   * `readComparisonWindows` was awaited BARE inside `Promise.all`, unlike its sibling on the line
   * above which carries `.catch(() => null)`. A throw in `classifyWindowSettle`, `comparableWindows`
   * or key construction therefore 500'd the entire dashboard — inside a function whose own docstring
   * says "EVERY FAILURE DEGRADES TO A BLOCKER". A trend must never cost the owner the page it sits on.
   */
  it('degrades to a blocker when the comparison read THROWS, rather than losing the page', async () => {
    vi.resetModules()
    vi.doMock('@/lib/cockpit/comparison-window', async () => {
      const actual = await vi.importActual<typeof import('@/lib/cockpit/comparison-window')>(
        '@/lib/cockpit/comparison-window',
      )
      return { ...actual, comparableWindows: () => { throw new Error('boom') } }
    })
    const { readComparisonWindows: reader } = await import('@/lib/cockpit/loader')
    // The throw escapes the function itself — that is expected and is why the CALL SITE must catch.
    const { db } = fakeDb()
    await expect(reader(db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-09-05', REQUESTED_DELIVERY))
      .rejects.toThrow('boom')
    // And the call site does, with a named blocker rather than a rejected page render.
    const callSite = /readComparisonWindows\(db, account, range, today, delivery\)([\s\S]{0,200})/.exec(source)
    expect(callSite, 'the comparison read is no longer called where expected').not.toBeNull()
    expect(callSite![1]).toContain('.catch(')
    expect(callSite![1]).toContain('cockpit_trend_read_threw')
    vi.doUnmock('@/lib/cockpit/comparison-window')
    vi.resetModules()
  })
})

describe('readComparisonWindows refuses to read when trends are off', () => {
  it('issues no query and returns nothing', async () => {
    // Defence in depth: the loader already skips the call, but this function is exported and called
    // directly. Deleting its guard survived the suite because nothing exercised it here.
    vi.stubEnv('MAXX_COCKPIT_TRENDS', 'off')
    const { db, queried } = fakeDb()
    const evidence = await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(queried).toEqual([])
    expect(evidence).toEqual({ deliveryByWindow: {}, blockerCodes: [] })
    vi.unstubAllEnvs()
  })

  it('reads normally when trends are on', async () => {
    const { db, queried } = fakeDb()
    await readComparisonWindows(
      db as never, ACCOUNT, range('2026-08-01', '2026-08-20'), '2026-08-21', REQUESTED_DELIVERY,
    )
    expect(queried.length).toBeGreaterThan(0)
  })
})
