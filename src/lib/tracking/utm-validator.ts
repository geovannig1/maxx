// Pure UTM validator (attribution-integrity package). No DB imports — importable by pure modules
// (launch-readiness.ts) and unit tests.
//
// WHY THIS EXISTS: ads commonly carry no UTMs at all, and hand-typed ones tend to be misconfigured
// (utm_source={{campaign.name}} backwards, a hardcoded utm_campaign, a raw %3F corrupting the URL).
// Until every active ad carries the
// canonical dynamic scheme, GA cannot produce clean campaign-session telemetry. Paid ROAS additionally
// requires complete exact appointment identity and authoritative spend. This module turns each ad's synced `url_tags` into a verdict +
// the EXACT corrected string the owner pastes into Ads Manager (read-only: we never write to Meta).

/** Canonical scheme — single source of truth (launch-readiness.ts interpolates this, no prose copies). */
export const CANONICAL_UTM_PARAMS = {
  utm_source: 'meta',
  utm_medium: 'paid_social',
  utm_campaign: '{{campaign.name}}',
  utm_content: '{{ad.name}}',
  utm_term: '{{adset.name}}',
  meta_campaign_id: '{{campaign.id}}',
  meta_adset_id: '{{adset.id}}',
  meta_ad_id: '{{ad.id}}',
} as const

export const CANONICAL_UTM_STRING = Object.entries(CANONICAL_UTM_PARAMS)
  .map(([k, v]) => `${k}=${v}`)
  .join('&')

// utm_source must be the traffic source, never the campaign. {{site_source_name}} is the blessed
// dynamic alternative when the owner wants the FB-vs-IG split.
const ACCEPTED_SOURCES = new Set(['meta', 'facebook', 'instagram', '{{site_source_name}}'])

// utm_campaign must be DYNAMIC — a hardcoded value (e.g. utm_campaign=spring_promo) makes every
// campaign identical in GA4 and removes per-campaign attribution.
const DYNAMIC_CAMPAIGN = /^\{\{campaign\.(name|id)\}\}$/

// 'unverified' = we could not READ the ad's tracking from any synced source (no url_tags field AND no
// destination link captured) — distinct from 'missing' (we read it; there are genuinely no UTMs). The
// loader assigns 'unverified'; validateUrlTags itself only ever returns correct/missing/misconfigured.
export type UtmVerdict = 'correct' | 'missing' | 'misconfigured' | 'unverified'

export type UtmDefectCode =
  | 'no_url_tags' // empty/null — the ad is untracked
  | 'wrong_utm_source' // e.g. {{campaign.name}} — backwards; breaks GA4 channel grouping
  | 'wrong_utm_medium'
  | 'hardcoded_utm_campaign' // not {{campaign.name|id}} → no per-campaign attribution
  | 'missing_param' // one of the 5 canonical params absent (`param` says which)
  | 'missing_meta_id' // one of the three immutable Meta identity parameters is absent
  | 'wrong_meta_id' // immutable Meta identity parameter is not the corresponding dynamic id
  | 'encoded_question_mark' // raw %3F artifact — a malformed second query string corrupts the URL
  | 'leading_question_mark' // field starts with '?' — Meta appends its own; this is how %3F was born
  | 'duplicate_param'

export interface UtmDefect {
  code: UtmDefectCode
  param?: string
  detail: string
}

export interface UtmValidation {
  verdict: UtmVerdict
  defects: UtmDefect[]
  /** Always the canonical string — the exact paste-into-Ads-Manager text (Ad → Tracking → URL parameters, no leading `?`). */
  corrected: string
}

/**
 * Validate one ad's url_tags against the canonical scheme.
 * Parsing is a RAW split (never URLSearchParams — it decodes %3F to `?`, hiding the exact
 * corruption we need to detect) so Meta placeholders like {{campaign.name}} survive untouched.
 */
export function validateUrlTags(urlTags: string | null | undefined): UtmValidation {
  const raw = (urlTags ?? '').trim()
  if (raw === '') {
    return {
      verdict: 'missing',
      defects: [{ code: 'no_url_tags', detail: 'No URL parameters at all — GA4 cannot attribute this ad to any campaign.' }],
      corrected: CANONICAL_UTM_STRING,
    }
  }

  const defects: UtmDefect[] = []

  // Raw-string checks first — these corruptions survive/precede any parsing.
  if (/%3F/i.test(raw)) {
    defects.push({
      code: 'encoded_question_mark',
      detail: 'Contains a raw %3F (URL-encoded "?") — a malformed second query string that corrupts the destination URL. Delete it.',
    })
  }
  if (raw.startsWith('?')) {
    defects.push({
      code: 'leading_question_mark',
      detail: 'Starts with "?" — Meta appends its own; paste the parameters WITHOUT a leading "?".',
    })
  }

  // Raw split on '&' and first '=' — keys/values kept verbatim (placeholders intact).
  const params = new Map<string, string>()
  const seen = new Set<string>()
  for (const part of raw.replace(/^\?/, '').split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const key = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    if (seen.has(key)) {
      defects.push({ code: 'duplicate_param', param: key, detail: `"${key}" appears more than once — GA4 behavior is undefined; keep exactly one.` })
    }
    seen.add(key)
    if (!params.has(key)) params.set(key, value)
  }

  const source = params.get('utm_source')
  if (source === undefined) {
    defects.push({ code: 'missing_param', param: 'utm_source', detail: 'utm_source is missing — GA4 needs the traffic source (meta).' })
  } else if (!ACCEPTED_SOURCES.has(source)) {
    defects.push({
      code: 'wrong_utm_source',
      param: 'utm_source',
      detail: `utm_source=${source} — must be the traffic source (meta, or {{site_source_name}} for the FB/IG split), never the campaign. GA4 channel grouping breaks otherwise.`,
    })
  }

  const medium = params.get('utm_medium')
  if (medium === undefined) {
    defects.push({ code: 'missing_param', param: 'utm_medium', detail: 'utm_medium is missing — use paid_social.' })
  } else if (medium !== CANONICAL_UTM_PARAMS.utm_medium) {
    defects.push({ code: 'wrong_utm_medium', param: 'utm_medium', detail: `utm_medium=${medium} — use paid_social so GA4 groups this as paid.` })
  }

  const campaign = params.get('utm_campaign')
  if (campaign === undefined) {
    defects.push({ code: 'missing_param', param: 'utm_campaign', detail: 'utm_campaign is missing — use {{campaign.name}} so GA4 can tell campaigns apart.' })
  } else if (!DYNAMIC_CAMPAIGN.test(campaign)) {
    defects.push({
      code: 'hardcoded_utm_campaign',
      param: 'utm_campaign',
      detail: `utm_campaign=${campaign} is hardcoded — every campaign reports identically in GA4, so per-campaign attribution is impossible. Use {{campaign.name}}.`,
    })
  }

  for (const p of ['utm_content', 'utm_term'] as const) {
    if (!params.has(p)) {
      defects.push({ code: 'missing_param', param: p, detail: `${p} is missing — use ${CANONICAL_UTM_PARAMS[p]} for ${p === 'utm_content' ? 'ad' : 'ad-set'}-level attribution.` })
    }
  }

  const requiredMetaIds = {
    meta_campaign_id: '{{campaign.id}}',
    meta_adset_id: '{{adset.id}}',
    meta_ad_id: '{{ad.id}}',
  } as const
  for (const [key, expected] of Object.entries(requiredMetaIds)) {
    const actual = params.get(key)
    if (actual === undefined) {
      defects.push({
        code: 'missing_meta_id',
        param: key,
        detail: `${key} is missing — readable names cannot provide a durable paid-touch join. Use ${expected}.`,
      })
    } else if (actual !== expected) {
      defects.push({
        code: 'wrong_meta_id',
        param: key,
        detail: `${key}=${actual} — use ${expected} so Meta resolves the immutable entity id at delivery.`,
      })
    }
  }

  return {
    verdict: defects.length === 0 ? 'correct' : 'misconfigured',
    defects,
    corrected: CANONICAL_UTM_STRING,
  }
}

export interface UtmCoverageStats {
  adsTotal: number
  adsCorrect: number
  adsMissing: number
  adsMisconfigured: number
  /** Ads whose tracking couldn't be read from any synced source — can't be judged (not "missing"). */
  adsUnverified: number
  /** adsCorrect / JUDGEABLE ads (total − unverified); null when nothing is judgeable. Excluding
   *  unverified means an unreadable sync can never manufacture a false 0%. */
  coverage: number | null
}

/**
 * The effective url_tags Meta uses at delivery: the AD-level value wins, the CREATIVE-
 * level value is the fallback. Empty/whitespace at either level counts as absent. So an ad with an
 * empty `ads.url_tags` but a valid `creatives.url_tags` is correctly judged on the creative's tags —
 * never falsely reported as "no UTMs" (audit Bug 2).
 */
export function effectiveUrlTags(
  adUrlTags: string | null | undefined,
  creativeUrlTags: string | null | undefined,
): string | null {
  const ad = (adUrlTags ?? '').trim()
  if (ad !== '') return ad
  const creative = (creativeUrlTags ?? '').trim()
  return creative !== '' ? creative : null
}

/** Pure aggregation over per-ad verdicts (the DB loader supplies them; tests don't need a DB). */
export function computeCoverageStats(verdicts: UtmVerdict[]): UtmCoverageStats {
  const stats: UtmCoverageStats = { adsTotal: verdicts.length, adsCorrect: 0, adsMissing: 0, adsMisconfigured: 0, adsUnverified: 0, coverage: null }
  for (const v of verdicts) {
    if (v === 'correct') stats.adsCorrect++
    else if (v === 'missing') stats.adsMissing++
    else if (v === 'unverified') stats.adsUnverified++
    else stats.adsMisconfigured++
  }
  // Coverage is over the JUDGEABLE ads (exclude unverified) so an unreadable sync can't fake a 0%.
  const judgeable = stats.adsTotal - stats.adsUnverified
  if (judgeable > 0) stats.coverage = stats.adsCorrect / judgeable
  return stats
}

// Verification guidance for booking-event linkage. The GA confirmation event is configured outside
// this repo; Maxx only reads it and must separately verify appointment identity.
export const BOOKING_LINKAGE_CHECKLIST: string[] = [
  'Confirm where the booking actually COMPLETES: on your own domain or on a third-party scheduler or checkout page (for example as.me).',
  'If the booking confirms on your own domain, verify the confirmation event keeps the UTM session and carries appointment_id; session continuity alone is not outcome identity.',
  'If /book redirects to or embeds a third-party scheduler page (as.me), the conversion crosses origins — configure GA cross-domain measurement (your domain ↔ as.me) OR fire the confirmation event on example-studio.test with a validated postMessage origin and appointment_id.',
  'Test: click a live ad and complete a test booking starting at your booking page through to confirmation.',
  "Check that the confirmation event's sessionCampaignName is the Meta campaign, not (direct)/(not set), and separately verify its appointment_id joins one outcome row.",
  'If GA still shows (direct) after the UTM fix, the likely break is session continuity in the booking flow; verify it rather than asserting the ad URL is at fault.',
]

export interface BookingLinkageAssessment {
  suspected: boolean
  /** This is a heuristic, never a measured fact — label it as such everywhere it surfaces. */
  label: 'ASSUMPTION'
  rationale: string
  checklist: string[]
}

/**
 * Cross-domain-breakage heuristic: UTMs look correct on ~all active ads, yet GA4 tags almost none
 * of its confirmation events with a named paid campaign — the session is likely breaking before confirmation
 * (a third-party scheduler page, for example as.me, across domains), not at the ad URL. Inputs are all already computed elsewhere
 * (coverage from this module, attributedShare/purchases from getGa4ConfirmationTelemetryByCampaign).
 */
export function assessBookingLinkage(input: {
  utmCoverage: number | null
  attributedShare: number | null
  totalPurchases: number
}): BookingLinkageAssessment {
  const { utmCoverage, attributedShare, totalPurchases } = input
  const base = { label: 'ASSUMPTION' as const, checklist: BOOKING_LINKAGE_CHECKLIST }

  if (utmCoverage == null || attributedShare == null) {
    return { ...base, suspected: false, rationale: 'Cannot assess booking linkage — UTM coverage or GA4 attributed share is unknown.' }
  }
  if (utmCoverage < 0.9) {
    return {
      ...base,
      suspected: false,
      rationale: `UTM coverage is ${(utmCoverage * 100).toFixed(0)}% — fix the ad URL parameters first; linkage cannot be judged until UTMs are correct.`,
    }
  }
  if (totalPurchases < 5) {
    return { ...base, suspected: false, rationale: `Only ${totalPurchases} GA confirmation event(s) in the window — below the 5-event sample floor to judge session linkage.` }
  }
  if (attributedShare < 0.1) {
    return {
      ...base,
      suspected: true,
      rationale: `UTMs look correct on ${(utmCoverage * 100).toFixed(0)}% of active ads yet only ${(attributedShare * 100).toFixed(0)}% of GA confirmation events carry a named paid campaign — session continuity may be breaking before confirmation (Outcome source as.me cross-domain). This says nothing by itself about paid bookings. Work the checklist.`,
    }
  }
  return { ...base, suspected: false, rationale: `Campaign telemetry is flowing (${(attributedShare * 100).toFixed(0)}% of GA confirmation events carry a named paid campaign) — no session-tagging break suspected. Paid outcomes still require the exact appointment join.` }
}
