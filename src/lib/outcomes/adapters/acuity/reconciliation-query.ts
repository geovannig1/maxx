import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdminClient } from '@/lib/supabase/admin'
import {
  reconcileAppointment, summarizeReconciliation, renderReconciliationBlock,
  type AppointmentReconciliationInput, type ObservationEvidence, type ReconciliationSummary,
} from './value-reconciliation'

// The PRODUCTION query behind the VALUE RECONCILIATION block.
//
// value-reconciliation.ts had ZERO callers: the resolver existed, its tests passed, and the daily
// report never reached it — so the report still had no row-level basis for calling any difference
// "expected". This module reads the three tables the resolver needs (appointments, observation
// lineage, CAPI deliveries) for the report window and produces the deterministic block.
//
// PII: selects ids, scalars and timestamps ONLY. No name, email, phone or raw payload.

export interface ReconciliationBlock {
  summary: ReconciliationSummary
  lines: string[]
  /** Non-fatal read problems. A failed read yields an UNKNOWN block, never a permissive one. */
  warnings: string[]
  /** Bookings excluded because they were never CAPI-eligible (staff-created / origin unknown). */
  ineligible: number
}

export async function buildReconciliationBlock(
  adAccountDbId: string,
  since: string,
  until: string,
  supabase?: SupabaseClient,
): Promise<ReconciliationBlock> {
  const db = supabase ?? getAdminClient()
  const warnings: string[] = []

  // ACCOUNT-SCOPED. The ledger is account-agnostic by table design, so an unscoped read reconciled
  // every account's bookings into this account's report.
  // `scheduled_by` distinguishes a CAPI-eligible website booking from a staff/manual one: the sender's
  // R4 origin gate only sends when scheduledBy is EXPLICITLY null. A staff-created or origin-unknown
  // booking was never supposed to produce a delivery, so counting it as a delivery FAILURE
  // manufactures a problem that does not exist.
  // `id` is the outcome uuid (the join key to observations and deliveries); `external_id` is the Acuity
  // appointment id the reconciliation rows are reported under. `origin = 'staff_or_manual'` is exactly
  // the old `scheduled_by IS NOT NULL`.
  let appts: Array<{
    id: string; external_id: string; initial_provenance: string | null; status: string
    origin: string | null; conversion_send_error: string | null
    origin_observed_at: string | null; origin_observed_source: string | null
  }> = []
  try {
    const { data, error } = await db
      .from('outcomes')
      .select('id, external_id, initial_provenance, status, origin, conversion_send_error, origin_observed_at, origin_observed_source')
      .eq('ad_account_id', adAccountDbId)
      .gte('business_date', since)
      .lte('business_date', until)
    if (error) throw new Error(error.message)
    appts = (data ?? []) as typeof appts
  } catch (e) {
    warnings.push(`appointment read failed (${msg(e)}) — reconciliation unavailable for this window`)
    return { summary: summarizeReconciliation([]), lines: unavailableLines(warnings), warnings, ineligible: 0 }
  }

  if (appts.length === 0) {
    return { summary: summarizeReconciliation([]), lines: renderReconciliationBlock(summarizeReconciliation([])), warnings, ineligible: 0 }
  }

  // ORIGIN CLASSIFICATION. `scheduled_by = null` is AMBIGUOUS: it means either "explicitly
  // client-booked" (a by-id fetch that returned scheduledBy: null) or "the list-shaped payload never
  // carried scheduledBy at all". The sender distinguishes them — its R4 gate skips the second case
  // with capi_send_error = 'origin_unknown' — so reconciliation must too, instead of quietly
  // treating every null as an eligible client booking while claiming origin-unknown rows were
  // excluded.
  //
  //   staff_created   -> scheduled_by set, or the sender recorded that skip  -> INELIGIBLE
  //   origin_unknown  -> the sender recorded that skip                       -> INELIGIBLE (unknown)
  //   client-booked   -> null origin AND observed by a by-id path (webhook)  -> ELIGIBLE
  const classify = (a: typeof appts[number]): 'eligible' | 'staff' | 'origin_unknown' => {
    if (a.conversion_send_error === 'staff_created') return 'staff'
    if (a.conversion_send_error === 'origin_unknown') return 'origin_unknown'
    if (a.origin === 'staff_or_manual') return 'staff'
    // A null origin only PROVES a client booking when a by-id payload actually OBSERVED the
    // scheduledBy key. origin_observed_at is durable: only a by-id WRITER may set it (enforced by
    // ORIGIN_OBSERVING_SOURCES in ledger.ts, not by the payload's shape) and no list-shaped writer
    // clears it, so an eligible booking stays eligible after the nightly re-upsert.
    return a.origin_observed_at !== null ? 'eligible' : 'origin_unknown'
  }
  const classified = appts.map((a) => ({ a, k: classify(a) }))
  const eligible = classified.filter((x) => x.k === 'eligible').map((x) => x.a)
  const staffCount = classified.filter((x) => x.k === 'staff').length
  const originUnknownCount = classified.filter((x) => x.k === 'origin_unknown').length
  const ineligible = staffCount + originUnknownCount
  const ids = eligible.map((a) => a.id)
  if (ids.length === 0) {
    const s0 = summarizeReconciliation([])
    return {
      summary: s0,
      lines: [
        ...renderReconciliationBlock(s0).slice(0, -1),
        `  ${ineligible} booking(s) in range are NOT CAPI-eligible — ${staffCount} staff-created, ${originUnknownCount} origin UNKNOWN (never observed through a by-id path). Excluded, not a delivery failure. The origin-unknown group is UNRESOLVED, not proven ineligible.`,
        '',
      ],
      warnings,
      ineligible,
    }
  }

  // Observation lineage (`outcome_observations`). No PII in this table by construction.
  const obsByAppt = new Map<string, ObservationEvidence[]>()
  try {
    const { data, error } = await db
      .from('outcome_observations')
      .select('outcome_id, change_kind, observed_at, old_gross_value, new_gross_value, old_cancelled, new_cancelled')
      .in('outcome_id', ids)
    if (error) throw new Error(error.message)
    for (const o of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(o.outcome_id)
      obsByAppt.set(key, [...(obsByAppt.get(key) ?? []), {
        changeKind: String(o.change_kind),
        observedAtMs: Date.parse(String(o.observed_at)),
        oldPrice: o.old_gross_value === null ? null : Number(o.old_gross_value),
        newPrice: o.new_gross_value === null ? null : Number(o.new_gross_value),
        oldCanceled: o.old_cancelled === null ? null : Boolean(o.old_cancelled),
        newCanceled: o.new_cancelled === null ? null : Boolean(o.new_cancelled),
      }])
    }
  } catch (e) {
    // Lineage unavailable => every row resolves 'unknown_no_lineage'. That is the honest state.
    warnings.push(`observation lineage read failed (${msg(e)}) — every row resolves to unknown lineage`)
  }

  // CAPI delivery lineage (`conversion_deliveries`).
  const acceptedAt = new Map<string, number | null>()
  const attempted = new Set<string>()
  try {
    const { data, error } = await db
      .from('conversion_deliveries')
      // LIVE acceptance only (`live_accepted_at`). A test-mode rehearsal is not a delivery, and treating
      // one as a delivery would let a quarantined event "prove" a post-send value change.
      .select('outcome_id, live_accepted_at')
      .in('outcome_id', ids)
    if (error) throw new Error(error.message)
    for (const d of (data ?? []) as Array<{ outcome_id: string; live_accepted_at: string | null }>) {
      attempted.add(String(d.outcome_id))
      acceptedAt.set(String(d.outcome_id), d.live_accepted_at ? Date.parse(d.live_accepted_at) : null)
    }
  } catch (e) {
    warnings.push(`CAPI delivery read failed (${msg(e)}) — delivery treated as UNCONFIRMED (fail closed)`)
  }

  const rows = eligible.map((a) => {
    const input: AppointmentReconciliationInput = {
      appointmentId: Number(a.external_id),
      initialProvenance: (a.initial_provenance as 'observed' | 'migration_snapshot' | null) ?? null,
      observations: obsByAppt.get(a.id) ?? [],
      capiAcceptedAtMs: acceptedAt.get(a.id) ?? null,
      capiAttempted: attempted.has(a.id),
      // NOT EVALUATED. Per-row modelled linkage does not exist — Meta attributes at entity level, not
      // per appointment — so no row can be shown to disagree. Rendering it as `false` would let the
      // block print "0 modelled disagreements" as though zero had been measured. The renderer prints
      // this state as UNAVAILABLE instead (see renderReconciliationBlock's modeledEvaluated flag).
      modeledDiffers: false,
    }
    return reconcileAppointment(input)
  })

  const summary = summarizeReconciliation(rows)
  const lines = renderReconciliationBlock(summary, { modeledEvaluated: false })
  if (ineligible > 0) {
    lines.splice(lines.length - 1, 0,
      `  ${ineligible} booking(s) in range are NOT CAPI-eligible — ${staffCount} staff-created (intentionally not sent, NOT a delivery failure) and ${originUnknownCount} with UNKNOWN origin (never observed through a by-id path, so eligibility itself is unresolved). Both are excluded from the delivery states above.`)
  }
  if (warnings.length > 0) {
    lines.splice(lines.length - 1, 0, ...warnings.map((w) => `  READ WARNING: ${w}`))
  }
  return { summary, lines, warnings, ineligible }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function unavailableLines(warnings: string[]): string[] {
  return [
    '=== VALUE RECONCILIATION ===',
    '  UNAVAILABLE for this window — the row-level evidence could not be read.',
    ...warnings.map((w) => `  ${w}`),
    '  RULE: with no row-level evidence, NO part of any value difference may be called expected.',
    '',
  ]
}
