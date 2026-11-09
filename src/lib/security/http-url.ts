import { isIP } from 'node:net'
import { isPublicAddress } from '@/lib/security/public-address'
import { safeHref } from '@/lib/ui/safe-href'

/** Long enough for any real site URL with tracking parameters; short enough to keep rows bounded. */
export const MAX_STORED_URL_LENGTH = 2_048

export type StoredUrlResult = { ok: true; value: string | null } | { ok: false }

/**
 * A bare hostname with at least one dot and an alphabetic TLD, optionally followed by a path, query or
 * fragment. No scheme, port, userinfo or leading slash can match, so "javascript:", "//x" and "/x"
 * never take this path.
 */
const BARE_HOST_URL = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?:[/?#]\S*)?$/i

/** Special-use and private-use names that never resolve to a public site (RFC 6761, 6762, ICANN .internal). */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|internal)$/

/**
 * True when the parsed URL carries credentials or names a local or non-public host. The WHATWG parser
 * has already lower-cased the host and normalized IPv4 spellings such as `2130706433` and `127.1` to
 * dotted form, so the literal check sees the real address.
 */
function hasCredentialsOrNonPublicHost(url: URL): boolean {
  if (url.username || url.password) return true
  const host = url.hostname.replace(/\.$/, '')
  if (LOCAL_NAME.test(host)) return true
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  return isIP(literal) !== 0 && !isPublicAddress(literal)
}

/**
 * Validate an owner-supplied URL before it is stored and later rendered as a link. Absent, null or
 * blank clears the field; anything else must be an absolute http(s) URL, or a bare hostname (stored as
 * https://), within the length bound. Uses the same rule as link rendering (safeHref), so whatever is
 * stored can be rendered. URLs with a username or password, and hosts that are local names or
 * non-public IP literals, are refused.
 */
export function parseStoredHttpUrl(value: unknown): StoredUrlResult {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  if (trimmed.length > MAX_STORED_URL_LENGTH) return { ok: false }
  const bareHost = BARE_HOST_URL.exec(trimmed)?.[1]
  const href = bareHost ? safeHref(`https://${trimmed}`) : safeHref(trimmed)
  if (!href || href.length > MAX_STORED_URL_LENGTH) return { ok: false }
  const url = new URL(href)
  // The prefixed form must still name the host that was typed.
  if (bareHost && url.hostname !== bareHost.toLowerCase()) return { ok: false }
  if (hasCredentialsOrNonPublicHost(url)) return { ok: false }
  return { ok: true, value: href }
}
