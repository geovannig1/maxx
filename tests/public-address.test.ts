import { describe, expect, it } from 'vitest'
import { isPublicAddress } from '@/lib/security/public-address'

// isPublicAddress guards every server-side fetch of an untrusted URL (feed-fetch.ts,
// trusted-meta-image.ts). An address that reaches loopback, metadata, private or special-purpose space
// through an alternative spelling (hex IPv4-mapped, IPv4-compatible, NAT64, 6to4) must not pass.

const NOT_PUBLIC: [string, string][] = [
  // Embedded IPv4 forms the old prefix matcher let through
  ['::ffff:a9fe:a9fe', '169.254.169.254 as hex IPv4-mapped'],
  ['::ffff:7f00:1', '127.0.0.1 as hex IPv4-mapped'],
  ['::7f00:1', '127.0.0.1 as IPv4-compatible'],
  ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
  ['64:ff9b::a9fe:a9fe', 'NAT64 of 169.254.169.254'],
  ['64:ff9b::10.0.0.1', 'NAT64 of 10.0.0.1, dotted tail'],
  ['64:ff9b:1::808:808', 'local-use NAT64 prefix (RFC 8215, not globally reachable)'],
  ['2002:7f00:1::', '6to4 of 127.0.0.1'],
  ['2002:a9fe:a9fe::1', '6to4 of 169.254.169.254'],
  ['2002:c0a8:101::', '6to4 of 192.168.1.1'],
  ['::ffff:127.0.0.1', 'dotted IPv4-mapped loopback'],
  ['::ffff:10.0.0.1', 'dotted IPv4-mapped private'],
  ['::ffff:0:7f00:1', 'IPv4-translated (SIIT) form'],
  ['fec0::1', 'site-local'],
  ['100::1', 'discard-only'],
  ['192.88.99.1', '6to4 relay anycast'],
  // IPv4 special-purpose ranges
  ['0.0.0.0', 'this network'],
  ['0.1.2.3', 'this network'],
  ['10.0.0.1', 'private'],
  ['100.64.0.1', 'shared address space'],
  ['100.127.255.254', 'shared address space upper edge'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.255', 'loopback upper edge'],
  ['169.254.169.254', 'link-local / cloud metadata'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private upper edge'],
  ['192.0.0.1', 'IETF protocol assignments'],
  ['192.0.2.1', 'TEST-NET-1'],
  ['192.168.1.1', 'private'],
  ['198.18.0.1', 'benchmarking'],
  ['198.19.255.255', 'benchmarking upper edge'],
  ['198.51.100.1', 'TEST-NET-2'],
  ['203.0.113.1', 'TEST-NET-3'],
  ['224.0.0.1', 'multicast'],
  ['239.255.255.255', 'multicast upper edge'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'limited broadcast'],
  // IPv6 special-purpose ranges
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback, uncompressed'],
  ['fc00::1', 'unique local'],
  ['fd12:3456::1', 'unique local'],
  ['fe80::1', 'link-local'],
  ['fe80::1%eth0', 'link-local with zone'],
  ['febf::1', 'link-local upper edge'],
  ['ff02::1', 'multicast'],
  ['2001:db8::1', 'documentation'],
  ['2001:0db8:ffff::1', 'documentation'],
  ['3fff::1', 'documentation (RFC 9637)'],
  ['2001::1', 'Teredo (inside 2001::/23)'],
  ['2001:2::1', 'benchmarking (inside 2001::/23)'],
  ['2001:1ff::1', '2001::/23 upper edge'],
  ['5f00::1', 'SRv6 SIDs (outside global unicast)'],
  ['4000::1', 'unallocated (outside 2000::/3)'],
  // Invalid input
  ['', 'empty'],
  ['localhost', 'name'],
  ['example.com', 'name'],
  ['1.2.3', 'short IPv4'],
  ['1.2.3.256', 'out-of-range octet'],
  ['0x7f.0.0.1', 'hex octet'],
  ['127.1', 'shorthand IPv4'],
  ['::ffff:999.0.0.1', 'bad embedded IPv4'],
  ['1::2::3', 'two compressions'],
  ['[::1]', 'bracketed'],
]

const PUBLIC: [string, string][] = [
  ['8.8.8.8', 'Google DNS'],
  ['1.1.1.1', 'Cloudflare DNS'],
  ['93.184.216.34', 'public IPv4'],
  ['192.0.1.1', 'public IPv4 next to 192.0.0/24'],
  ['192.0.78.24', 'public IPv4 inside 192.0/16 but outside its special /24s'],
  ['203.0.114.1', 'public IPv4 next to TEST-NET-3'],
  ['198.20.0.1', 'public IPv4 next to benchmarking'],
  ['100.128.0.1', 'public IPv4 next to shared space'],
  ['172.32.0.1', 'public IPv4 next to 172.16/12'],
  ['2606:4700:4700::1111', 'Cloudflare DNS IPv6'],
  ['2001:4860:4860::8888', 'Google DNS IPv6 (outside 2001::/23)'],
  ['2a03:2880:f12f:83:face:b00c:0:25de', 'Meta IPv6'],
  ['::ffff:8.8.8.8', 'IPv4-mapped public'],
  ['::ffff:808:808', 'hex IPv4-mapped public'],
  ['64:ff9b::808:808', 'NAT64 of a public address'],
  ['2002:808:808::1', '6to4 of a public address'],
]

describe('isPublicAddress', () => {
  it.each(NOT_PUBLIC)('rejects %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(PUBLIC)('control: accepts %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})
