/**
 * Only absolute http(s) links from model-authored markdown become anchors. Everything else (javascript:,
 * data:, relative paths, malformed values) renders as plain text. Model output and the feeds it
 * summarizes are untrusted; a link in the owner's chat must never be a phishing vector.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null
  try {
    const url = new URL(href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.toString()
  } catch {
    return null
  }
}
