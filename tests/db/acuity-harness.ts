import type { PGlite } from '@electric-sql/pglite'
import { freshSchemaDb, insertAdAccount } from './schema-db'

// In-process Postgres (PGlite) carrying the SHIPPED schema (every file in supabase/migrations), so the
// outcome ledger, its conversion delivery state, the observation lineage triggers and the atomic delivery
// RPC are exactly what production runs. Behaviour that depends on PostgREST/JWT role switching is still
// proved in the real local Supabase suite.

export const ACCOUNT = '00000000-0000-4000-8000-000000000001'
export const OTHER_ACCOUNT = '00000000-0000-4000-8000-000000000002'

/** Deterministic outcome uuid for an Acuity appointment id: outcomeUuid(501) → 00000000-0000-4000-a000-000000000501. */
export const outcomeUuid = (outcomeId: number): string => `00000000-0000-4000-a000-${String(outcomeId).padStart(12, '0')}`

/** Deterministic id of an account's Acuity outcome source (keyed by the account uuid's last 12 digits). */
export const outcomeSourceId = (account: string): string => `00000000-0000-4000-b000-${account.slice(-12)}`

/** Ensure the account's Acuity outcome source exists (the required parent of every outcome row). */
export async function ensureAcuitySource(db: PGlite, account: string = ACCOUNT): Promise<string> {
  const id = outcomeSourceId(account)
  await db.query(
    `INSERT INTO public.outcome_sources (id, ad_account_id, kind, label, enabled)
     VALUES ($1, $2, 'acuity', 'Acuity Scheduling', true)
     ON CONFLICT (id) DO NOTHING`,
    [id, account],
  )
  return id
}

/**
 * INSERT one Acuity booking outcome with the given extra columns and return its uuid. The identity
 * columns (id, ad_account_id, source_id, external_id = String(outcomeId), outcome_type 'booking',
 * currency 'USD') are always set; `columns` supplies everything else in the new outcome vocabulary.
 */
export async function insertOutcome(
  db: PGlite,
  outcomeId: number,
  columns: Record<string, unknown> = {},
  account: string = ACCOUNT,
): Promise<string> {
  const source = await ensureAcuitySource(db, account)
  const id = outcomeUuid(outcomeId)
  const all: Record<string, unknown> = {
    id, ad_account_id: account, source_id: source, external_id: String(outcomeId),
    outcome_type: 'booking', currency: 'USD', ...columns,
  }
  const keys = Object.keys(all)
  await db.query(
    `INSERT INTO public.outcomes (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => all[k]),
  )
  return id
}

export async function freshOutcomeDb(): Promise<PGlite> {
  const db = await freshSchemaDb()
  await insertAdAccount(db, ACCOUNT, 'act_1')
  await insertAdAccount(db, OTHER_ACCOUNT, 'act_2')
  await db.query(`UPDATE public.ad_accounts SET is_active = false WHERE id = $1`, [OTHER_ACCOUNT])
  await ensureAcuitySource(db, ACCOUNT)
  await ensureAcuitySource(db, OTHER_ACCOUNT)
  return db
}

export interface ApptSeed {
  id: number
  price?: number | null
  canceled?: boolean
  source?: string | null
  datetimeCreated?: string
  account?: string
}

function apptParams(s: ApptSeed): unknown[] {
  const account = s.account ?? ACCOUNT
  return [
    outcomeUuid(s.id),
    account,
    outcomeSourceId(account),
    String(s.id),
    s.price ?? null,
    s.canceled ? 'cancelled' : 'confirmed',
    s.source ?? null,
    s.datetimeCreated ?? '2026-07-20T14:00:00Z',
    '2026-07-20',
  ]
}

const APPT_INSERT = `INSERT INTO outcomes
       (id, ad_account_id, source_id, external_id, outcome_type, currency,
        gross_value, status, observation_source, occurred_at, business_date)
     VALUES ($1,$2,$3,$4,'booking','USD',$5,$6,$7,$8,$9)`

/** INSERT one appointment through the real write path (so the triggers fire exactly as in prod). */
export async function insertAppt(db: PGlite, s: ApptSeed): Promise<void> {
  await db.query(APPT_INSERT, apptParams(s))
}

/** The real upsert shape the app uses: INSERT ... ON CONFLICT (account, source, external id) DO UPDATE. */
export async function upsertAppt(db: PGlite, s: ApptSeed): Promise<void> {
  await db.query(
    `${APPT_INSERT}
     ON CONFLICT (ad_account_id, source_id, external_id) DO UPDATE SET
       gross_value = EXCLUDED.gross_value,
       status = EXCLUDED.status,
       observation_source = EXCLUDED.observation_source,
       synced_at = now()`,
    apptParams(s),
  )
}

export interface ObservationRow {
  outcome_id: string
  change_kind: string
  provenance: string
  observation_source: string
  old_gross_value: string | null
  new_gross_value: string | null
  old_cancelled: boolean | null
  new_cancelled: boolean | null
}

export async function observations(db: PGlite, apptId: number): Promise<ObservationRow[]> {
  const r = await db.query<ObservationRow>(
    `SELECT outcome_id, change_kind, provenance, observation_source,
            old_gross_value, new_gross_value, old_cancelled, new_cancelled
     FROM outcome_observations WHERE outcome_id = $1 ORDER BY id`,
    [outcomeUuid(apptId)],
  )
  return r.rows
}
