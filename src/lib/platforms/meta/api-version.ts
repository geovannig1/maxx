// SINGLE SOURCE OF TRUTH for the Meta Graph API version (2026-07-17).
//
// The version was previously hardcoded as v22.0 in ~a dozen paths (reads, CAPI, writes, competitor
// research, midday sync). Meta publishes SEPARATE Graph API and Marketing API version tables: Graph API
// v22.0 expiry is still TBD, but MARKETING API v22.0 expired 2026-02-19 — and Maxx's campaign / ad-set /
// insights / write / CAPI calls are Marketing API calls even though the host is graph.facebook.com. Per
// Meta's docs an expired version's calls "may fail or be upgraded to the next available version": the
// upgrade applies ONLY to endpoints unaffected by intervening versions (e.g. GET /insights kept working,
// which is why daily syncs never broke), while changed endpoints (e.g. POST /{adset-id} writes) fail. So
// a stale version risked silent payload drift on reads and outright failure on writes — not a clean
// transparent rollover.
// v25.0 verified live 2026-07-17: latest available (v26 probes return "Unknown path components"),
// account reachable, and the insights `results` field returns the same dual attribution-window shape
// the bookings parser handles (default-entry preferred).
//
// Bump policy: change META_API_VERSION_DEFAULT here (or set the META_API_VERSION env var for an
// emergency pin without a deploy). tests/meta-api-version.test.ts fails the suite if any file
// hardcodes a graph.facebook.com version outside this module.
const META_API_VERSION_DEFAULT = 'v25.0'

export const META_API_VERSION = process.env.META_API_VERSION ?? META_API_VERSION_DEFAULT

/** Unversioned Graph API origin. Only scripts/doctor.ts uses it (it pins its own version). */
export const META_GRAPH_ORIGIN = 'https://graph.facebook.com'

/** Versioned Graph API base, no trailing slash: `https://graph.facebook.com/v25.0` */
export const META_GRAPH_BASE = `${META_GRAPH_ORIGIN}/${META_API_VERSION}`
