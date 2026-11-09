// Client address for rate limiting (never for authentication: forwarding headers are client-controlled
// unless a proxy you run overwrites them).

/**
 * The rate-limit bucket for a client address. An IPv6 client usually controls a whole /64 (its
 * interface ids rotate freely), so IPv6 addresses are bucketed by their /64 prefix; IPv4 addresses
 * (with any port removed) are used as they are. Anything unparseable is used verbatim.
 */
export function rateLimitAddress(raw: string): string {
  let address = raw.trim().toLowerCase()
  if (address.startsWith('[')) {
    const end = address.indexOf(']')
    address = address.slice(1, end > 0 ? end : undefined)
  }
  const zone = address.indexOf('%')
  if (zone >= 0) address = address.slice(0, zone)
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) return address.slice(0, address.lastIndexOf(':'))
  if (!address.includes(':')) return address
  // IPv4-mapped/compatible (::ffff:192.0.2.1): the IPv4 address is the client.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address)
  if (dotted) return dotted[1]
  const halves = address.split('::')
  if (halves.length > 2) return address
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return address
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return address
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * The client address for a rate-limit key. X-Forwarded-For is a client-appended list; a proxy that
 * APPENDS leaves the first hop under the caller's control, so it is read from the RIGHT: the entry
 * added by the nearest trusted proxy. PAID_TOUCH_TRUSTED_PROXY_HOPS (default 1) says how many trailing
 * entries belong to infrastructure you control (Vercel overwrites the header with one entry). Only
 * when X-Forwarded-For is absent is X-Real-IP read, then one shared 'unavailable' bucket.
 */
export function clientAddress(req: Request, env: Record<string, string | undefined> = process.env): string {
  const hops = Number.parseInt(env.PAID_TOUCH_TRUSTED_PROXY_HOPS ?? '1', 10)
  const trusted = Number.isSafeInteger(hops) && hops >= 1 ? hops : 1
  const entries = (req.headers.get('x-forwarded-for') ?? '').split(',').map((v) => v.trim()).filter(Boolean)
  const fromForwarded = entries.length > 0 ? entries[Math.max(0, entries.length - trusted)] : undefined
  return rateLimitAddress(fromForwarded || req.headers.get('x-real-ip')?.trim() || 'unavailable')
}
