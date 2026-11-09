/**
 * Meta's Ad Library API returns `ad_snapshot_url` with the caller's access token embedded
 * (`.../ads/archive/render_ad/?id=<id>&access_token=<token>`). That token can manage the ad account,
 * so a snapshot URL is reduced to its ad id before it is stored, returned or put in a prompt.
 */

const SNAPSHOT_HOSTS = new Set(['www.facebook.com', 'facebook.com'])
// Must stay inside the competitor_ads_snapshot_url_no_token CHECK allowlist in the shipped schema
// (supabase/migrations/0001_baseline.sql); one non-conforming value aborts the fetcher's whole upsert
// batch. tests/competitor-snapshot-token-redaction.test.ts checks this output against the CHECK's own pattern.
const SNAPSHOT_PATH = /^\/[A-Za-z0-9/._-]*$/
const SNAPSHOT_ID = /^[0-9]{1,30}$/

/**
 * PURE. `https://<host><path>` plus `?id=<digits>` when the id is numeric, or null if the URL is not
 * Meta's on the default port, or its path holds anything outside the allowed set (an encoded or
 * parameter-bearing path is refused rather than repaired).
 */
export function redactSnapshotUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port !== '' || !SNAPSHOT_HOSTS.has(url.hostname)) return null
  if (!SNAPSHOT_PATH.test(url.pathname)) return null
  const base = `https://${url.hostname}${url.pathname}`
  const id = url.searchParams.get('id')
  return id !== null && SNAPSHOT_ID.test(id) ? `${base}?id=${id}` : base
}

/** PURE. The public Ad Library page for an ad, which needs no token, or null for a non-numeric id. */
export function publicAdLibraryUrl(adArchiveId: unknown): string | null {
  if (typeof adArchiveId !== 'string' || !/^\d{1,30}$/.test(adArchiveId)) return null
  return `https://www.facebook.com/ads/library/?id=${adArchiveId}`
}
