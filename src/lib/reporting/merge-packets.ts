import type { ReportingData, ReportingPacket, ReportingSectionName } from './contracts'
import { validateReportingPacket } from './validation'
import { compareCreativeEvidenceInstants as compareInstants } from './creative-assignment-contract'

export const REPORT_SOURCES = ['meta', 'business', 'website', 'measurement'] as const
type Packets = Partial<Record<ReportingSectionName, ReportingPacket>>
const loading = { state: 'loading' as const, data: null, asOf: null, notes: [] }
export function mergeReportingPackets(packets: Packets): ReportingData | null {
  const first = REPORT_SOURCES.flatMap(section => packets[section] ? [packets[section]!] : [])[0]
  if (!first) return null
  let asOf = first.context.asOf
  for (const [source, packet] of Object.entries(packets)) {
    if (!packet) continue
    validateReportingPacket(packet)
    if (packet.section !== source) throw new Error('Source report identity does not match.')
    if (JSON.stringify([packet.context.account.id, packet.context.account.metaAccountId, packet.context.range, packet.context.comparison, packet.context.timezone, packet.context.currency])
      !== JSON.stringify([first.context.account.id, first.context.account.metaAccountId, first.context.range, first.context.comparison, first.context.timezone, first.context.currency])) throw new Error('Source report contexts do not match.')
    if (packet.result.asOf && compareInstants(packet.result.asOf, packet.context.asOf) > 0) throw new Error('Source observation exceeds its packet cutoff.')
    if (compareInstants(packet.context.asOf, asOf) > 0) asOf = packet.context.asOf
  }
  const meta = packets.meta
  const business = packets.business
  const website = packets.website
  const measurement = packets.measurement
  return { context: { ...first.context, asOf }, meta: meta?.section === 'meta' ? meta.result : loading,
    business: business?.section === 'business' ? business.result : loading,
    website: website?.section === 'website' ? website.result : loading,
    measurement: measurement?.section === 'measurement' ? measurement.result : loading }
}
