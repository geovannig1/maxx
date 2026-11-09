import { REC_THRESHOLDS } from '@/lib/recommendations/thresholds'
import type { Severity, MonitoringArea } from './alerts'
import { formatMoney } from '@/lib/utils/format-currency'
import { outcomeWords, withIndefiniteArticle } from '@/config/outcome-nouns'
import { SPEND_FLOORS } from '@/config/spend-floors'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// Pure, testable detectors. Each returns a finding or null. The runner (run.ts) turns findings into
// emitAlert() calls. Keeping the logic pure means we can unit-test the thresholds without Sentry/DB.

export interface MonitoringFinding {
  area: MonitoringArea
  severity: Severity
  message: string
  dedupeKey?: string
}

/** Data freshness: warn if the last successful sync is old; critical if very old or never. */
export function detectStaleData(hoursSinceSync: number | null): MonitoringFinding | null {
  if (hoursSinceSync === null) {
    return { area: 'stale_data', severity: 'critical', message: 'No successful sync on record — data may be missing or stale.' }
  }
  if (hoursSinceSync > REC_THRESHOLDS.MAX_DATA_AGE_HOURS * 2) {
    return { area: 'stale_data', severity: 'critical', message: `Last successful sync was ${hoursSinceSync.toFixed(0)}h ago — data is badly stale.` }
  }
  if (hoursSinceSync > REC_THRESHOLDS.MAX_DATA_AGE_HOURS) {
    return { area: 'stale_data', severity: 'warning', message: `Last successful sync was ${hoursSinceSync.toFixed(0)}h ago (> ${REC_THRESHOLDS.MAX_DATA_AGE_HOURS}h).` }
  }
  return null
}

/**
 * Meta-vs-GA4 booking mismatch. Meta UNDER-counting GA4 is EXPECTED (the pixel misses ~30-40%) and is
 * only an info signal. The concerning directions are: GA4 shows none while Meta claims several, or
 * Meta materially EXCEEDS GA4 (likely over-attribution / a value bug).
 */
/** These arrive NAMED, not positional. Adding `ledgerAppointments` as a 4th positional
 *  number silently redefined what every existing 4-arg caller was passing — `(0, true, 0, 120)` meant
 *  "$120 spend" and became "120 ledger appointments, $0 spend". Both are `number`, so the compiler
 *  could not see it. Named fields make that substitution impossible. */
export function detectMetaGa4Mismatch(input: {
  metaBookings: number
  ga4Available: boolean
  ga4ConfirmationEvents: number
  /** GA-ELIGIBLE evidence ONLY: active appointments whose origin was the website, read over the SAME
   *  dates as the two planes. This was previously the ALL-SOURCE confirmed-appointment
   *  count read to TODAY while both planes ended yesterday. One organic, phone or staff-created
   *  appointment then "contradicted" Meta's paid subset and produced a tracking-outage claim that the
   *  evidence never supported. `null` means NOT READ — stated, never glossed as agreement. */
  websiteOriginAppointments: number | null
  metaSpend?: number
}): MonitoringFinding | null {
  const { metaBookings, ga4Available, ga4ConfirmationEvents, websiteOriginAppointments, metaSpend = 0 } = input
  if (!ga4Available) {
    return { area: 'ga4', severity: 'warning', message: 'GA confirmation-event telemetry is unavailable — the Meta-vs-GA plane comparison cannot be made. Business counts and booked value come from the outcome ledger and are unaffected.' }
  }
  // Spend flowing with zero on BOTH estimate planes. Calling this a likely tracking outage
  // was overconfident — $50 of spend with no conversions is also just ordinary poor performance. An
  // outage is only the better explanation when the LEDGER shows appointments the tracking planes
  // missed. Without that independent evidence this reports the observation, not a diagnosis.
  const MIN_SPEND_FOR_TRACKING_CHECK = SPEND_FLOORS.trackingCheck // account currency
  if (metaSpend >= MIN_SPEND_FOR_TRACKING_CHECK && metaBookings === 0 && ga4ConfirmationEvents === 0) {
    // Only WEBSITE-ORIGIN appointments can contradict these planes, and even then the contradiction
    // is specific to the GA browser tag. Meta delivery health is a SEPARATE question that needs CAPI
    // delivery evidence — see detectMetaDeliveryHealth. This branch never claims both at once.
    const gaGap = websiteOriginAppointments !== null && websiteOriginAppointments > 0
    return gaGap
      ? { area: 'meta_ga4_mismatch', severity: 'warning', message: `${formatMoney(metaSpend, { maximumFractionDigits: 0 })} spent over the last 7 days with ZERO Meta modelled conversions and ZERO GA confirmation events, while ${websiteOriginAppointments} WEBSITE-ORIGIN ${OW.one}(s) were booked in the same window — those should each have produced a GA confirmation event, so the browser tag looks broken. This says nothing about Meta delivery, which needs CAPI evidence to judge.` }
      : { area: 'meta_ga4_mismatch', severity: 'info', message: `${formatMoney(metaSpend, { maximumFractionDigits: 0 })} spent over the last 7 days with ZERO Meta modelled conversions and ZERO GA confirmation events. ${websiteOriginAppointments === null ? 'Website-origin ledger activity was NOT read, so this cannot be distinguished from' : `No website-origin ${OW.many} were booked in that window either, so this is consistent with`} ordinary poor performance — check CAPI delivery health before calling it an outage.` }
  }
  if (ga4ConfirmationEvents === 0 && metaBookings >= 3) {
    return { area: 'meta_ga4_mismatch', severity: 'warning', message: `Meta reports ${metaBookings} modelled conversions but GA recorded ZERO confirmation events — the browser tag or its attribution is likely broken. Neither figure is ${withIndefiniteArticle(OW.one)} count; the outcome ledger holds those.` }
  }
  if (metaBookings > ga4ConfirmationEvents * 1.5 + 2) {
    return { area: 'meta_ga4_mismatch', severity: 'warning', message: `Meta modelled (${metaBookings}) materially exceeds GA confirmation events (${ga4ConfirmationEvents}). Both are estimates of the ad-driven subset and NEITHER is business truth — investigate the gap; do not resolve it in favour of either. Business counts come from the outcome ledger.` }
  }
  if (ga4ConfirmationEvents >= 5 && metaBookings < ga4ConfirmationEvents * 0.5) {
    return { area: 'meta_ga4_mismatch', severity: 'info', message: `Meta modelled (${metaBookings}) is under-counting vs GA confirmation events (${ga4ConfirmationEvents}) — an expected pixel under-count. Both are estimates of the ad-driven subset; ${OW.one} totals come from the outcome ledger, and a paid figure needs an exact ${OW.one}-id join.` }
  }
  return null
}

/**
 * GA BROWSER-TAG health, judged on its own population over its own window. A website-origin
 * appointment is a client booking through the site, so it SHOULD emit a GA confirmation event.
 * Deliberately independent of Meta: this asks whether the tag fired, not whether ads worked.
 * Previously entangled with Meta delivery in one all-source check, which let organic
 * volume argue about a paid subset.
 */
export function detectGaTagHealth(input: {
  ga4Available: boolean
  ga4ConfirmationEvents: number
  /** `null` = not read. Never treated as zero. */
  websiteOriginAppointments: number | null
  /** Confirmations whose origin was never established. When there are no website confirmations but
   *  some unknown ones, coverage is NOT EVALUABLE — which must be said, not silently read as "no
   *  website bookings". */
  originUnknownConfirmations?: number | null
  /** Both figures MUST come from the same dates; the caller states them so the message can too. */
  window: { start: string; end: string }
}): MonitoringFinding | null {
  const { ga4Available, ga4ConfirmationEvents, websiteOriginAppointments,
          originUnknownConfirmations = null, window } = input
  if (!ga4Available || websiteOriginAppointments === null) return null
  if (websiteOriginAppointments === 0) {
    // Zero WEBSITE confirmations beside unknown-origin ones is not "no website activity".
    // It is an unevaluable window, and saying so is the only honest reading.
    if (originUnknownConfirmations !== null && originUnknownConfirmations > 0) {
      return { area: 'ga_tag_health', severity: 'info', message: `No confirmation in ${window.start}..${window.end} could be established as website-origin, but ${originUnknownConfirmations} had an origin that was NEVER ESTABLISHED — so GA browser-tag coverage over this window is NOT EVALUABLE. This is explicitly NOT a finding that there were no website ${OW.many}.` }
    }
    return null
  }
  const w = `${window.start}..${window.end}`
  if (ga4ConfirmationEvents === 0) {
    return { area: 'ga_tag_health', severity: 'warning', message: `${websiteOriginAppointments} website-origin ${OW.one}(s) were booked in ${w} but GA recorded ZERO confirmation events over the SAME dates — the browser tag is very likely not firing. Ledger counts are unaffected; this is a telemetry-coverage finding.` }
  }
  // A shortfall is expected (consent, ad-blockers, abandoned sessions). Only a LARGE one is a signal.
  if (ga4ConfirmationEvents < websiteOriginAppointments * 0.5) {
    return { area: 'ga_tag_health', severity: 'info', message: `GA recorded ${ga4ConfirmationEvents} confirmation event(s) against ${websiteOriginAppointments} website-origin ${OW.one}(s) in ${w} — under half. Some shortfall is normal (consent, blockers, abandoned sessions); a persistent gap this size points at tag coverage.` }
  }
  return null
}

/**
 * META DELIVERY health, judged on ACCEPTED LIVE server events only.
 *
 * `conversion_sent_at` is stamped inside `record_conversion_delivery` in the SAME
 * transaction as the lineage row, and ONLY when Meta accepted a live send (`events_received = 1`, no
 * error). Verified: that RPC is the sole writer — every other reference in src/ is a read. So the
 * marker means "Meta accepted this", not merely "we posted something".
 *
 * The previous version fired only at ZERO delivered, so 1 accepted of 10 eligible — nine
 * bookings Meta never received — produced silence. Every eligible website confirmation should have
 * exactly one accepted live event, so ANY shortfall is actionable. There is deliberately no
 * "acceptable loss" percentage: a threshold would hide precisely the missing events this exists to
 * surface. Severity scales; silence is never an option.
 */
export function detectMetaDeliveryHealth(input: {
  metaSpend: number
  /** Website confirmations with an ACCEPTED LIVE CAPI event. `null` = not read. */
  capiDeliveredAppointments: number | null
  /** Website confirmations that were eligible to be sent. `null` = not read. */
  capiEligibleAppointments: number | null
  /** Confirmations whose origin was never established — coverage over them is NOT evaluable. */
  originUnknownConfirmations?: number | null
  window: { start: string; end: string }
}): MonitoringFinding[] {
  const { metaSpend, capiDeliveredAppointments: delivered, capiEligibleAppointments: eligible,
          originUnknownConfirmations = null, window } = input
  const out: MonitoringFinding[] = []
  const w = `${window.start}..${window.end}`

  if (delivered === null || eligible === null) {
    out.push({ area: 'meta_delivery_health', severity: 'info', message: `CAPI delivery evidence for ${w} was NOT READ, so server-side delivery health is unknown. This is not a claim that zero events were delivered.` })
  } else if (eligible > 0) {
    const missing = eligible - delivered
    const pct = Math.round((delivered / eligible) * 100)
    if (delivered === 0) {
      // Spend flowing with NOTHING accepted is the most severe shape; without spend it is still a
      // total delivery failure, just less costly.
      out.push({ area: 'meta_delivery_health', severity: metaSpend >= SPEND_FLOORS.trackingCritical ? 'critical' : 'warning', message: `NO accepted live CAPI event for ANY of the ${eligible} eligible website confirmation(s) in ${w}${metaSpend >= SPEND_FLOORS.trackingCritical ? `, while ${formatMoney(metaSpend, { maximumFractionDigits: 0 })} was spent` : ''} — server-side delivery to Meta is failing outright. Every eligible website confirmation should have exactly one accepted live event.` })
    } else if (missing > 0) {
      out.push({ area: 'meta_delivery_health', severity: 'warning', message: `PARTIAL CAPI delivery in ${w}: ${delivered} of ${eligible} eligible website confirmation(s) accepted live by Meta — ${missing} MISSING (${pct}% accepted). Every eligible website confirmation should have exactly one accepted live event; the missing ones were never received, so Meta is optimising and reporting without them.` })
    }
    // delivered === eligible -> healthy, no finding.
  }

  // Unknown-origin confirmations are reported SEPARATELY. They are neither delivered nor missing:
  // whether they should have produced a server event was never established.
  if (originUnknownConfirmations !== null && originUnknownConfirmations > 0) {
    out.push({ area: 'meta_delivery_health', severity: 'info', message: `${originUnknownConfirmations} confirmation(s) in ${w} have an ORIGIN THAT WAS NEVER ESTABLISHED, so CAPI coverage over them is NOT EVALUABLE. They are excluded from the accepted/missing counts above rather than assumed either way — this is not a claim that they were website ${OW.many}, nor that they were not.` })
  }
  return out
}

/** Implausible per-EVENT value ⇒ likely a value double-count or unit error in the GA tag.
 *  Historical note: this called the ratio "revenue per booking", converting confirmation-event counts and
 *  GA event value into business language. It is a TAG-HEALTH check on telemetry, not a money reading. */
export function detectBookingRevenueMismatch(ga4ConfirmationEvents: number, ga4EventValue: number): MonitoringFinding | null {
  if (ga4ConfirmationEvents <= 0) return null
  const perBooking = ga4EventValue / ga4ConfirmationEvents
  if (perBooking < 20) {
    return { area: 'ga_event_value_health', severity: 'warning', message: `GA event value per confirmation event is ${formatMoney(perBooking)} — implausibly low for a studio ${OW.one}. This is a TAG-HEALTH signal about the GA value parameter, not a revenue reading; check the GTM value mapping.` }
  }
  if (perBooking > 2000) {
    return { area: 'ga_event_value_health', severity: 'warning', message: `GA event value per confirmation event is ${formatMoney(perBooking)} — implausibly high; possible double-counted value in the GA tag. A TAG-HEALTH signal, not a revenue reading.` }
  }
  return null
}

/** Duplicate insight rows (regression guard for the NULLS-NOT-DISTINCT unique key on daily_insights). */
export function detectDuplicateData(totalRows: number, distinctLogicalKeys: number): MonitoringFinding | null {
  if (totalRows > distinctLogicalKeys) {
    return { area: 'duplicate_data', severity: 'warning', message: `Found ${totalRows - distinctLogicalKeys} duplicate insight row(s) (${totalRows} rows vs ${distinctLogicalKeys} logical keys) — dedup regression.` }
  }
  return null
}

/** Daily report missing for the day ⇒ report generation failed (metrics should persist even w/o LLM). */
export function detectReportFailure(reportExistsForToday: boolean): MonitoringFinding | null {
  if (!reportExistsForToday) {
    return { area: 'report', severity: 'warning', message: 'No daily report row persisted for today — report generation may have failed (metrics should persist even without an LLM).' }
  }
  return null
}

/**
 * NARRATIVE failure: a daily_reports row persists even when the LLM call fails (metrics-only, model_used
 * = 'none'), so detectReportFailure (row-exists) stays silent. This catches "the report ran but the
 * narrative never generated" — but only when a provider is actually configured (else it's expected).
 */
export function detectReportNarrativeFailure(modelUsed: string | null, providerConfigured: boolean): MonitoringFinding | null {
  if (providerConfigured && (modelUsed === null || modelUsed === '' || modelUsed === 'none')) {
    return { area: 'llm', severity: 'warning', message: `Daily report persisted but the LLM narrative did NOT generate (model_used="${modelUsed ?? 'null'}") despite a configured provider — the report is metrics-only.` }
  }
  return null
}

/**
 * UTM coverage: below-100% coverage on active ads blocks per-campaign GA4 ROAS (the ads are
 * effectively untracked). Silent at zero ads (pre-launch — nothing to alert) and at full coverage.
 * The dedupe key encodes the COUNT-STATE, so an unchanged condition dedupes within the window while
 * a newly-launched untracked ad (counts change) produces a fresh alert — no state storage needed.
 */
export function detectUtmCoverage(stats: { adsTotal: number; adsCorrect: number }): MonitoringFinding | null {
  if (stats.adsTotal === 0 || stats.adsCorrect === stats.adsTotal) return null
  const broken = stats.adsTotal - stats.adsCorrect
  return {
    area: 'utm_coverage',
    severity: 'warning',
    message: `${broken} of ${stats.adsTotal} active ads have missing/misconfigured UTMs — per-campaign GA4 ROAS is blocked. Run get_utm_health for the exact fix strings.`,
    dedupeKey: `cov_${stats.adsCorrect}_${stats.adsTotal}`,
  }
}

/**
 * CAPI delivery backlog. The webhook delivers in ~6s; when it fails, the daily reconcile sweep
 * recovers the row, but only while it is younger than the 46h resend cutoff in reconcile.ts. So a
 * row unsent for hours means the webhook path failed, and a row unsent for more than a day means the
 * sweep did not recover it either — one more missed cron and it ages out permanently.
 */
export function detectCapiDeliveryBacklog(input: {
  oldestUnsentHours: number | null
  missedWindow: number
}): MonitoringFinding | null {
  const { oldestUnsentHours, missedWindow } = input
  if (missedWindow > 0) {
    return {
      area: 'cron',
      severity: 'critical',
      message: `${missedWindow} ${OW.one}(s) aged past the CAPI resend cutoff and can never be delivered to Meta.`,
      dedupeKey: 'capi_missed_window',
    }
  }
  if (oldestUnsentHours === null) return null
  if (oldestUnsentHours >= 30) {
    return {
      area: 'cron',
      severity: 'critical',
      message: `${withIndefiniteArticle(OW.one).replace(/^a/, 'A')} has gone ${oldestUnsentHours.toFixed(0)}h without CAPI delivery — the reconcile sweep is not recovering it and the 46h cutoff is approaching.`,
      dedupeKey: 'capi_backlog',
    }
  }
  if (oldestUnsentHours >= 3) {
    return {
      area: 'cron',
      severity: 'warning',
      message: `${withIndefiniteArticle(OW.one).replace(/^a/, 'A')} has gone ${oldestUnsentHours.toFixed(0)}h without CAPI delivery — the webhook path likely failed; the sweep should recover it.`,
      dedupeKey: 'capi_backlog',
    }
  }
  return null
}

/** Write mode is a kill switch that must stay OFF until proven. If it's on, that itself is an alert. */
export function detectWriteModeTripwire(writeModeEnabled: boolean): MonitoringFinding | null {
  if (writeModeEnabled) {
    return { area: 'write_mode', severity: 'critical', message: 'WRITE_MODE_ENABLED is TRUE — Maxx can execute approved live changes. Confirm this is intentional.' }
  }
  return null
}
