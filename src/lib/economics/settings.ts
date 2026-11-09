import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount, type ActiveAccountResolution } from '@/lib/accounts/active-account'
import type { EconomicsInputs } from './model'

// Manual economics inputs predate durable owner-approval/version provenance. Preserve valid rows, but
// never turn an absent, unreadable, or malformed row into a commercial assumption. Unknown stays
// unknown, and every consumer receives the same explicit read-health contract.

const ECONOMICS_KEY = 'economics_inputs'

export type EconomicsInputsUnavailableReasonCode =
  | 'account_not_found'
  | 'account_ambiguous'
  | 'account_unavailable'
  | 'settings_read_failed'
  | 'not_configured'
  | 'invalid_json'
  | 'invalid_values'

export interface EconomicsInputsProvenance {
  source: 'app_settings.economics_inputs'
  status: 'unversioned_app_setting'
  updated_at: string | null
  owner_approval_recorded: false
  version_recorded: false
}

export type EconomicsInputsRead =
  | {
      status: 'available'
      inputs: EconomicsInputs
      reason_code: null
      unavailable_reason: null
      provenance: EconomicsInputsProvenance
    }
  | {
      status: 'unavailable'
      inputs: null
      reason_code: EconomicsInputsUnavailableReasonCode
      unavailable_reason: string
      provenance: null
    }

export type PrepareEconomicsInputsResult =
  | { ok: true; inputs: EconomicsInputs }
  | { ok: false; error_code: 'aov_required' | 'source_note_required' | 'invalid_values'; error: string }

export interface SaveEconomicsInputsResult {
  ok: boolean
  error_code?:
    | 'account_not_found'
    | 'account_ambiguous'
    | 'account_unavailable'
    | 'settings_read_failed'
    | 'aov_required'
    | 'source_note_required'
    | 'invalid_values'
    | 'write_failed'
  error?: string
}

type AccountUnavailableReasonCode = 'account_not_found' | 'account_ambiguous' | 'account_unavailable'

function accountResolutionFailure(
  resolution: Exclude<ActiveAccountResolution, { ok: true }>
): { reason_code: AccountUnavailableReasonCode; unavailable_reason: string } {
  if (resolution.reason === 'not_found') {
    return { reason_code: 'account_not_found', unavailable_reason: 'No active ad account is configured.' }
  }
  if (resolution.reason === 'ambiguous') {
    return {
      reason_code: 'account_ambiguous',
      unavailable_reason: 'More than one active ad account is configured; ownership is ambiguous.',
    }
  }
  return { reason_code: 'account_unavailable', unavailable_reason: 'The active ad account could not be resolved.' }
}

function accountUnavailable(resolution: Exclude<ActiveAccountResolution, { ok: true }>): EconomicsInputsRead {
  const failure = accountResolutionFailure(resolution)
  return unavailable(failure.reason_code, failure.unavailable_reason)
}

function isNullableRate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
}

function validateEconomicsInputs(value: unknown): value is EconomicsInputs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.aov === 'number' &&
    Number.isFinite(candidate.aov) &&
    candidate.aov > 0 &&
    isNullableRate(candidate.gross_margin_rate) &&
    isNullableRate(candidate.repeat_rate) &&
    typeof candidate.source_note === 'string' &&
    candidate.source_note.trim().length > 0 &&
    candidate.source_note.length <= 500
  )
}

function parseStoredValue(value: unknown):
  | { ok: true; inputs: EconomicsInputs }
  | { ok: false; reason_code: 'invalid_json' | 'invalid_values'; error: string } {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return { ok: false, reason_code: 'invalid_json', error: 'The stored economics input is not valid JSON.' }
    }
  }

  if (!validateEconomicsInputs(parsed)) {
    return {
      ok: false,
      reason_code: 'invalid_values',
      error: 'The stored economics input is incomplete or contains values outside the accepted ranges.',
    }
  }
  return { ok: true, inputs: { ...parsed } }
}

function unavailable(
  reason_code: EconomicsInputsUnavailableReasonCode,
  unavailable_reason: string
): EconomicsInputsRead {
  return { status: 'unavailable', inputs: null, reason_code, unavailable_reason, provenance: null }
}

export function prepareEconomicsInputsUpdate(
  existing: EconomicsInputs | null,
  update: Partial<EconomicsInputs>
): PrepareEconomicsInputsResult {
  const aov = update.aov ?? existing?.aov
  if (aov === undefined) {
    return { ok: false, error_code: 'aov_required', error: 'A positive AOV is required for the first economics input.' }
  }

  const hasMargin = Object.prototype.hasOwnProperty.call(update, 'gross_margin_rate')
  const hasRepeat = Object.prototype.hasOwnProperty.call(update, 'repeat_rate')
  const hasSourceNote = Object.prototype.hasOwnProperty.call(update, 'source_note')
  if (!existing && (!hasSourceNote || typeof update.source_note !== 'string' || update.source_note.trim().length === 0)) {
    return {
      ok: false,
      error_code: 'source_note_required',
      error: 'A non-empty source note is required for the first economics input.',
    }
  }
  const sourceNote = hasSourceNote
    ? update.source_note
    : existing?.source_note

  const candidate: unknown = {
    aov,
    gross_margin_rate: hasMargin ? update.gross_margin_rate : existing?.gross_margin_rate ?? null,
    repeat_rate: hasRepeat ? update.repeat_rate : existing?.repeat_rate ?? null,
    source_note: typeof sourceNote === 'string' ? sourceNote.trim() : sourceNote,
  }

  if (!validateEconomicsInputs(candidate)) {
    return {
      ok: false,
      error_code: 'invalid_values',
      error: 'Economics inputs must include a positive AOV, optional rates from 0 to 1, and a non-empty source note.',
    }
  }
  return { ok: true, inputs: candidate }
}

export async function loadEconomicsInputs(): Promise<EconomicsInputsRead> {
  try {
    const db = getAdminClient()
    const account = await resolveOnlyActiveAccount(db)
    if (!account.ok) return accountUnavailable(account)

    const { data, error } = await db
      .from('app_settings')
      .select('value, updated_at')
      .eq('ad_account_id', account.account.id)
      .eq('key', ECONOMICS_KEY)
      .maybeSingle()

    if (error) return unavailable('settings_read_failed', `Economics settings read failed: ${error.message}`)
    if (data?.value === undefined || data?.value === null || data.value === '') {
      return unavailable('not_configured', 'Economics inputs have not been configured.')
    }

    const parsed = parseStoredValue(data.value)
    if (!parsed.ok) return unavailable(parsed.reason_code, parsed.error)

    return {
      status: 'available',
      inputs: parsed.inputs,
      reason_code: null,
      unavailable_reason: null,
      provenance: {
        source: 'app_settings.economics_inputs',
        status: 'unversioned_app_setting',
        updated_at: typeof data.updated_at === 'string' ? data.updated_at : null,
        owner_approval_recorded: false,
        version_recorded: false,
      },
    }
  } catch (error) {
    return unavailable(
      'settings_read_failed',
      `Economics settings read failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export async function saveEconomicsInputs(inputs: Partial<EconomicsInputs>): Promise<SaveEconomicsInputsResult> {
  try {
    const db = getAdminClient()
    const account = await resolveOnlyActiveAccount(db)
    if (!account.ok) {
      const unavailableRead = accountResolutionFailure(account)
      return {
        ok: false,
        error_code: unavailableRead.reason_code,
        error: unavailableRead.unavailable_reason,
      }
    }

    const { data: current, error: readError } = await db
      .from('app_settings')
      .select('value')
      .eq('ad_account_id', account.account.id)
      .eq('key', ECONOMICS_KEY)
      .maybeSingle()
    if (readError) return { ok: false, error_code: 'settings_read_failed', error: readError.message }

    let existing: EconomicsInputs | null = null
    if (current?.value !== undefined && current?.value !== null && current.value !== '') {
      const parsed = parseStoredValue(current.value)
      if (!parsed.ok) return { ok: false, error_code: 'invalid_values', error: parsed.error }
      existing = parsed.inputs
    }

    const prepared = prepareEconomicsInputsUpdate(existing, inputs)
    if (!prepared.ok) return prepared

    const { error } = await db.from('app_settings').upsert(
      {
        ad_account_id: account.account.id,
        key: ECONOMICS_KEY,
        value: JSON.stringify(prepared.inputs),
        setting_type: 'json',
        label: 'Economics Inputs',
        description: 'Manual economics inputs. Immutable owner approval and version provenance are not recorded.',
      },
      { onConflict: 'ad_account_id,key' }
    )
    return error ? { ok: false, error_code: 'write_failed', error: error.message } : { ok: true }
  } catch (error) {
    return {
      ok: false,
      error_code: 'write_failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
