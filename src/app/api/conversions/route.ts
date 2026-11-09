import { createClient } from '@/lib/supabase/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { conversionLabel, conversionCategory, canonicalConversion, type ConversionCategory } from '@/lib/conversions/labels'
import { NextRequest } from 'next/server'
import { ownerOnly } from '@/lib/auth/require-owner'
import {
  activeAccountErrorCode,
  activeAccountErrorStatus,
  resolveOnlyActiveAccount,
} from '@/lib/accounts/active-account'
import { apiErrorResponse } from '@/lib/security/api-error'
import { metaOutcomeEventName } from '@/config/business-config'

// The Meta pixel event that marks an outcome (NEXT_PUBLIC_META_OUTCOME_EVENT).
const EVENT = metaOutcomeEventName()

export const runtime = 'nodejs'

interface MetaAction { action_type?: string; value?: string }

interface ConversionEvent {
  action_type: string
  label: string
  category: ConversionCategory
  count: number
  value: number | null // total conversion value (action_values), null if Meta reports none
  cost: number | null // spend ÷ count (Meta's cost-per-action definition)
}

// GET /api/conversions?from=&to=&level=account
// Surfaces the raw Meta event table (actions / action_values / cost_per_action_type) from
// daily_insights, aggregated across the window. Cost-per-action = total spend ÷ event count.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const forbidden = ownerOnly(user)
  if (forbidden) return forbidden

  const sp = req.nextUrl.searchParams
  const dateStart = sp.get('from') ?? sp.get('date_start')
  const dateEnd = sp.get('to') ?? sp.get('date_end')
  const level = sp.get('level') ?? 'account'
  if (!dateStart || !dateEnd) return Response.json({ error: 'from and to are required' }, { status: 400 })

  const db = getAdminClient()
  const activeAccount = await resolveOnlyActiveAccount(db)
  if (!activeAccount.ok) {
    return Response.json(
      { error: 'Active ad account scope is unavailable', code: activeAccountErrorCode(activeAccount.reason) },
      { status: activeAccountErrorStatus(activeAccount.reason) },
    )
  }
  const { data: rows, error } = await db
    .from('daily_insights')
    .select('spend, actions, action_values, bookings')
    .eq('ad_account_id', activeAccount.account.id)
    .eq('entity_level', level)
    .gte('date_start', dateStart)
    .lte('date_stop', dateEnd)

  if (error) return apiErrorResponse('GET /api/conversions', 'CONVERSIONS_READ_FAILED', error, 500)

  let spend = 0
  // Per-alias window totals (summed across days), then collapsed to a canonical key below.
  const aliasCount = new Map<string, number>()
  const aliasValue = new Map<string, number>()
  let appointmentConfirmed = 0 // authoritative — the STORED `bookings` column (parsed from Meta's results
                               // indicator at sync time; the actions array carries only the generic aggregate)

  for (const r of (rows ?? []) as Array<{ spend: number | null; actions: MetaAction[] | null; action_values: MetaAction[] | null; bookings: number | null }>) {
    spend += Number(r.spend ?? 0)
    appointmentConfirmed += Number(r.bookings ?? 0)
    for (const a of r.actions ?? []) {
      if (!a.action_type) continue
      aliasCount.set(a.action_type, (aliasCount.get(a.action_type) ?? 0) + (parseFloat(a.value ?? '0') || 0))
    }
    for (const a of r.action_values ?? []) {
      if (!a.action_type) continue
      aliasValue.set(a.action_type, (aliasValue.get(a.action_type) ?? 0) + (parseFloat(a.value ?? '0') || 0))
    }
  }

  // Collapse alias action_types for the SAME conversion into one canonical row. Aliases carry an IDENTICAL
  // count, so take the MAX across them (summing double-counts); same for value.
  interface Agg { action_type: string; label: string; count: number; value: number }
  const byKey = new Map<string, Agg>()
  const bump = (key: string, action_type: string, label: string, count: number, value: number) => {
    const cur = byKey.get(key)
    if (!cur) { byKey.set(key, { action_type, label, count, value }); return }
    // MAX-dedup by COUNT — and carry the VALUE from the max-count alias (independent maxes would pair a
    // count from one alias with a value from another, producing a nonsense implied AOV).
    if (count > cur.count || (count === cur.count && value > cur.value)) {
      cur.count = count
      cur.value = value
      cur.action_type = action_type
    }
  }
  for (const [action_type, count] of aliasCount) {
    const value = aliasValue.get(action_type) ?? 0
    const canon = canonicalConversion(action_type)
    if (canon) bump(canon.key, action_type, canon.label, count, value)
    else bump(action_type, action_type, conversionLabel(action_type), count, value) // non-family: its own row
  }
  // AppointmentConfirmed is this account's primary conversion — surface it authoritatively from `results`
  // (the actions array carries only the generic custom aggregate, not the named event). Overrides any
  // actions-derived appointment_confirmed count.
  if (appointmentConfirmed > 0) {
    byKey.set('appointment_confirmed', {
      action_type: `offsite_conversion.fb_pixel_custom.${EVENT}`,
      label: EVENT,
      count: appointmentConfirmed,
      value: byKey.get('appointment_confirmed')?.value ?? 0,
    })
  }

  const events: ConversionEvent[] = [...byKey.values()].map((a) => ({
    action_type: a.action_type,
    label: a.label,
    category: conversionCategory(a.action_type),
    count: Math.round(a.count),
    value: a.value > 0 ? Math.round(a.value * 100) / 100 : null,
    cost: a.count > 0 ? Math.round((spend / a.count) * 100) / 100 : null,
  }))

  events.sort((a, b) => b.count - a.count)

  return Response.json({ events, spend, total: events.length, level })
}
