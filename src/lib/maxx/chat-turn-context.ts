import 'server-only'
import { nyDaysAgo, nyToday } from '@/lib/utils/date-utils'
import { getAdminClient } from '@/lib/supabase/admin'
import { resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { readLatestClosedAccountDeliveryDate } from '@/lib/accounts/closed-delivery-date'
import {
  parsePersistedFinalActionDecisionEvidence,
  type PersistedFinalActionDecisionEvidence,
} from '@/lib/maxx/answer-brief'
import { accountTimezone } from '@/config/business-config'

const FINAL_ACTION_DECISION_TOOLS = new Set(['get_recommendations'])

export function persistedFinalActionDecisionsFromToolResult(
  tool: string,
  result: unknown,
): PersistedFinalActionDecisionEvidence[] {
  if (!FINAL_ACTION_DECISION_TOOLS.has(tool)) return []
  if (!result || typeof result !== 'object' || Array.isArray(result)) return []
  try {
    return parsePersistedFinalActionDecisionEvidence(
      (result as Record<string, unknown>).persisted_final_action_decisions,
    )
  } catch {
    return []
  }
}

/**
 * Tell the model what day it is, in the account's timezone.
 *
 * Nothing did. `MAXX_CHAT_SYSTEM` mentions "today" only semantically (`includes_today`), and no date
 * was injected at call time, so the model fell back to its training era. Observed against production:
 * asked "how much did I spend this month", it called get_performance_cockpit with
 * `{"start_date":"2025-07-01","end_date":"2025-07-24"}` — thirteen months stale. `resolveClosedDateRange`
 * then threw "start_date cannot be older than 90 days", the tool loop's catch converted that into
 * "A governed account lookup failed", and the whole answer was withheld.
 *
 * Every date-scoped question was affected, which is nearly all of them. Verified present on the
 * pushed baseline b11c7b0 as well, so this predates the current branch's work.
 *
 * The 90-day floor is stated too: the model cannot honour a bound it has not been told, and being
 * refused for asking is the failure being fixed.
 */
/**
 * The last day the WAREHOUSE actually holds, which is not the same as the last calendar day.
 *
 * `daily_insights` is written by the sync, so on any day before the sync has run, yesterday exists on
 * the calendar and not in the warehouse. `readMetaDelivery` refuses a window containing such a day —
 * every claim comes back unavailable with `meta_account_spend_day_missing:<date>` — which is correct
 * behaviour and exactly what a caller told "data is closed through yesterday" will walk into.
 *
 * For example, before a day's sync has run: a window ending two days ago returns most claims
 * available, while the same window extended to yesterday returns ZERO available. A model told the
 * month ran through yesterday requests that window, gets nothing citable, and fell back to prose that was then withheld. Every
 * date-scoped question fails that way for the hours between midnight and the sync.
 *
 * A manual sync can write a partial row for today, so the latest eligible row is capped at New York
 * yesterday before it is called closed. Null on any read failure — the caller then omits the
 * assertion rather than substituting the calendar, because asserting a boundary we cannot prove is
 * the defect itself.
 */
export async function warehouseClosedThrough(): Promise<string | null> {
  try {
    const db = getAdminClient()
    const account = await resolveOnlyActiveAccount(db)
    if (!account.ok) return null
    return readLatestClosedAccountDeliveryDate(account.account.id, db)
  } catch {
    return null
  }
}

export function todayContext(closedThrough: string | null): string {
  const today = nyToday()
  const earliest = nyDaysAgo(90)
  const head = `TODAY IS ${today} in ${accountTimezone()}, the account timezone. Derive every date range `
    + 'from this date and never from prior knowledge. Governed lookups accept a start_date no earlier '
    + `than ${earliest} (90 days). `
  if (closedThrough === null) {
    // Say what is unknown instead of guessing it. A wrong boundary is worse than an absent one: it
    // sends the model at a window every claim will refuse.
    return `${head}The last fully-synced day could not be determined, so do not assume one — read the `
      + 'window each tool reports back and narrow your request if it reports a day missing.'
  }
  const monthStart = `${today.slice(0, 7)}-01`
  // On the 1st, and on any day before the month's first sync, `monthStart` can exceed the last synced
  // day. `resolveClosedDateRange` does not reject that — it CLAMPS start down and returns a single
  // day — so the prompt has to refuse the framing rather than describe an inverted window.
  const thisMonth = monthStart > closedThrough
    ? `"This month" has NO fully-synced days yet — say so rather than querying it. The most recent `
      + `synced day is ${closedThrough}.`
    : `"this month" means ${monthStart} through ${closedThrough}.`
  return `${head}Data is synced and closed through ${closedThrough} — never request a later date, `
    + `even if the calendar has moved past it. ${thisMonth}`
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Say that the GAP is ours, and name it.
 *
 * A governed answer must cite a MetricClaim. The server-owned audit gather normally supplies the
 * question's required claims before the model loop; independently requested claim-emitting tools
 * can add more. If both paths yield none, that is our evidence-read failure rather than proof of an
 * empty account or a model-format failure, and the owner needs that distinction stated plainly.
 */
export function noClaimSupplyMessage(toolsUsed: string[]): string {
  const consulted = [...new Set(toolsUsed)]
  const checked = consulted.length > 0
    ? `I checked ${consulted.map((tool) => tool.replaceAll('_', ' ')).join(', ')}`
    : 'No account lookup ran'
  return `${checked}, but the server produced no citable governed claim from those reads this time. `
    + 'The answer was withheld because this is an internal evidence failure, not proof that the '
    + 'account has zero activity or that the source data does not exist. The governed data pages '
    + 'remain available while the failed evidence read is investigated.'
}
