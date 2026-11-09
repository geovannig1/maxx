// Pure Meta action/result/value readers for the outcome event, split out of insight-outcomes.ts so each
// module stays cohesive. Client-safe like its parent; insight-outcomes.ts re-exports the public surface.
import type { MetaInsightAction, MetaInsightRow } from '@/types/meta-api'
import { DEFAULT_META_OUTCOME_EVENT, metaOutcomeConversionId, metaOutcomeEventName } from '@/config/business-config'

export const COUNT_TOLERANCE = 0.5

function parseOutcomeNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** MAX across matching action types, for a conversion FAMILY.
 *
 *  Meta reports one conversion under many alias action_types carrying an IDENTICAL figure — a single
 *  booking can arrive as purchase, omni_purchase, onsite_web_purchase and
 *  offsite_conversion.fb_pixel_purchase all at once. Summing a family multiplies the money by the
 *  number of aliases Meta happened to send. The repo's existing rule for this (see
 *  lib/conversions/labels.ts) is MAX across aliases, never the sum; an alias can also arrive as a
 *  near-zero straggler beside the others, which is why MAX also beats picking a single alias by name. */
function normalizedActionMax(
  actions: MetaInsightRow['actions'],
  matches: (type: string) => boolean,
): { value: number; valid: boolean; matched: boolean } {
  let value = 0
  let matched = false
  for (const action of actions ?? []) {
    if (!matches(action.action_type ?? '')) continue
    matched = true
    const parsed = parseOutcomeNumber(action.value)
    if (parsed === null) return { value: 0, valid: false, matched: true }
    if (parsed > value) value = parsed
  }
  return { value, valid: true, matched }
}

export function normalizedActionSum(
  actions: MetaInsightRow['actions'],
  matches: (type: string) => boolean,
): { value: number; valid: boolean; matched: boolean } {
  let value = 0
  let matched = false
  for (const action of actions ?? []) {
    if (!matches(action.action_type ?? '')) continue
    matched = true
    const parsed = parseOutcomeNumber(action.value)
    if (parsed === null) return { value: 0, valid: false, matched: true }
    value += parsed
  }
  return { value, valid: true, matched }
}

export function findActionValue(
  actions: MetaInsightRow['actions'],
  ...types: string[]
): number {
  if (!Array.isArray(actions)) return 0
  for (const action of actions) {
    if (types.includes(action.action_type ?? '')) {
      return parseFloat(action.value ?? '0') || 0
    }
  }
  return 0
}

/** Preserve the evidence boundary between "Meta supplied an actions array and this metric was zero"
 * and "Meta did not supply the actions plane". Paid-cohort completeness depends on that distinction. */
export function findActionValueOrNull(
  actions: MetaInsightRow['actions'],
  ...types: string[]
): number | null {
  return Array.isArray(actions) ? findActionValue(actions, ...types) : null
}

// Optional numeric id of the custom conversion that represents an outcome (configuration,
// src/config/business-config.ts). When set, action types ending in that id count as the outcome event
// in addition to the named event.
const OUTCOME_CONVERSION_ID = metaOutcomeConversionId()
// the Meta outcome event is configuration (NEXT_PUBLIC_META_OUTCOME_EVENT, default AppointmentConfirmed).
const OUTCOME_EVENT = metaOutcomeEventName()

/** PURE. Whether a Meta action type or Results indicator names the configured outcome event. The default
 *  keeps its original substring match exactly; another configured name must end the type as a whole token
 *  (`fb_pixel_purchase`, `fb_pixel_custom.Purchase`), so `Lead` never matches `lead_grouped`. */
export function namesOutcomeEvent(actionType: string, eventName: string = OUTCOME_EVENT): boolean {
  const t = (actionType ?? '').toLowerCase()
  const event = eventName.toLowerCase()
  if (eventName === DEFAULT_META_OUTCOME_EVENT) return t.includes(event)
  return t === event || t.endsWith(`.${event}`) || t.endsWith(`:${event}`) || t.endsWith(`_${event}`)
}

// Match ONLY the AppointmentConfirmed custom event, in whatever prefix form Meta returns
// (offsite_conversion.fb_pixel_custom.AppointmentConfirmed | offsite_conversion.custom.AppointmentConfirmed
//  | offsite_conversion.custom.<id>). Deliberately EXCLUDES the bare 'offsite_conversion.fb_pixel_custom'
// aggregate (which sums ALL custom pixel events) and other events (Schedule, Purchase, custom click events, etc.).
// NOTE: verify against the raw /insights actions array on the next sync — booking counts must still match
// Meta Ads Manager.
function isAppointmentConfirmedType(actionType: string, extraConversionId?: string): boolean {
  const t = (actionType ?? '').toLowerCase()
  return (
    namesOutcomeEvent(t) ||
    (OUTCOME_CONVERSION_ID !== '' && t.includes(OUTCOME_CONVERSION_ID)) ||
    (!!extraConversionId && t.includes(extraConversionId.toLowerCase()))
  )
}

/** Ads Manager "Results" column: count the indicators naming AppointmentConfirmed
 *  (e.g. "conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed"). Indicators for other
 *  optimization goals (landing_page_view, leads, …) are ignored — this must count bookings only.
 *
 *  ATTRIBUTION-WINDOW DEDUP (the per-window double-count): the sync requests
 *  action_attribution_windows=['7d_click','1d_view'], and with that param Meta returns the SAME
 *  conversions per indicator as per-window entries (['1d_view'], ['7d_click']) PLUS a ['default']
 *  TOTAL of those same events — e.g. a 1-booking day comes back as
 *  [{value:'1',attribution_windows:['1d_view']},{value:'1',attribution_windows:['default']}].
 *  Summing every entry counted each booking twice (warehouse 14 vs Ads Manager 7). Per indicator:
 *  the 'default' entry IS the Ads Manager number. Per-window entries are attribution diagnostics;
 *  they are never promoted to the result total when `default` is absent. */
export interface AppointmentConfirmedResultRead {
  value: number
  matched: boolean
  valid: boolean
  clickBookings: number
  viewBookings: number
  splitAvailable: boolean
  splitComplete: boolean
}

/** Canonical AppointmentConfirmed Results reader. Repeated indicator aliases are the same logical
 * conversion, so MAX is used rather than summing them. A values-less indicator is Meta's explicit
 * zero shape; a populated values list without `default` is diagnostic-only and therefore unavailable. */
export function readAppointmentConfirmedResult(
  results: MetaInsightRow['results'],
): AppointmentConfirmedResultRead {
  let selected: AppointmentConfirmedResultRead | null = null
  let valid = true
  for (const result of results ?? []) {
    if (!namesOutcomeEvent(result?.indicator ?? '')) continue
    const rawValues = result?.values
    if (rawValues === undefined || rawValues === null) {
      const zero = {
        value: 0, matched: true, valid: true, clickBookings: 0, viewBookings: 0,
        splitAvailable: false, splitComplete: true,
      }
      if (!selected) selected = zero
      continue
    }
    if (!Array.isArray(rawValues)) {
      valid = false
      continue
    }
    const defaults = rawValues.filter((entry) =>
      (entry?.attribution_windows ?? []).includes('default'),
    )
    if (defaults.length !== 1) {
      valid = false
      continue
    }
    const value = parseOutcomeNumber(defaults[0]?.value)
    if (value === null) {
      valid = false
      continue
    }

    let clickBookings = 0
    let viewBookings = 0
    let sawClick = false
    let sawView = false
    let candidateValid = true
    for (const entry of rawValues) {
      const windows = entry?.attribution_windows ?? []
      if (windows.includes('default')) continue
      const parsed = parseOutcomeNumber(entry?.value)
      if (parsed === null) {
        candidateValid = false
        continue
      }
      if (windows.includes('7d_click')) {
        clickBookings += parsed
        sawClick = true
      }
      if (windows.includes('1d_view')) {
        viewBookings += parsed
        sawView = true
      }
    }
    const splitAvailable = sawClick || sawView
    if (value > 0 && splitAvailable) {
      if (!sawClick) clickBookings = value - viewBookings
      if (!sawView) viewBookings = value - clickBookings
      if (clickBookings < 0 || viewBookings < 0) candidateValid = false
    }
    const splitComplete = splitAvailable
      ? Math.abs(clickBookings + viewBookings - value) <= COUNT_TOLERANCE
      : value === 0
    if (sawClick && sawView && !splitComplete) candidateValid = false
    const candidate: AppointmentConfirmedResultRead = {
      value,
      matched: true,
      valid: candidateValid,
      clickBookings,
      viewBookings,
      splitAvailable,
      splitComplete,
    }
    valid = valid && candidateValid
    if (
      !selected || candidate.value > selected.value
      || (candidate.value === selected.value && candidate.splitAvailable && !selected.splitAvailable)
    ) selected = candidate
  }
  return selected
    ? { ...selected, valid: valid && selected.valid }
    : {
        value: 0, matched: false, valid, clickBookings: 0, viewBookings: 0,
        splitAvailable: false, splitComplete: false,
      }
}

export function findAppointmentConfirmedResults(results: MetaInsightRow['results']): number {
  return readAppointmentConfirmedResult(results).value
}

/** View-through share of the Results count: the ['1d_view'] per-window entries of AppointmentConfirmed
 *  indicators (the same payload findAppointmentConfirmedResults dedups). Returns null — NOT 0 — when no
 *  per-window breakdown is present (absence of the breakdown is unknown, not "no view-throughs"). */
export function findAppointmentConfirmedViewThrough(results: MetaInsightRow['results']): number | null {
  const result = readAppointmentConfirmedResult(results)
  return result.matched && result.splitAvailable ? result.viewBookings : null
}

/**
 * THE booking-value reading. There is exactly one, deliberately.
 *
 * Until 2026-08-19 money was read twice — once by the readiness gate and once by the writer that fills
 * `appointment_value` — with different precedence, a different zero rule and different validity
 * handling. Three consecutive fixes were applied to the gate copy while the writer copy went untouched,
 * so a gate that reported "value present" still stored NULL. Both callers now read through here.
 *
 * Only an appointment-named measure can populate AppointmentConfirmed value. A purchase action/value
 * is a different outcome family and cannot be re-labeled as appointment value or booking ROAS.
 *
 * On the aggregate that used to sit at the end of this chain: `offsite_conversion.fb_pixel_custom` was
 * treated as a stand-in for booking value on the belief that AppointmentConfirmed is the only
 * value-carrying custom event on the account. Real payloads refute that: rows carrying BOTH the
 * aggregate and the purchase family were observed to disagree in every case, in both directions. The
 * aggregate
 * sums every custom pixel event and tracks a different attribution basis, so it answers a different
 * question. Substituting it is a fail-open — the same class as reading a missing measure as zero — and
 * it produces a spurious `meta_outcome_ad_value_mismatch`: one ad row with no purchase entry falls
 * through to the aggregate and pushes the ad-level total above the campaign total.
 *
 * `matched` is the presence predicate — set when an entry of the right type exists whatever its
 * number, so a booking Meta priced at 0.00 (a comped session, a package redemption) is a reported
 * zero and not a missing measure. `valid` is false when a matched entry carries an unparseable
 * amount, so malformed money fail-stops rather than resolving to zero.
 */
/**
 * The VIEW-THROUGH share of booking value — the money twin of `findAppointmentConfirmedViewThrough`.
 *
 * An absent `1d_view` alongside ANY other window sub-key is a measured ZERO — Meta omits a
 * zero-valued window rather than withholding the breakdown. `null` is reserved for a row reporting no
 * window breakdown at all, which is genuinely unknown. (This header previously asserted the opposite,
 * mirrored from the count reader; measurement at ADSET level reversed it.)
 *
 * For example, an account whose month reads 2356.00 of 3800.00 = 62.0% view-through, with per-ad
 * shares of 100%, 90% and 70%: a creative verdict read off total value alone would be ranking ads on
 * impressions nobody clicked.
 */
export function readBookingValueViewThrough(
  actionValues: MetaInsightRow['action_values'],
  extraConversionId?: string,
  conversionValues?: MetaInsightRow['conversion_values'],
): { value: number | null; valid: boolean } {
  for (const source of [conversionValues, actionValues]) {
    if (!Array.isArray(source)) continue

    // SAME SELECTION AS `readBookingValue`, which uses `normalizedActionMax` — the MAX matching
    // entry, not the first. This used `.find()`, and the two readers could therefore describe
    // DIFFERENT entries on the same row. `readAppointmentConfirmedResult`'s docblock states that
    // repeated aliases of one logical conversion are an anticipated payload shape, so with an alias
    // pair [{value 100, 1d_view 100}, {value 3800, 1d_view 2356}] the total would store 3800
    // (max) while the view-through stored 100 (first) — a 2.6% view-through share against a true
    // 62.0%, which is the exact creative-ranking error this column exists to prevent, inverted.
    let best: MetaInsightAction | null = null
    let bestValue = -1
    for (const entry of source) {
      if (!isAppointmentConfirmedType(entry.action_type ?? '', extraConversionId)) continue
      const total = parseOutcomeNumber(entry.value)
      if (total === null) return { value: null, valid: false }
      if (total > bestValue) { bestValue = total; best = entry }
    }
    if (!best) continue

    const raw = best['1d_view']
    if (raw === undefined) {
      // META OMITS A ZERO-VALUED WINDOW — it does not withhold the breakdown.
      //
      // Mirroring `findAppointmentConfirmedViewThrough`'s "absent = unknown" rule was wrong HERE, and
      // ad-set-level rows show why (under the sync's own window request; account and ad level are
      // inferred from this): on every row where `1d_view` was absent, `7d_click` alone equalled
      // `value` exactly. The breakdown WAS reported; the omitted window was simply zero.
      //
      // So the old rule inverted the column's entire purpose: a 100%-CLICK row, the best kind an
      // account can produce, became the only row whose click-through value was uncomputable. Worse,
      // the account rollup nulls a whole account-day when any child is null, so one pure-click
      // campaign-day erased the split for the account.
      //
      // A sibling window present => the breakdown was reported => the absent one is a measured ZERO.
      // Only a total absence of window sub-keys is genuinely unknown.
      // ANY window sub-key, not a hardcoded one. Testing `best['7d_click']` coupled this to
      // ACTION_ATTRIBUTION_WINDOWS_ARR without referencing it: change that const to
      // ['28d_click','1d_view'] and the sentinel is permanently false, silently reverting every
      // absent `1d_view` to null, with no test failing. It also mis-read the one ad set whose spec
      // carries a third ENGAGED_VIDEO_VIEW window.
      const anyWindowReported = Object.keys(best).some((k) => k !== 'action_type' && k !== 'value')
      return { value: anyWindowReported ? 0 : null, valid: true }
    }

    // MALFORMED MONEY FAIL-STOPS, it does not become `null`. `null` is DEFINED by the column comment
    // and db.ts as "split not reported (unknown)"; collapsing a corrupt amount into it would launder
    // bad input into a legitimate unknown and store it. `readBookingValue` fail-stops on exactly this
    // (`valid: false`) and this reader now shares the channel.
    const parsed = parseOutcomeNumber(raw)
    if (parsed === null) return { value: null, valid: false }
    // `value` follows the entity's attribution_spec and IGNORES the request, while the sub-keys follow
    // the request — so the identity `value == 1d_view + 7d_click` is a property of the
    // entity's current specs (it can hold even with a third ENGAGED_VIDEO_VIEW window), not an
    // API guarantee. An ad set switched to 28d_click would break
    // it silently. A share exceeding its own total is incoherent whatever the cause: fail-stop.
    if (bestValue >= 0 && parsed > bestValue) return { value: null, valid: false }
    return { value: parsed, valid: true }
  }
  return { value: null, valid: true }
}

export function readBookingValue(
  actionValues: MetaInsightRow['action_values'],
  extraConversionId?: string,
  conversionValues?: MetaInsightRow['conversion_values'],
): { value: number; valid: boolean; matched: boolean } {
  // `conversion_values` FIRST, because it is the only field that still names the event.
  //
  // This is the value-side twin of the 2026-07-12 `results` fix. Meta stopped breaking custom pixel
  // events out by name in `actions`/`action_values`; `results` was added to recover the COUNT, and the
  // VALUE was left reading `action_values`, which from then on carried only the
  // `offsite_conversion.fb_pixel_custom` aggregate. The aggregate is refused below and refused
  // correctly — it sums every custom event — so the read fell through to "no match" and stored NULL.
  //
  // The observed shape: a month with bookings and spend stored appointment_value NULL or 0 at every
  // entity level, while Meta's `conversion_values` carried
  // `offsite_conversion.fb_pixel_custom.AppointmentConfirmed = <value>` for the same window, and broke
  // it out per ad. Coverage of booking-days carrying a value decayed month over month to 0%.
  //
  // THE DISAGREEMENT MEASUREMENT this docblock demands of any new value source (the aggregate above
  // was refused on exactly such evidence). Measured per day, four months x
  // account-level and ad-level — eight populations:
  //
  //     rows where BOTH fields name AppointmentConfirmed : 0   (every population)
  //     rows where ONLY action_values names it           : 0   (every population)
  //     rows where ONLY conversion_values names it       : > 0   (every population)
  //
  // The two never both answer, so there is no disagreement to adjudicate and no risk of substituting
  // one basis for another — the failure mode that condemned the aggregate. This is a stronger result
  // than "they agree".
  //
  // The `action_values` branch below is therefore DEAD for this account on any re-fetch, and the
  // original justification for it — "historical rows name the event there, a backfill must keep
  // reading them" — is FALSE. Meta re-serves history under the CURRENT schema: an April re-fetch
  // returns conversion_values only, exactly like August. Nothing re-read can reach that branch.
  //
  // It is kept anyway, for one honest reason only: rows ALREADY STORED were written when the API did
  // name the event in action_values, `daily_insights` persists that payload, and
  // A restatement script can replay stored payloads rather than re-fetching. Delete the
  // branch and a replay of pre-change rows recomputes them to NULL. It guards stored history, not
  // future reads — do not let a reader infer more from it than that.
  const named = normalizedActionMax(
    conversionValues,
    (type) => isAppointmentConfirmedType(type, extraConversionId),
  )
  if (named.matched) return named

  const specific = normalizedActionMax(
    actionValues,
    (type) => isAppointmentConfirmedType(type, extraConversionId),
  )
  return specific.matched ? specific : { value: 0, valid: specific.valid, matched: false }
}
