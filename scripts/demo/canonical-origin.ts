// The demo has one origin: http://127.0.0.1:<port>. The app's same-origin check compares a mutation's
// Origin with APP_URL, which is that origin, so a page opened at http://localhost:<port> (or any other
// name for the gateway) could read but every save was refused. The gateway sends those requests to the
// canonical origin instead; the app's same-origin rule itself is unchanged.

export interface CanonicalOriginReply {
  status: number
  headers: Record<string, string>
  body: string
}

/** The gateway's reply for a request whose Host is not the canonical origin, or null to serve it. Pages
 *  (GET/HEAD) are redirected to the same path there; any other method is refused, never redirected. */
export function canonicalOriginReply(request: { method: string; url: string; host: string | undefined }, port: number): CanonicalOriginReply | null {
  const canonical = `127.0.0.1:${port}`
  if (request.host === canonical) return null
  const origin = `http://${canonical}`
  // Only an origin-form target ("/path?query") is kept: "//host/x" would make the Location another site.
  const target = request.url.startsWith('/') && !request.url.startsWith('//') ? request.url : '/'
  if (request.method === 'GET' || request.method === 'HEAD') {
    return { status: 307, headers: { Location: `${origin}${target}`, 'Cache-Control': 'no-store' }, body: '' }
  }
  return {
    status: 421,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify({ error: `Open the demo at ${origin}; requests to another host name are refused.` }),
  }
}
