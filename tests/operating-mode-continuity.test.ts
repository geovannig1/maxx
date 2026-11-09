import { freshSchemaDb } from './db/schema-db'
import { SETTING_CATEGORIES } from '@/lib/recommendations/setup-ledger'
import { describe, it, expect } from 'vitest'
import { proveStructuralContinuity, MATERIAL_SETTING_CATEGORIES } from '@/mcp/tools/operating-mode'

/**
 * Structural continuity.
 *
 * One fix killed the original defect: continuity was "proven" by the ABSENCE of rows in a manual-entry
 * ledger, filtered on `setting_category = 'targeting'` — a value the `ad_setup_decisions` vocabulary never defines, on a
 * free-text column with no check constraint, so the typo matched nothing silently and forever.
 *
 * A later fix killed the replacement's defect: the proof was GLOBAL ("is ANY row in this table fresh?") when
 * the claim is COHORT-scoped ("did the setup responsible for the evaluated spend change?"). One fresh
 * campaign beside a 72-hour-stale ad set proved continuity; an account with campaigns but no synced
 * ad sets proved it; and another account's executed change denied it, because that query carried no
 * ad_account_id filter although the column exists.
 */

const HOUR = 3_600_000
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
// Every timestamp is relative to now so the fixture never ages across the module's boundaries:
// evaluated periods 70-44 days ago, cohort rows dated inside the first period, metadata last changed
// 90 days ago (before the periods), synced 2 hours ago (fresh), and "after the window" events 30 days ago.
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * HOUR).toISOString().slice(0, 10)
const PERIODS = [{ start: daysAgo(70), end: daysAgo(57) }, { start: daysAgo(56), end: daysAgo(44) }]
const ROW_DATE = daysAgo(65)
const AFTER_SINCE = iso(30 * 24 * HOUR)

type Row = Record<string, unknown>

/** PostgREST-shaped stub that honours .eq / .in / .gte so account scoping is actually testable. */
function fakeDb(tables: Record<string, Row[]>, opts: { errorOn?: string } = {}) {
  const seen: Array<{ table: string; filters: Record<string, unknown> }> = []
  const make = (name: string) => {
    let rows = [...(tables[name] ?? [])]
    const filters: Record<string, unknown> = {}
    seen.push({ table: name, filters })
    const chain: Record<string, unknown> = {}
    const self = () => chain
    chain.select = self
    chain.order = self
    // The daily_insights read is PAGED now, so the stub must honour .range() or the loop never ends.
    chain.range = (from: number, to: number) => {
      rows = rows.slice(from, to + 1)
      return settleThenable()
    }
    chain.eq = (col: string, v: unknown) => {
      filters[col] = v
      rows = rows.filter((r) => !(col in r) || r[col] === v)
      return chain
    }
    chain.in = (col: string, vals: unknown[]) => {
      filters[col] = vals
      rows = rows.filter((r) => !(col in r) || vals.map(String).includes(String(r[col])))
      return chain
    }
    chain.not = (col: string) => { rows = rows.filter((r) => r[col] != null); return chain }
    chain.gte = (col: string, v: string) => {
      rows = rows.filter((r) => r[col] != null && String(r[col]) >= String(v)); return chain
    }
    chain.lte = (col: string, v: string) => {
      rows = rows.filter((r) => r[col] == null || String(r[col]) <= String(v)); return chain
    }
    const settle = () => opts.errorOn === name
      ? { data: null, error: { message: 'boom' } }
      : { data: rows, error: null }
    const settleThenable = () => ({
      then: (res: (v: ReturnType<typeof settle>) => unknown) => res(settle()),
    })
    chain.limit = () => settle()
    chain.then = (res: (v: ReturnType<typeof settle>) => unknown) => res(settle())
    return chain
  }
  const db = { from: (n: string) => make(n) }
  return Object.assign(db, { __seen: seen }) as never
}

/** One ad that spent, fully resolvable, everything fresh, no change markers. */
const healthyCohort = (): Record<string, Row[]> => ({
  daily_insights: [
    { ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 500, date_start: ROW_DATE },
    { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 500, date_start: ROW_DATE },
  ],
  ads: [{ id: 'a1', ad_account_id: 'acct', adset_id: 's1', campaign_id: 'c1',
          meta_updated_time: iso(90 * 24 * HOUR), last_synced_at: iso(2 * HOUR) }],
  // campaign_id lives on the AD SET: it is the authoritative parent link. `ads.campaign_id` is a
  // denormalized copy and is deliberately NOT used for parentage any more.
  adsets: [{ id: 's1', ad_account_id: 'acct', campaign_id: 'c1', meta_updated_time: iso(90 * 24 * HOUR),
             last_synced_at: iso(2 * HOUR), last_sig_edit_ts: null }],
  campaigns: [{ id: 'c1', ad_account_id: 'acct', meta_updated_time: iso(90 * 24 * HOUR),
                last_synced_at: iso(2 * HOUR) }],
  change_requests: [], ad_setup_decisions: [],
})

describe('structural continuity — cohort-scoped proof, not global freshness', () => {
  it('the category list contains ONLY vocabulary the shipped schema documents', async () => {
    const db = await freshSchemaDb()
    const { rows } = await db.query<{ comment: string | null }>(`
      SELECT col_description('public.ad_setup_decisions'::regclass, a.attnum) AS comment
        FROM pg_attribute a
       WHERE a.attrelid = 'public.ad_setup_decisions'::regclass AND a.attname = 'setting_category'`)
    const documented = (rows[0]?.comment ?? '').replace(/^Setting vocabulary:\s*/, '').split('|').map((c) => c.trim())
    // The documented vocabulary and the application's list must be the same set, in both directions.
    expect([...documented].sort()).toEqual([...SETTING_CATEGORIES].sort())
    for (const cat of MATERIAL_SETTING_CATEGORIES) {
      expect(documented, `"${cat}" is not in the shipped vocabulary`).toContain(cat)
    }
    expect(MATERIAL_SETTING_CATEGORIES as readonly string[]).not.toContain('targeting')
    for (const real of ['audience', 'geo', 'age_gender', 'placements', 'advantage_plus', 'retargeting', 'exclusions']) {
      expect(MATERIAL_SETTING_CATEGORIES as readonly string[]).toContain(real)
    }
  })

  it('proves continuity when the WHOLE cohort resolves, is fresh, and shows no change', async () => {
    expect(await proveStructuralContinuity(fakeDb(healthyCohort()), 'acct', PERIODS)).toBe(true)
  })

  // ── Cohort-scoped continuity reproductions ────────────────────────────────────────────────────────────────────
  it('a fresh campaign beside a 72h-STALE ad set must NOT prove continuity', async () => {
    const t = healthyCohort()
    t.adsets = [{ id: 's1', ad_account_id: 'acct', campaign_id: 'c1', meta_updated_time: iso(90 * 24 * HOUR),
                  last_synced_at: iso(72 * HOUR), last_sig_edit_ts: null }]
    // Global "is any row fresh" returned true here: the campaign's 2h sync hid the stale ad set.
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBeNull()
  })

  it('R6: spend exists but the ad-level cohort cannot be resolved => null, never true', async () => {
    const noAdRows = healthyCohort()
    noAdRows.ads = []                               // the ad that spent is not synced
    expect(await proveStructuralContinuity(fakeDb(noAdRows), 'acct', PERIODS)).toBeNull()

    const noAdSpend = healthyCohort()
    noAdSpend.daily_insights = [{ ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 500, date_start: ROW_DATE }]
    expect(await proveStructuralContinuity(fakeDb(noAdSpend), 'acct', PERIODS)).toBeNull()

    const noAdsets = healthyCohort()
    noAdsets.adsets = []
    expect(await proveStructuralContinuity(fakeDb(noAdsets), 'acct', PERIODS)).toBeNull()

    const noCampaigns = healthyCohort()
    noCampaigns.campaigns = []
    expect(await proveStructuralContinuity(fakeDb(noCampaigns), 'acct', PERIODS)).toBeNull()
  })

  it("R7: ANOTHER account's executed change must not deny continuity here", async () => {
    const t = healthyCohort()
    t.change_requests = [{ id: 'x', ad_account_id: 'OTHER', status: 'executed', executed_at: AFTER_SINCE }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)

    const mine = healthyCohort()
    mine.change_requests = [{ id: 'x', ad_account_id: 'acct', status: 'executed', executed_at: AFTER_SINCE }]
    expect(await proveStructuralContinuity(fakeDb(mine), 'acct', PERIODS)).toBe(false)
  })

  it('every query is ad_account_id-scoped', async () => {
    const db = fakeDb(healthyCohort())
    await proveStructuralContinuity(db, 'acct', PERIODS)
    const seen = (db as unknown as { __seen: Array<{ table: string; filters: Record<string, unknown> }> }).__seen
    for (const t of ['change_requests', 'ad_setup_decisions', 'daily_insights', 'ads', 'adsets', 'campaigns']) {
      const q = seen.find((x) => x.table === t)
      expect(q, `${t} was never queried`).toBeDefined()
      expect(q!.filters.ad_account_id, `${t} query is not account-scoped`).toBe('acct')
    }
  })

  // ── evidence rules ───────────────────────────────────────────────────────────────────────────
  it('a NULL meta_updated_time on a RELEVANT row yields null — unknown is not unchanged', async () => {
    const t = healthyCohort()
    t.ads = [{ ...t.ads[0]!, meta_updated_time: null }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBeNull()
  })

  it("Meta's updated_time on a relevant row inside the period proves a CHANGE", async () => {
    const t = healthyCohort()
    t.adsets = [{ ...t.adsets[0]!, meta_updated_time: AFTER_SINCE }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(false)
  })

  it('catches a change made DURING the earliest period, not only after it', async () => {
    const t = healthyCohort()
    t.ads = [{ ...t.ads[0]!, meta_updated_time: iso(62 * 24 * HOUR) }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(false)
  })

  it('the significant-edit marker that resets learning proves a CHANGE', async () => {
    const t = healthyCohort()
    t.adsets = [{ ...t.adsets[0]!, last_sig_edit_ts: iso(60 * 24 * HOUR) }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(false)
  })

  it('a PENDING change request does not count as executed', async () => {
    const t = healthyCohort()
    t.change_requests = [{ id: 'x', ad_account_id: 'acct', status: 'pending', executed_at: null }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)
  })

  it('a logged manual decision proves a change (positive signal only)', async () => {
    const t = healthyCohort()
    t.ad_setup_decisions = [{ id: '1', ad_account_id: 'acct', setting_category: 'audience', action_taken_date: daysAgo(59) }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(false)
  })

  it('IRRELEVANT archived inventory is not required to be fresh', async () => {
    // A stale ad that carried none of the evaluated spend must not block the proof — the claim is
    // about the entities responsible for the spend, not about everything ever synced.
    const t = healthyCohort()
    t.ads = [...t.ads, { id: 'zzz-archived', ad_account_id: 'acct', adset_id: 's9', campaign_id: 'c9',
                         meta_updated_time: null, last_synced_at: iso(400 * HOUR) }]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)
  })

  // ── Spend-cohort completeness reproductions ────────────────────────────────────────────────────────────
  it('CONV-3: partial spend coverage yields null — $1,000 account vs $100 at ad level', async () => {
    // Reproduced returning `true`: the cohort was built from whatever ad rows existed and continuity
    // was then asserted over a tenth of the spend. A proof about "the setup responsible for the spend"
    // is worthless if it only saw a fragment of it.
    const t = healthyCohort()
    t.daily_insights = [
      { ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 1000, date_start: ROW_DATE },
      { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 100, date_start: ROW_DATE },
    ]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBeNull()
  })

  it('CONV-3: FULL coverage within tolerance still proves continuity', async () => {
    const t = healthyCohort()
    t.daily_insights = [
      { ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 1000, date_start: ROW_DATE },
      { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 995, date_start: ROW_DATE },
    ]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)
  })

  it('CONV-3: campaign parentage comes from the AD SET, not the ad\'s denormalized column', async () => {
    // A stale ads.campaign_id would send the proof to inspect a campaign that carried none of the
    // spend — and report ITS freshness and ITS change markers.
    const t = healthyCohort()
    t.ads = [{ ...t.ads[0]!, campaign_id: 'STALE-c9' }]       // denormalized copy is wrong
    t.adsets = [{ ...t.adsets[0]!, campaign_id: 'c1' }]        // authoritative parent is c1
    // c1 exists and is clean, so the proof succeeds via the AD SET's link. If it had followed the ad's
    // stale column it would have looked for STALE-c9, found nothing, and returned null.
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)

    // And a change on the AD-SET-resolved campaign is seen.
    const changed = healthyCohort()
    changed.ads = [{ ...changed.ads[0]!, campaign_id: 'STALE-c9' }]
    changed.campaigns = [{ ...changed.campaigns[0]!, meta_updated_time: AFTER_SINCE }]
    expect(await proveStructuralContinuity(fakeDb(changed), 'acct', PERIODS)).toBe(false)
  })

  it('CONV-3: the spend read is PAGED — a truncated read cannot fake full coverage', async () => {
    // 1,200 ad-day rows at $1 each against $1,200 of account spend. An unpaged read stops at 1,000,
    // sees $1,000 of $1,200 = 83% coverage, and would return null on a complete account.
    const t = healthyCohort()
    const adRows = Array.from({ length: 1200 }, (_, i) => ({
      ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 1,
      date_start: ROW_DATE, id: i + 1,
    }))
    t.daily_insights = [
      { ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 1200, date_start: ROW_DATE, id: 0 },
      ...adRows,
    ]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBe(true)
  })

  // ── Reconciliation is SYMMETRIC ───────────────────────────────────
  const withSpend = (account: number | null, ad: number) => {
    const t = healthyCohort()
    t.daily_insights = [
      ...(account === null ? [] : [{ ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: account, date_start: ROW_DATE }]),
      { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: ad, date_start: ROW_DATE },
    ]
    return t
  }

  it('CONV-7: $1,000 account vs $1,200 entity FAILS — overcount is disqualifying too', async () => {
    // Reproduced as "reconciled": the old check only rejected UNDER-count. Overcount means rows are
    // duplicated, mis-levelled or cross-account, so the cohort is not the one that spent the money.
    expect(await proveStructuralContinuity(fakeDb(withSpend(1000, 1200)), 'acct', PERIODS)).toBeNull()
  })

  it('CONV-7: $1,000 vs $995 passes, $1,000 vs $1,015 passes — 2% both ways', async () => {
    expect(await proveStructuralContinuity(fakeDb(withSpend(1000, 995)), 'acct', PERIODS)).toBe(true)
    expect(await proveStructuralContinuity(fakeDb(withSpend(1000, 1015)), 'acct', PERIODS)).toBe(true)
    expect(await proveStructuralContinuity(fakeDb(withSpend(1000, 1025)), 'acct', PERIODS)).toBeNull()
    expect(await proveStructuralContinuity(fakeDb(withSpend(1000, 975)), 'acct', PERIODS)).toBeNull()
  })

  it('CONV-7: zero-spend edge cases are deterministic', async () => {
    // 0 / 0 — a genuinely dormant window reconciles, but there is no cohort, so the proof is unknown.
    expect(await proveStructuralContinuity(fakeDb(withSpend(0, 0)), 'acct', PERIODS)).toBeNull()
    // Entity spend with NO account spend is a contradiction: no denominator could explain it.
    expect(await proveStructuralContinuity(fakeDb(withSpend(0, 500)), 'acct', PERIODS)).toBeNull()
    // A MISSING account row is not zero spend — without it reconciliation is not evaluable.
    expect(await proveStructuralContinuity(fakeDb(withSpend(null, 500)), 'acct', PERIODS)).toBeNull()
  })

  it('CONV-7: DUPLICATED entity rows are caught by the symmetric check', async () => {
    const t = healthyCohort()
    t.daily_insights = [
      { ad_account_id: 'acct', entity_level: 'account', ad_id: null, spend: 500, date_start: ROW_DATE },
      { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 500, date_start: ROW_DATE },
      { ad_account_id: 'acct', entity_level: 'ad', ad_id: 'a1', spend: 500, date_start: ROW_DATE },  // dup
    ]
    expect(await proveStructuralContinuity(fakeDb(t), 'acct', PERIODS)).toBeNull()
  })

  it('no periods, or any query error, yields null and never true', async () => {
    expect(await proveStructuralContinuity(fakeDb(healthyCohort()), 'acct', [])).toBeNull()
    for (const t of ['daily_insights', 'ads', 'adsets', 'campaigns', 'change_requests', 'ad_setup_decisions']) {
      expect(await proveStructuralContinuity(fakeDb(healthyCohort(), { errorOn: t }), 'acct', PERIODS),
        `error on ${t} must yield null`).toBeNull()
    }
  })
})
