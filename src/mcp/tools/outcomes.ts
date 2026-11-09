import { roundMoney } from '@/lib/utils/format-currency'
import { logToolError } from '@/lib/security/api-error'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { getAdminClient } from '@/lib/supabase/admin'
import { groupOutcomeFacts, readOutcomeFacts, type OutcomeFactsRead } from '@/lib/outcomes/reader'
import type { OutcomeFacts } from '@/lib/outcomes/facts'
import { knownOutcomeReadCode } from '@/lib/outcomes/aggregation'
import { nyDaysAgo, nyToday } from '@/lib/utils/date-utils'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Business outcomes for the MCP surface: every enabled outcome source of the active account, in
// outcome vocabulary, with the per-source aggregation rules of src/lib/outcomes/aggregation.ts.

type Args = { start_date?: string; end_date?: string }

// Money at the account currency's minor unit (JPY 0 decimals, USD 2, KWD 3).
const round = (n: number) => roundMoney(n)
const roundNullable = (n: number | null) => (n === null ? null : round(n))


function facts(f: OutcomeFacts) {
  return {
    active_outcomes: f.activeOutcomes,
    value_bearing_outcomes: f.valueBearingOutcomes,
    zero_value_outcomes: f.zeroValueOutcomes,
    cancelled_outcomes: f.cancelledOutcomes,
    gross_value: round(f.grossValue),
    observed_collected_value_lower_bound: round(f.observedCollectedValue),
    collected_value: roundNullable(f.collectedValue),
    collected_value_coverage: { with_recorded_value: f.collectedValueCoverage.withRecordedValue, total: f.collectedValueCoverage.total },
  }
}

const VOCABULARY = 'VOCABULARY: active outcomes = value-bearing AND zero-value outcomes that are not cancelled or refunded. '
  + 'Value-bearing outcomes carry a gross value > 0; zero-value outcomes are REAL results that charged nothing (never call one a test). '
  + 'gross_value = scheduled/listed value. collected_value = value the source recorded as collected, NULL unless every active outcome '
  + 'recorded one; observed_collected_value_lower_bound is diagnostic only and never a MER/ROAS numerator. Totals span every enabled '
  + 'outcome source (paid + organic + manual) and are a DIFFERENT population from GA telemetry or Meta modelled attribution.'

async function read(toolName: string, args: Args): Promise<{ period: { start: string; end: string } } & (
  { ok: true; read: OutcomeFactsRead } | { ok: false; response: object })> {
  const period = { start: args.start_date ?? nyDaysAgo(30), end: args.end_date ?? nyToday() }
  const active = await resolveOnlyActiveAccount()
  if (!active.ok) {
    return { period, ok: false, response: { period, error_code: 'no_active_account', unavailable_reason: 'No single active ad account. UNAVAILABLE, not zero.' } }
  }
  try {
    return { period, ok: true, read: await readOutcomeFacts(getAdminClient(), active.account.id, period.start, period.end) }
  } catch (error) {
    // Known domain reasons pass through; anything else is reduced to one stable, logged code.
    const code = knownOutcomeReadCode(error) ?? logToolError(toolName, 'OUTCOME_READ_FAILED', error)
    return { period, ok: false, response: { period, error_code: code, unavailable_reason: `Business outcomes could not be read (${code}). UNAVAILABLE, not zero.` } }
  }
}

export async function getOutcomes(args: Args): Promise<object> {
  const result = await read('get_outcomes', args)
  if (!result.ok) return result.response
  const { read: r, period } = { read: result.read, period: result.period }
  const byDay = groupOutcomeFacts(r.rows, (row) => row.businessDate)
  return {
    period,
    currency: r.currency,
    ...facts(r.facts),
    sources: r.bySource.map((s) => ({ source_id: s.sourceId, kind: s.kind, outcomes: s.outcomes })),
    completeness: r.health.sources.map((s) => ({ source_id: s.sourceId, kind: s.kind, completeness: s.completeness })),
    by_day: [...byDay.keys()].sort().map((date) => ({ date, ...facts(byDay.get(date)!) })),
    note: VOCABULARY,
  }
}

export async function getOutcomesByLabel(args: Args): Promise<object> {
  const result = await read('get_outcomes_by_label', args)
  if (!result.ok) return result.response
  const byLabel = groupOutcomeFacts(result.read.rows, (row) => row.label ?? '(unlabelled)')
  return {
    period: result.period,
    currency: result.read.currency,
    totals: facts(result.read.facts),
    rows: [...byLabel.entries()]
      .map(([label, f]) => ({ label, ...facts(f) }))
      .sort((a, b) => b.gross_value - a.gross_value || b.value_bearing_outcomes - a.value_bearing_outcomes || a.label.localeCompare(b.label)),
    note: `By outcome label (product, service or ${OW.one} type). ${VOCABULARY}`,
  }
}

/** Deprecated alias (one release): the former get_bookings_by_type answers with get_outcomes_by_label. */
export async function getBookingsByTypeDeprecated(args: Args): Promise<object> {
  return { ...(await getOutcomesByLabel(args)), deprecated: 'get_bookings_by_type is deprecated; use get_outcomes_by_label.' }
}
