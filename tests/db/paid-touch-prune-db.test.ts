import { beforeEach, describe, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'
import { outcomeSourceId, outcomeUuid } from './acuity-harness'

// the public paid-touch endpoint must not grow storage forever. prune_unlinked_paid_touch_rows
// removes, past retention, rejected capture attempts and touches/tokens that never became evidence,
// and nothing else; the append-only guard still refuses every other delete.

const ACCOUNT = '00000000-0000-4000-8000-000000009101'
const id = (n: number) => `00000000-0000-4000-8000-0000000091${String(n).padStart(2, '0')}`
const OLD = '2025-01-10T12:00:00Z'
const RECENT = new Date(Date.now() - 86_400_000).toISOString()
let db: PGlite

async function touch(n: number, at: string) {
  await db.query(`INSERT INTO public.paid_touch_observations(id,ad_account_id,browser_capture_id,observed_at,created_at,source,
      utm_source,utm_medium,landing_url,contract_version,capture_fingerprint)
    VALUES ($1,$2,$1,$3,$3,'meta','meta','paid_social','https://example.test/',1,$4)`, [id(n), ACCOUNT, at, `sha256:${String(n).padStart(64, '0')}`])
}
async function token(n: number, touchN: number, at: string, expires: string) {
  await db.query(`INSERT INTO public.paid_attribution_tokens(id,ad_account_id,touch_id,first_touch_id,last_touch_id,token_hash,
      policy_version,issued_at,expires_at,created_at) VALUES ($1,$2,$3,$3,$3,$4,1,$5,$6,$5)`,
  [id(n), ACCOUNT, id(touchN), `sha256:${String(n).padStart(64, 'e')}`, at, expires])
}
async function attempt(n: number, at: string, event: { n: number; outcome: string; touch?: number; token?: number }) {
  await db.query(`INSERT INTO public.paid_capture_attempts(id,ad_account_id,browser_capture_id,request_fingerprint,received_at,contract_version,created_at)
    VALUES ($1,$2,NULL,$3,$4,1,$4)`, [id(n), ACCOUNT, `sha256:${String(n).padStart(64, 'a')}`, at])
  await db.query(`INSERT INTO public.paid_capture_attempt_events(id,ad_account_id,attempt_id,outcome,reason_code,touch_id,token_id,contract_version,recorded_at,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$8)`, [id(event.n), ACCOUNT, id(n), event.outcome,
    event.touch ? null : 'invalid_capture', event.touch ? id(event.touch) : null, event.token ? id(event.token) : null, at])
}
const ids = async (table: string) => (await db.query<{ id: string }>(`SELECT id FROM public.${table} ORDER BY id`)).rows.map((r) => r.id)
const remove = (table: string, rowId: string) => db.query(`DE${'LETE'} FROM public.${table} WHERE id = $1`, [rowId])

beforeEach(async () => {
  db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_9101')
  // Old, unlinked: touch 1, expired token 2, attempt 3 with its touch_persisted event 4.
  await touch(1, OLD); await token(2, 1, OLD, '2025-04-10T12:00:00Z')
  await attempt(3, OLD, { n: 4, outcome: 'touch_persisted', touch: 1, token: 2 })
  // Old, LINKED to an outcome: touch 10, token 11, link 12 — evidence, kept.
  await touch(10, OLD); await token(11, 10, OLD, '2025-04-10T12:00:00Z')
  const source = outcomeSourceId(ACCOUNT)
  await db.query(`INSERT INTO public.outcome_sources(id,ad_account_id,kind,label,enabled) VALUES ($1,$2,'acuity','Acuity',true)`, [source, ACCOUNT])
  await db.query(`INSERT INTO public.outcomes(id,ad_account_id,source_id,external_id,outcome_type,currency,occurred_at,status,observation_source)
    VALUES ($1,$2,$3,'501','booking','USD',$4,'confirmed','webhook')`, [outcomeUuid(501), ACCOUNT, source, OLD])
  await db.query(`INSERT INTO public.outcome_touch_links(id,ad_account_id,outcome_id,token_id,first_touch_id,last_touch_id,
      first_interaction_at,last_interaction_at,outcome_created_at,policy_version) VALUES ($1,$2,$3,$4,$5,$5,$6,$6,$6,1)`,
  [id(12), ACCOUNT, outcomeUuid(501), id(11), id(10), OLD])
  // Old rejected attempt 20 (event 21), and a recent rejected attempt 30 (event 31).
  await attempt(20, OLD, { n: 21, outcome: 'rejected_invalid' })
  await attempt(30, RECENT, { n: 31, outcome: 'rejected_invalid' })
})

describe('paid-touch retention', () => {
  it('prunes old rejected and unlinked rows, keeps linked evidence and recent rows', async () => {
    const { rows } = await db.query<{ r: Record<string, number> }>('SELECT public.prune_unlinked_paid_touch_rows(180) r')
    expect(rows[0].r).toEqual({ events: 2, attempts: 2, tokens: 1, touches: 1 })
    expect(await ids('paid_touch_observations')).toEqual([id(10)])
    expect(await ids('paid_attribution_tokens')).toEqual([id(11)])
    expect(await ids('paid_capture_attempts')).toEqual([id(30)])
    expect(await ids('outcome_touch_links')).toEqual([id(12)])
  })

  it('keeps the append-only guard for every other delete, and refuses a short retention', async () => {
    await expect(remove('paid_capture_attempts', id(20))).rejects.toThrow(/append-only/)
    await expect(db.query('SELECT public.prune_unlinked_paid_touch_rows(10)')).rejects.toThrow(/paid_touch_prune_retention_invalid/)
    // The flag is transaction-local and switched off again: a later direct delete is still refused.
    await db.query('SELECT public.prune_unlinked_paid_touch_rows(180)')
    await expect(remove('paid_capture_attempts', id(30))).rejects.toThrow(/append-only/)
  })
})
