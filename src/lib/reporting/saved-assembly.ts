import type { ReportingData, ReportingPacket, ReportingSectionName } from './contracts'
import { mergeReportingPackets } from './merge-packets'
import { SAVED_SOURCES, SAVED_SOURCE_MESSAGES, SavedReportError, type SavedReportSources } from './saved-contract'

/** Only unbacked source prose is normalized. Snapshot result notes and claims stay exact. */
export function assembleSavedReportData(
  packets: Partial<Record<ReportingSectionName, ReportingPacket>>, sources: SavedReportSources,
): ReportingData {
  const backed = mergeReportingPackets(packets)
  if (!backed) throw new SavedReportError('invalid')
  const members = { ...packets }
  for (const source of SAVED_SOURCES) {
    const binding = sources[source]
    if (binding.state === 'snapshot' || binding.state === 'retained_snapshot') continue
    members[source] = { section: source, context: binding.context ?? backed.context, notes: [],
      result: { state: 'unavailable', data: null, asOf: null, notes: [SAVED_SOURCE_MESSAGES[binding.code]] } } as ReportingPacket
  }
  return mergeReportingPackets(members)!
}
