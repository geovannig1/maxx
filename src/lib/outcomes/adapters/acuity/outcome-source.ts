import type { SupabaseClient } from '@supabase/supabase-js'

// The Acuity example adapter writes into the generic outcomes model (ADR-058): every Acuity
// appointment is an `outcomes` row under one `outcome_sources` row of kind 'acuity' for the account.
// The Acuity appointment id is the outcome's external_id; every foreign key carries the outcome uuid.

export const ACUITY_SOURCE_KIND = 'acuity'
export const ACUITY_SOURCE_LABEL = 'Acuity Scheduling'
export const ACUITY_OUTCOME_TYPE = 'booking'

export interface AcuitySource {
  sourceId: string
  /** ISO 4217 code every Acuity outcome of this account is recorded in (the ad account currency). */
  currency: string
}

/** The account's Acuity source id, or null when the account has never recorded an Acuity outcome. */
export async function findAcuitySourceId(db: SupabaseClient, adAccountId: string): Promise<string | null> {
  const { data, error } = await db
    .from('outcome_sources')
    .select('id')
    .eq('ad_account_id', adAccountId)
    .eq('kind', ACUITY_SOURCE_KIND)
    .eq('label', ACUITY_SOURCE_LABEL)
    .maybeSingle()
  if (error) throw new Error(`Acuity outcome source lookup failed: ${error.message}`)
  return (data as { id?: string } | null)?.id ?? null
}

/** Find or create the account's Acuity source (enabled) and resolve the account currency. */
export async function ensureAcuitySource(db: SupabaseClient, adAccountId: string): Promise<AcuitySource> {
  const { data: account, error: accountError } = await db
    .from('ad_accounts')
    .select('currency')
    .eq('id', adAccountId)
    .maybeSingle()
  if (accountError) throw new Error(`Acuity outcome source: ad account read failed: ${accountError.message}`)
  const currency = String((account as { currency?: unknown } | null)?.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('Acuity outcome source: the ad account has no valid ISO currency.')
  }
  const existing = await findAcuitySourceId(db, adAccountId)
  if (existing) return { sourceId: existing, currency }
  // Created once, enabled. An existing row is never modified here (an owner's later choice stands).
  const { error } = await db
    .from('outcome_sources')
    .upsert(
      { ad_account_id: adAccountId, kind: ACUITY_SOURCE_KIND, label: ACUITY_SOURCE_LABEL, enabled: true },
      { onConflict: 'ad_account_id,kind,label', ignoreDuplicates: true },
    )
  if (error) throw new Error(`Acuity outcome source create failed: ${error.message}`)
  const created = await findAcuitySourceId(db, adAccountId)
  if (!created) throw new Error('Acuity outcome source create failed: no row after insert.')
  return { sourceId: created, currency }
}

/** One recorded Acuity outcome: its uuid and the currency its values are in (the account currency). */
export interface AcuityOutcomeRef {
  id: string
  currency: string
}

/**
 * The outcome recorded for one Acuity appointment, or null when none is recorded. Without an account
 * the lookup spans every Acuity source and must match exactly one row — the Acuity id was the ledger's
 * global primary key before the generic model, and that uniqueness is not assumed away.
 */
export async function findAcuityOutcome(
  db: SupabaseClient,
  acuityAppointmentId: number | string,
  adAccountId?: string | null,
): Promise<AcuityOutcomeRef | null> {
  let sources = db.from('outcome_sources').select('id').eq('kind', ACUITY_SOURCE_KIND)
  if (adAccountId) sources = sources.eq('ad_account_id', adAccountId)
  const { data: sourceRows, error: sourceError } = await sources
  if (sourceError) throw new Error(`Acuity outcome lookup failed: ${sourceError.message}`)
  const sourceIds = ((sourceRows ?? []) as Array<{ id: string }>).map((row) => row.id)
  if (sourceIds.length === 0) return null
  const { data, error } = await db
    .from('outcomes')
    .select('id, currency')
    .in('source_id', sourceIds)
    .eq('external_id', String(acuityAppointmentId))
    .limit(2)
  if (error) throw new Error(`Acuity outcome lookup failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; currency: string }>
  return rows.length === 1 ? { id: rows[0].id, currency: rows[0].currency } : null
}

/** The outcome uuid recorded for one Acuity appointment, or null when none is recorded (see findAcuityOutcome). */
export async function findAcuityOutcomeId(
  db: SupabaseClient,
  acuityAppointmentId: number | string,
  adAccountId?: string | null,
): Promise<string | null> {
  return (await findAcuityOutcome(db, acuityAppointmentId, adAccountId))?.id ?? null
}
