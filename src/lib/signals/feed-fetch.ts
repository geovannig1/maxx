import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isPublicAddress } from '@/lib/security/public-address'

/**
 * Fetch a third-party feed while keeping every hop on public https.
 *
 * `fetch(..., { redirect: 'follow' })` would follow a 302 from a compromised feed host to http://,
 * to localhost or to a cloud metadata address, and whatever came back would be parsed as feed items
 * and shown to the owner. Redirects are therefore followed by hand: each hop must be https, must not
 * be an IP literal or a local/internal name, must resolve only to public addresses, and the chain is
 * capped.
 *
 * DNS rebinding: each hop's name is resolved exactly once. The connection is pinned to the first
 * checked address through the socket `lookup` hook, so a DNS answer that changes between the check
 * and the connection is never consulted. TLS still verifies the certificate and sends SNI for the
 * hostname. The global fetch is not used because it resolves the name again.
 */
export const MAX_FEED_REDIRECTS = 3

export type FeedLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>

/** The address a hop's connection must use: one that passed isPublicAddress. */
export interface PinnedAddress {
  address: string
  family: 4 | 6
}

/** Sends one request (no redirect following) over a connection to `pinned`. */
export type FeedTransport = (url: string, init: RequestInit, pinned: PinnedAddress) => Promise<Response>

interface FetchPublicHttpsOptions {
  maxRedirects?: number
  lookup?: FeedLookup
  transport?: FeedTransport
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true, verbatim: true })
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])
const LOCAL_NAME_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.arpa']

export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`feed URL is not absolute: ${raw.slice(0, 120)}`)
  }
  if (url.protocol !== 'https:') throw new Error(`feed URL must be https: ${url.protocol}//${url.host}`)
  if (url.username || url.password) throw new Error('feed URL must not carry credentials')
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.startsWith('[') || /^[0-9.]+$/.test(host) || host.includes(':')) {
    throw new Error(`feed host must be a public DNS name, not an address or localhost: ${host}`)
  }
  if (!host.includes('.') || LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`feed host must be a public DNS name: ${host}`)
  }
  return url
}

/** Resolves the hop once; every answer must be public, and the first one is the one connected to. */
async function resolvePinnedAddress(url: URL, lookup: FeedLookup): Promise<PinnedAddress> {
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(url.hostname)
  } catch {
    addresses = []
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error(`feed host did not resolve exclusively to a public address: ${url.hostname}`)
  }
  const [{ address, family }] = addresses
  return { address, family: family === 6 ? 6 : 4 }
}

function pinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }])
    else callback(null, pinned.address, pinned.family)
  }
}

function decodedBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress()
        : null
  // pipeline (not pipe) so a socket or decompression error errors the body instead of hanging it.
  return decoder ? pipeline(res, decoder, () => undefined) : res
}

function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 0
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  if (NULL_BODY_STATUSES.has(status)) {
    res.resume()
    return new Response(null, { status, statusText: res.statusMessage, headers })
  }
  const body = decodedBody(res)
  if (body !== res) {
    headers.delete('content-encoding')
    headers.delete('content-length')
  }
  const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>
  return new Response(stream, { status, statusText: res.statusMessage, headers })
}

/**
 * The default transport: one HTTPS request whose socket connects to `pinned` (never re-resolving the
 * hostname), with the hostname kept for certificate verification and SNI. No connection pooling, so a
 * socket opened for an earlier hop or call is never reused. Redirects are returned, not followed.
 */
export function pinnedHttpsTransport(raw: string, init: RequestInit, pinned: PinnedAddress): Promise<Response> {
  if (init.body !== undefined && init.body !== null) {
    return Promise.reject(new Error('feed transport does not send a request body'))
  }
  const url = new URL(raw)
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  headers['accept-encoding'] ??= 'gzip, deflate, br'
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      servername: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: init.method ?? 'GET',
      headers,
      lookup: pinnedLookup(pinned),
      agent: false,
      signal: init.signal ?? undefined,
    }, (res) => resolve(toResponse(res)))
    req.on('error', reject)
    req.end()
  })
}

export async function fetchPublicHttps(
  raw: string,
  init: RequestInit = {},
  options: FetchPublicHttpsOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MAX_FEED_REDIRECTS
  const lookup = options.lookup ?? defaultLookup
  const transport = options.transport ?? pinnedHttpsTransport
  let current = assertPublicHttpsUrl(raw)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await resolvePinnedAddress(current, lookup)
    const response = await transport(current.toString(), { ...init, redirect: 'manual' }, pinned)
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new Error(`redirect without a Location header from ${current.host}`)
    current = assertPublicHttpsUrl(new URL(location, current).toString())
  }
  throw new Error(`more than ${maxRedirects} redirects from ${raw.slice(0, 120)}`)
}
