import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { freshSchemaDb, insertAdAccount, fixtureUuid } from './schema-db'
import { pgliteSupabase } from './postgrest-pglite'
import { signOutcomeWebhook } from '@/lib/outcomes/adapters/webhook/signature'
import { hashPaidTouchToken, issuePaidTouchToken } from '@/lib/attribution/paid-touch-contract'

// On the SHIPPED schema: a webhook delivery carrying a signed paid-touch token is linked to its
// paid touch through the generic link RPC; every applied delivery records the independent paid
// eligibility input and link evaluation (the linker side of the completeness manifest). A delivery
// without a token is counted as NOT linked, never dropped from the denominator, and an enabled webhook
// source no longer blocks paid cohorts by itself. Only the Supabase transport is swapped (SDK → SQL).

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('@/lib/supabase/admin', () => ({ getAdminClient: () => state.client }))

import { POST } from '@/app/api/outcomes/webhook/[sourceId]/route'
import { publishPaidCohortPair } from '@/lib/attribution/paid-cohort-store'

const ACCOUNT = fixtureUuid(9701)
const OTHER = fixtureUuid(9702)
const RUN = fixtureUuid(9703)
const TOUCH_1 = fixtureUuid(9711)
const TOUCH_LATE = fixtureUuid(9712)
const TOUCH_OTHER = fixtureUuid(9713)
const TOKEN_1 = fixtureUuid(9721)
const TOKEN_LATE = fixtureUuid(9722)
const TOKEN_OTHER = fixtureUuid(9723)
const WEBHOOK_SECRET = 'e'.repeat(64)
const TOKEN_SECRET = 't'.repeat(64)
const token = (id: string, key = TOKEN_SECRET) => issuePaidTouchToken(id, key)

let db: PGlite
let source: string

async function insertTouch(account: string, touch: string, tokenId: string, observedAt: string, key = TOKEN_SECRET) {
  await db.query(`
    INSERT INTO public.paid_touch_observations(
      id,ad_account_id,browser_capture_id,observed_at,source,fbclid,meta_campaign_id,meta_adset_id,meta_ad_id,
      utm_source,utm_medium,landing_url,contract_version,capture_fingerprint)
    VALUES ($1,$2,gen_random_uuid(),$3,'meta',$4,'101','201','301','facebook','paid_social',
      'https://shop.example.test/',1,$5)`,
  [touch, account, observedAt, `fbclid-${touch.slice(-4)}`, `sha256:${touch.slice(-12).padStart(64, '0')}`])
  await db.query(`
    INSERT INTO public.paid_attribution_tokens(
      id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,policy_version,issued_at,expires_at)
    VALUES ($1,$2,$3,$3,$3,$4,1,$5,($5::timestamptz + interval '90 days'))`,
  [tokenId, account, touch, hashPaidTouchToken(token(tokenId, key)), observedAt])
}

const delivery = (externalId: string, over: Record<string, unknown> = {}) => JSON.stringify({
  external_id: externalId, outcome_type: 'sale', status: 'confirmed', currency: 'USD',
  gross_value: '120.50', collected_value: '120.50', occurred_at: '2026-07-20T18:00:00Z', origin: 'website',
  ...over,
})
const withToken = (externalId: string, value: string, over: Record<string, unknown> = {}) =>
  delivery(externalId, { attribution: { paid_touch_token: value }, ...over })

let tick = 0
async function post(body: string) {
  // A fresh timestamp per delivery: a redelivery is a new signed delivery, not a replay.
  const t = Math.floor(Date.now() / 1000) - 100 + (tick += 1)
  const res = await POST(new Request(`http://localhost/api/outcomes/webhook/${source}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-maxx-signature': signOutcomeWebhook(WEBHOOK_SECRET, t, body) },
  }), { params: Promise.resolve({ sourceId: source }) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const links = async () => (await db.query<{ external_id: string; token_id: string }>(`
  SELECT o.external_id, l.token_id FROM public.outcome_touch_links l JOIN public.outcomes o ON o.id = l.outcome_id
   ORDER BY o.external_id`)).rows
const evaluations = async () => (await db.query<{ external_id: string; evaluation_status: string; reason_code: string | null; paid_evidence_present: boolean }>(`
  SELECT DISTINCT ON (o.external_id) o.external_id, e.evaluation_status, e.reason_code, e.paid_evidence_present
    FROM public.paid_outcome_link_evaluations e JOIN public.outcomes o ON o.id = e.outcome_id
   ORDER BY o.external_id, e.evaluated_at DESC, e.id DESC`)).rows

async function activateSurfaces() {
  for (const [surface, n] of [
    ['capture_attempt', 1], ['scheduler_delivery', 2], ['outcome_link_evaluation', 3], ['collected_value_observation', 4],
  ] as const) {
    await db.query(`SELECT public.record_paid_eligibility_surface_activation($1,$2,$3,'2026-07-01T00:00:00Z',1,$4)`,
      [ACCOUNT, fixtureUuid(9740 + n), surface, `p10b-${surface}`])
  }
}

/** One manifest per evaluation run: each call gets its own run (a run's manifest is immutable). */
async function manifest(n: number) {
  const run = n === 1 ? RUN : fixtureUuid(9730 + n)
  if (run !== RUN) await db.query(`INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES ($1,$2,'success')`, [run, ACCOUNT])
  const { rows } = await db.query<{ m: Record<string, unknown> }>(`
    SELECT public.produce_paid_cohort_completeness_manifest(
      $1,$2,$3,'recent_scale','2026-07-16','2026-07-29','2026-07-30T00:00:00Z',1,1) m`,
  [fixtureUuid(9750 + n), ACCOUNT, run])
  return rows[0].m
}

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_9701')
  await insertAdAccount(db, OTHER, 'act_9702')
  await db.query('UPDATE public.ad_accounts SET is_active = false WHERE id = $1', [OTHER])
  vi.stubEnv('NEXT_PUBLIC_ACCOUNT_TIMEZONE', 'America/New_York')
  vi.stubEnv('PAID_TOUCH_TOKEN_SECRET', TOKEN_SECRET)
  state.client = pgliteSupabase(db)
  source = (await db.query<{ id: string }>('select public.create_outcome_webhook_source($1,$2,true,$3) as id',
    [ACCOUNT, 'Shop', WEBHOOK_SECRET])).rows[0].id
  await db.query(`INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES ($1,$2,'success')`, [RUN, ACCOUNT])
  await insertTouch(ACCOUNT, TOUCH_1, TOKEN_1, '2026-07-20T16:00:00Z')
  await insertTouch(ACCOUNT, TOUCH_LATE, TOKEN_LATE, '2026-07-21T18:00:00Z')
  await insertTouch(OTHER, TOUCH_OTHER, TOKEN_OTHER, '2026-07-20T16:00:00Z')
})

afterEach(() => vi.unstubAllEnvs())

describe('webhook paid-touch linking on the shipped schema', () => {
  it('links a delivery with a valid token and records it; one without a token is recorded as not linked', async () => {
    const linked = await post(withToken('ORDER-A', token(TOKEN_1)))
    expect(linked).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'linked' } })
    const absent = await post(delivery('ORDER-B', { occurred_at: '2026-07-20T19:00:00Z' }))
    expect(absent).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'absent' } })

    expect(await links()).toEqual([{ external_id: 'ORDER-A', token_id: TOKEN_1 }])
    expect(await evaluations()).toEqual([
      { external_id: 'ORDER-A', evaluation_status: 'linked', reason_code: null, paid_evidence_present: true },
      { external_id: 'ORDER-B', evaluation_status: 'absent', reason_code: 'no_paid_evidence', paid_evidence_present: false },
    ])
    // The token is never stored with the outcome: the link keeps only its hash.
    expect((await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.outcomes WHERE raw::text LIKE '%pt1.%'`)).rows[0].n).toBe(0)
  })

  it('ignores an unusable token with a recorded reason and still stores the outcome', async () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['ORDER-FORGED', token(TOKEN_1, 'f'.repeat(64)), {}, 'invalid_token'],
      // The touch happened after the outcome: the link RPC refuses it (time ordering).
      ['ORDER-EARLY', token(TOKEN_LATE), { occurred_at: '2026-07-21T12:00:00Z' }, 'link_rejected'],
      // Another account's token: the link RPC looks tokens up per account.
      ['ORDER-FOREIGN', token(TOKEN_OTHER), {}, 'link_rejected'],
      // A staff-entered outcome cannot be linked to an ad click.
      ['ORDER-STAFF', token(TOKEN_1), { origin: 'staff_or_manual' }, 'link_rejected'],
    ]
    for (const [externalId, value, over, reason] of cases) {
      const res = await post(withToken(externalId, value, over))
      expect(res, externalId).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'rejected' } })
      expect(JSON.stringify(res.body), externalId).not.toContain(reason)
      expect((await evaluations()).find((row) => row.external_id === externalId), externalId)
        .toEqual({ external_id: externalId, evaluation_status: 'rejected', reason_code: reason, paid_evidence_present: true })
    }
    expect(await links()).toEqual([])
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM public.outcomes')).rows[0].n).toBe(4)
  })

  it('refuses a malformed token as INVALID_PAYLOAD naming only the field, and stores nothing', async () => {
    const res = await post(withToken('ORDER-BAD', 'pt1.not-a-token'))
    expect(res).toEqual({ status: 400, body: { error: 'Invalid payload', code: 'INVALID_PAYLOAD', fields: ['attribution.paid_touch_token'] } })
    expect((await db.query<{ n: number }>('SELECT count(*)::int n FROM public.outcomes')).rows[0].n).toBe(0)
  })

  it('is idempotent: a redelivery keeps the one link, with or without the token; another token cannot relink', async () => {
    expect((await post(withToken('ORDER-A', token(TOKEN_1)))).body.paid_touch).toBe('linked')
    expect((await post(withToken('ORDER-A', token(TOKEN_1), { status: 'refunded', collected_value: '0' }))).body.paid_touch).toBe('linked')
    // A later system (refunds) may not know the token: the stored link still stands.
    expect((await post(delivery('ORDER-A', { status: 'cancelled' }))).body.paid_touch).toBe('linked')
    expect((await post(withToken('ORDER-A', token(TOKEN_LATE), { occurred_at: '2026-07-22T12:00:00Z' }))).body.paid_touch).toBe('rejected')
    expect(await links()).toEqual([{ external_id: 'ORDER-A', token_id: TOKEN_1 }])
  })

  it('records a value beyond double precision exactly: payload → outcome → eligibility input → evaluation', async () => {
    // 15 integer and 6 fraction digits (the stored money bound): a JS number keeps only ~17 significant
    // digits, so a number-typed hand-off would fail the ledger's exact comparison and leave a gap.
    const value = '123456789012345.123456'
    expect(String(Number(value))).not.toBe(value) // precondition: a double cannot carry it
    vi.stubEnv('OUTCOME_MONEY_CEILING', '1000000000000000') // above the default sanity ceiling on purpose
    const res = await post(withToken('ORDER-BIG', token(TOKEN_1), { gross_value: value, collected_value: value }))
    expect(res).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'linked' } })
    const { rows } = await db.query<{ gross: string; outcome: string; input: string; evaluation: string }>(`
      SELECT o.gross_value::text gross, o.collected_value::text outcome, i.collected_value::text input, e.collected_value::text evaluation
        FROM public.outcomes o
        JOIN public.paid_outcome_eligibility_inputs i ON i.outcome_id = o.id
        JOIN public.paid_outcome_link_evaluations e ON e.eligibility_input_id = i.id
       WHERE o.external_id = 'ORDER-BIG'`)
    expect(rows).toEqual([{ gross: value, outcome: value, input: value, evaluation: value }])
    // Control: an ordinary value takes the same path.
    await post(withToken('ORDER-SMALL', token(TOKEN_1), { collected_value: '120.50' }))
    const small = await db.query<{ v: string }>(`SELECT i.collected_value::text v FROM public.paid_outcome_eligibility_inputs i
      JOIN public.outcomes o ON o.id = i.outcome_id WHERE o.external_id = 'ORDER-SMALL'`)
    expect(small.rows).toEqual([{ v: '120.50' }])
  })

  it('after a secret rotation, a token signed with the replaced secret links only inside the grace window', async () => {
    const replaced = 'f'.repeat(64)
    // The token was minted before the switch, so the database holds the hash of the old-signed token.
    const [touch, tokenId] = [fixtureUuid(9714), fixtureUuid(9724)]
    await insertTouch(ACCOUNT, touch, tokenId, '2026-07-20T16:30:00Z', replaced)
    // Control: without the grace window the replaced secret verifies nothing.
    expect((await post(withToken('ORDER-NOGRACE', token(tokenId, replaced)))).body.paid_touch).toBe('rejected')
    vi.stubEnv('PAID_TOUCH_TOKEN_PREVIOUS_SECRET', replaced)
    vi.stubEnv('PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL', new Date(Date.now() + 3_600_000).toISOString())
    expect((await post(withToken('ORDER-GRACE', token(tokenId, replaced)))).body.paid_touch).toBe('linked')
    vi.stubEnv('PAID_TOUCH_TOKEN_PREVIOUS_SECRET_UNTIL', new Date(Date.now() - 1_000).toISOString())
    expect((await post(withToken('ORDER-LATE', token(tokenId, replaced), { occurred_at: '2026-07-20T19:00:00Z' }))).body.paid_touch).toBe('rejected')
    expect(await links()).toEqual([{ external_id: 'ORDER-GRACE', token_id: tokenId }])
  })

  it('without PAID_TOUCH_TOKEN_SECRET nothing links and the gap is recorded as not configured', async () => {
    vi.stubEnv('PAID_TOUCH_TOKEN_SECRET', '')
    expect((await post(withToken('ORDER-A', token(TOKEN_1)))).body.paid_touch).toBe('not_configured')
    expect(await links()).toEqual([])
    expect((await evaluations())[0]).toMatchObject({ evaluation_status: 'not_configured', reason_code: 'linker_not_configured' })
  })
})

describe('fbclid fallback for a tokenless delivery (same rule as the reference adapter)', () => {
  // TOUCH_1 was observed 2026-07-20T16:00Z with fbclid `fbclid-<last 4 of its id>` and is identity complete.
  const FBCLID_1 = `fbclid-${TOUCH_1.slice(-4)}`
  const paidClick = (fbclid: string, over: Record<string, string> = {}) =>
    ({ attribution: { fbclid, utm_source: 'facebook', utm_medium: 'paid_social', ...over } })

  it('links a paid-social click id to its observed paid touch and completes the linker', async () => {
    await activateSurfaces()
    const res = await post(delivery('ORDER-F', paidClick(FBCLID_1)))
    expect(res).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'linked' } })
    expect(await links()).toEqual([{ external_id: 'ORDER-F', token_id: null }])
    expect(await evaluations()).toEqual([
      { external_id: 'ORDER-F', evaluation_status: 'linked', reason_code: null, paid_evidence_present: true },
    ])
    expect(await manifest(1)).toMatchObject({ linker_complete: true, eligible_outcomes: 1, evaluated_outcomes: 1, linked_outcomes: 1 })
  })

  it('fails closed on anything ambiguous: no link, the evidence stays unlinked and the linker incomplete', async () => {
    const cases: Array<[string, Record<string, unknown>, string, boolean]> = [
      // Paid-social click id with no observed touch.
      ['ORDER-UNSEEN', paidClick('fbclid-never-seen'), 'no_paid_touch_token', true],
      // The only touch with this click id happened after the outcome.
      ['ORDER-BEFORE', { ...paidClick(FBCLID_1), occurred_at: '2026-07-20T15:00:00Z' }, 'no_paid_touch_token', true],
      // The click id belongs to another account's touch.
      ['ORDER-OTHER', paidClick(`fbclid-${TOUCH_OTHER.slice(-4)}`), 'no_paid_touch_token', true],
      // A staff-entered or origin-unknown outcome is never linked to an ad click.
      ['ORDER-STAFFF', { ...paidClick(FBCLID_1), origin: 'staff_or_manual' }, 'no_paid_touch_token', true],
      ['ORDER-UNKNOWN', { ...paidClick(FBCLID_1), origin: 'unknown' }, 'no_paid_touch_token', true],
      // No paid-social UTMs: a click id alone is not paid evidence, so there is no fallback.
      ['ORDER-ORGANIC', { attribution: { fbclid: FBCLID_1, utm_source: 'facebook', utm_medium: 'social' } }, 'no_paid_evidence', false],
    ]
    for (const [externalId, over, reason, evidence] of cases) {
      const res = await post(delivery(externalId, over))
      expect(res, externalId).toMatchObject({ status: 200, body: { ok: true, applied: true, paid_touch: 'absent' } })
      expect((await evaluations()).find((row) => row.external_id === externalId), externalId)
        .toEqual({ external_id: externalId, evaluation_status: 'absent', reason_code: reason, paid_evidence_present: evidence })
    }
    // A token that fails verification is terminal: the click id beside it is not a second chance.
    const forged = await post(delivery('ORDER-FORGEDF', {
      attribution: { ...paidClick(FBCLID_1).attribution, paid_touch_token: token(TOKEN_1, 'f'.repeat(64)) },
    }))
    expect(forged.body.paid_touch).toBe('rejected')
    expect(await links()).toEqual([])
  })

  it('without PAID_TOUCH_TOKEN_SECRET the fallback does not run either', async () => {
    vi.stubEnv('PAID_TOUCH_TOKEN_SECRET', '')
    expect((await post(delivery('ORDER-NC', paidClick(FBCLID_1)))).body.paid_touch).toBe('not_configured')
    expect(await links()).toEqual([])
  })
})

describe('coverage: the linker manifest and the paid cohort', () => {
  it('counts every webhook outcome: linked ones as linked, tokenless ones as not linked', async () => {
    await activateSurfaces()
    await post(withToken('ORDER-A', token(TOKEN_1)))
    await post(delivery('ORDER-B', { occurred_at: '2026-07-20T19:00:00Z' }))
    expect(await manifest(1)).toMatchObject({
      linker_complete: true, eligible_outcomes: 1, evaluated_outcomes: 1, linked_outcomes: 1,
      blocker_codes: ['independent_capture_denominator_unavailable'],
    })

    // A delivery with paid evidence that cannot be linked is eligible and unlinked: the linker is incomplete.
    await post(withToken('ORDER-C', token(TOKEN_1, 'f'.repeat(64)), { occurred_at: '2026-07-20T20:00:00Z' }))
    const second = await manifest(2)
    expect(second).toMatchObject({ linker_complete: false, eligible_outcomes: 2, evaluated_outcomes: 2, linked_outcomes: 1 })
    expect(second.blocker_codes).toContain('link_resolution_incomplete')
    expect(second.blocker_codes).not.toContain('outcome_eligibility_inputs_incomplete')
  })

  it('control: an outcome that never went through the linker leaves the inputs incomplete', async () => {
    await activateSurfaces()
    await post(withToken('ORDER-A', token(TOKEN_1)))
    await db.query(`
      INSERT INTO public.outcomes(ad_account_id,source_id,external_id,outcome_type,currency,occurred_at,status,observation_source)
      VALUES ($1,$2,'DIRECT-1','sale','USD','2026-07-20T21:00:00Z','confirmed','webhook')`, [ACCOUNT, source])
    const result = await manifest(3)
    expect(result.linker_complete).toBe(false)
    expect(result.blocker_codes).toContain('outcome_eligibility_inputs_incomplete')
  })

  it('a webhook source does not block the cohort by itself; its linked outcome counts and the tokenless one does not', async () => {
    await db.query(`INSERT INTO public.paid_measurement_activations(id,ad_account_id,activated_at,contract_version,policy_version,source_kind,source_ref)
      VALUES ($1,$2,'2026-06-01T12:00:00Z',1,1,'controlled_journey','p10b')`, [fixtureUuid(9760), ACCOUNT])
    await post(withToken('ORDER-A', token(TOKEN_1)))
    await post(delivery('ORDER-B', { occurred_at: '2026-07-20T19:00:00Z' }))
    const context = {
      evaluationRunId: RUN, asOfDate: '2026-07-30', sourceNotBefore: '2026-07-30T00:00:00Z',
      appointmentSourceComplete: false, appointmentSourceHead: null, appointmentSourceWindowBasis: null,
      appointmentSourceWindowStart: null, appointmentSourceWindowEnd: null,
    } as const
    const published = await publishPaidCohortPair(state.client!, ACCOUNT, context)
    expect(published.recent.blocker_codes).not.toContain('source_cannot_carry_token')
    const ad = published.recent.units.find((unit) => unit.entity_level === 'ad' && unit.entity_id === '301')
    expect(ad).toMatchObject({ bookings: 1, booked_value: 120.5 })

    // Control: an enabled CSV source still blocks every paid cohort.
    await db.query(`INSERT INTO public.outcome_sources(ad_account_id,kind,label,enabled) VALUES ($1,'csv','Import',true)`, [ACCOUNT])
    await db.query(`INSERT INTO public.api_sync_logs(id,ad_account_id,status) VALUES ($1,$2,'success')`, [fixtureUuid(9704), ACCOUNT])
    const blocked = await publishPaidCohortPair(state.client!, ACCOUNT, { ...context, evaluationRunId: fixtureUuid(9704) })
    expect(blocked.recent.blocker_codes).toContain('source_cannot_carry_token')
  })
})
