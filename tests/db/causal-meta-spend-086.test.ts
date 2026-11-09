import type { PGlite } from '@electric-sql/pglite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MIN_SWITCHBACK_BLOCKS, causalDb, fixtureUnitIds, insertSwitchbackHistory, switchbackDates,
} from './causal-fixture'

const ACCOUNT = '00000000-0000-4000-8000-000000000111'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000112'
const EXPERIMENT = '00000000-0000-4000-8000-000000000113'
const DESIGN = '00000000-0000-4000-8000-000000000114'
const APPROVAL = '00000000-0000-4000-8000-000000000115'
const SOURCE_HEAD = `sha256:${'c'.repeat(64)}`
let db: PGlite

type Row = Record<string, unknown>

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0]
}

function spendDay(date: string, minor: number, marker = 'd') {
  return {
    spend_date: date,
    spend_minor: minor,
    source_fingerprint: `sha256:${marker.repeat(64)}`,
  }
}

// The local calendar days of the design window: twelve one-day switchback blocks from 2026-01-01,
// the smallest time-block design the baseline schema admits.
const DATES = switchbackDates()
const LAST = DATES.length - 1

/** One explicit row per design day; `minors` overrides the spend of the day at that index. */
function everyDay(minors: Record<number, number> = {}) {
  return DATES.map((date, i) => spendDay(date, minors[i] ?? 8000, i.toString(16)))
}

async function createHistoricalDesign() {
  await insertSwitchbackHistory(db, {
    account: ACCOUNT, experiment: EXPERIMENT, design: DESIGN, approval: APPROVAL,
    unitIds: fixtureUnitIds(0x9086, MIN_SWITCHBACK_BLOCKS),
  })
}

async function commitSpend(over: Record<string, unknown> = {}) {
  const args = {
    start: '2026-01-01T05:00:00Z', end: '2026-01-13T05:00:00Z',
    dataThrough: '2026-01-14T00:00:00Z', complete: true, blockers: [],
    days: everyDay(),
    sourceHead: SOURCE_HEAD, previous: null, dedupe: 'meta-spend-v1', ...over,
  }
  return one<Row>(`SELECT (public.commit_causal_meta_spend_batch(
    $1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz,$8,$9::text[],
    $10::jsonb,$11,1,$12::uuid,$13
  )).*`, [
    ACCOUNT, EXPERIMENT, DESIGN, APPROVAL, args.start, args.end, args.dataThrough,
    args.complete, args.blockers, JSON.stringify(args.days), args.sourceHead,
    args.previous, args.dedupe,
  ])
}

beforeEach(async () => {
  db = await causalDb(ACCOUNT, OTHER_ACCOUNT)
  await createHistoricalDesign()
})

describe('causal Meta spend ledger', () => {
  it('commits every local day in integer minor units and retries idempotently', async () => {
    const first = await commitSpend()
    const retry = await commitSpend()
    expect(retry.id).toBe(first.id)
    expect(first).toMatchObject({
      complete: true, revision: 1, day_count: DATES.length, total_spend_minor: 8000 * DATES.length,
      timezone: 'America/New_York',
      publication_fingerprint: expect.stringMatching(/^md5:[0-9a-f]{32}$/),
    })
    expect((await db.query(`SELECT spend_date::text date,spend_minor
      FROM public.causal_meta_spend_days ORDER BY spend_date`)).rows).toEqual(
      DATES.map((date) => ({ date, spend_minor: 8000 })))
  })

  it('requires an explicit row for every day, including zero-spend days', async () => {
    await expect(commitSpend({ days: everyDay().slice(0, LAST) }))
      .rejects.toThrow(/every local calendar day/i)
    const zero = await commitSpend({
      days: everyDay({ [LAST]: 0 }),
      dedupe: 'explicit-zero-day',
    })
    expect(zero.total_spend_minor).toBe(8000 * LAST)
  })

  it('rejects duplicate, out-of-window, non-integer, or unsupported day fields', async () => {
    await expect(commitSpend({
      days: [...everyDay().slice(0, LAST), spendDay(DATES[0], 1, 'e')],
    })).rejects.toThrow(/duplicate/i)
    await expect(commitSpend({
      days: [...everyDay().slice(0, LAST), spendDay('2026-01-13', 1, 'e')],
      dedupe: 'outside-day',
    })).rejects.toThrow(/every local calendar day|outside/i)
    await expect(commitSpend({
      days: [...everyDay().slice(0, LAST), { ...spendDay(DATES[LAST], 1, 'e'), spend_minor: 1.5 }],
      dedupe: 'fractional-spend',
    })).rejects.toThrow(/integer minor units/i)
  })

  it('requires the exact design window aligned to local midnight', async () => {
    await expect(commitSpend({
      start: '2026-01-01T06:00:00Z', dedupe: 'misaligned-window',
    })).rejects.toThrow(/exact measurement window|local midnight/i)
  })

  it('records incomplete coverage without days and supports immutable restatements', async () => {
    const blocked = await commitSpend({
      complete: false, blockers: ['meta_unavailable'], days: [],
      dedupe: 'meta-spend-blocked',
    })
    expect(blocked).toMatchObject({ complete: false, revision: 1, day_count: 0 })
    const recovered = await commitSpend({
      previous: blocked.id, sourceHead: `sha256:${'1'.repeat(64)}`,
      dedupe: 'meta-spend-recovered',
    })
    const restated = await commitSpend({
      previous: recovered.id, sourceHead: `sha256:${'2'.repeat(64)}`,
      days: everyDay({ [LAST]: 8100 }),
      dedupe: 'meta-spend-restated',
    })
    expect(restated).toMatchObject({ revision: 3, total_spend_minor: 8000 * LAST + 8100 })
    expect(await one<{ batches: number }>(`SELECT count(*)::int batches
      FROM public.causal_meta_spend_batches`)).toEqual({ batches: 3 })
  })

  // 086 was tested in isolation, where daily_insights did not exist. On the shipped schema the property
  // is stated directly: the spend ledger's writer never reads the mutable insights table, and committing
  // spend creates no estimate.
  it('does not depend on mutable daily_insights or create estimates', async () => {
    const src = await one<{ body: string }>(`
      SELECT string_agg(prosrc, E'\n') AS body FROM pg_proc
       WHERE pronamespace='public'::regnamespace AND proname='commit_causal_meta_spend_batch'`)
    expect(src.body.length).toBeGreaterThan(0)
    expect(src.body).not.toMatch(/daily_insights/)
    await commitSpend()
    expect(await one<{ estimates: number }>(`SELECT count(*)::int AS estimates FROM public.causal_contribution_estimates`))
      .toEqual({ estimates: 0 })
  })

  it('keeps spend rows append-only and isolated from browser/direct app writes', async () => {
    const batch = await commitSpend()
    await expect(db.query(`DELETE FROM public.causal_meta_spend_batches WHERE id=$1`, [batch.id]))
      .rejects.toThrow(/immutable|append-only/i)
    expect(await one<{ dml: number; browser_reads: number; service_reads: number }>(`
      SELECT
        (SELECT count(*)::int FROM (VALUES ('service_role'),('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE')) p(privilege_name)
          CROSS JOIN (VALUES ('causal_meta_spend_batches'),('causal_meta_spend_days')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,privilege_name)) dml,
        (SELECT count(*)::int FROM (VALUES ('authenticated'),('anon')) r(role_name)
          CROSS JOIN (VALUES ('causal_meta_spend_batches'),('causal_meta_spend_days')) t(table_name)
          WHERE has_table_privilege(role_name,'public.' || table_name,'SELECT')) browser_reads,
        (SELECT count(*)::int FROM (VALUES ('causal_meta_spend_batches'),
            ('causal_meta_spend_days')) t(table_name)
          WHERE has_table_privilege('service_role','public.' || table_name,'SELECT')) service_reads
    `)).toEqual({ dml: 0, browser_reads: 0, service_reads: 2 })
  })
})
