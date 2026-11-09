import { BlockList, isIP } from 'node:net'

/**
 * Public-address classification for server-side fetches of untrusted URLs (feed-fetch.ts,
 * trusted-meta-image.ts). Addresses are parsed to numbers, never matched as text: an IPv6 spelling
 * such as `::ffff:a9fe:a9fe` or `2002:7f00:1::` carries an IPv4 address (169.254.169.254, 127.0.0.1)
 * that a prefix matcher does not see, so every IPv4-embedding form is decoded and the embedded
 * address is what gets classified.
 *
 * Sources: the IANA IPv4 and IPv6 Special-Purpose Address Registries. IPv6 is fail-closed: only the
 * global unicast block 2000::/3 can be public, so unallocated and future special space is rejected
 * without being listed. 2001::/23 is rejected whole even though IANA marks a few anycast/ORCHIDv2
 * entries inside it globally reachable; no fetch target of this app lives there.
 */

function blockList(family: 'ipv4' | 'ipv6', subnets: [string, number][]): BlockList {
  const list = new BlockList()
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family)
  return list
}

const IPV4_NOT_PUBLIC = blockList('ipv4', [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
])

const IPV6_GLOBAL_UNICAST = blockList('ipv6', [['2000::', 3]])

const IPV6_NOT_PUBLIC_IN_GLOBAL_UNICAST = blockList('ipv6', [
  ['2001::', 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID, ...)
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
])

const IPV6_GROUP = /^[0-9a-f]{1,4}$/i

function parseGroups(part: string): number[] | null {
  if (part === '') return []
  const groups = part.split(':')
  if (!groups.every((group) => IPV6_GROUP.test(group))) return null
  return groups.map((group) => parseInt(group, 16))
}

/** The eight 16-bit groups of an IPv6 literal (zone already stripped), or null when it does not parse. */
function ipv6Groups(address: string): number[] | null {
  let text = address
  const tail: number[] = []
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    if (isIP(dotted[2]) !== 4) return null
    const [a, b, c, d] = dotted[2].split('.').map(Number)
    tail.push((a << 8) | b, (c << 8) | d)
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = parseGroups(halves[0])
  const rest = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!head || !rest) return null
  const explicit = head.length + rest.length + tail.length
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null
  return [...head, ...new Array<number>(8 - explicit).fill(0), ...rest, ...tail]
}

function ipv4From(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

function isPublicIpv4(address: string): boolean {
  return !IPV4_NOT_PUBLIC.check(address, 'ipv4')
}

type Embedding = { ipv4: string } | 'not-public' | null

/** The IPv4 address an IPv6 form carries, 'not-public' for a non-public embedding prefix, or null. */
function embeddedIpv4(g: number[]): Embedding {
  if (g.slice(0, 5).every((group) => group === 0)) {
    if (g[5] === 0xffff) return { ipv4: ipv4From(g[6], g[7]) } // IPv4-mapped ::ffff:0:0/96
    if (g[5] !== 0) return 'not-public' // any other ::/80 form, e.g. SIIT ::ffff:0:0:0/96
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return 'not-public' // :: unspecified, ::1 loopback
    return { ipv4: ipv4From(g[6], g[7]) } // IPv4-compatible ::/96 (deprecated)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g.slice(2, 6).every((group) => group === 0)) return { ipv4: ipv4From(g[6], g[7]) } // 64:ff9b::/96
    if (g[2] === 1) return 'not-public' // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
  }
  if (g[0] === 0x2002) return { ipv4: ipv4From(g[1], g[2]) } // 6to4 2002::/16
  return null
}

function isPublicIpv6(address: string): boolean {
  const withoutZone = address.split('%')[0]
  const groups = ipv6Groups(withoutZone)
  if (!groups) return false
  const embedded = embeddedIpv4(groups)
  if (embedded === 'not-public') return false
  if (embedded) return isPublicIpv4(embedded.ipv4)
  return IPV6_GLOBAL_UNICAST.check(withoutZone, 'ipv6')
    && !IPV6_NOT_PUBLIC_IN_GLOBAL_UNICAST.check(withoutZone, 'ipv6')
}

/**
 * True only for an IP literal outside every private, loopback, link-local, shared, documentation,
 * benchmarking, multicast and reserved range, including those reached through an IPv4-embedding IPv6
 * form. Shared by every server-side fetch of an untrusted URL so the range list has one definition.
 * A non-IP string is not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}
