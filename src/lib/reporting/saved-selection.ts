import type { ReportingPacket, ReportingSectionName } from './contracts'
import { SAVED_SOURCES, type SavedReportReceipt, type SavedReportSources, type SavedSourceBinding } from './saved-contract'

export interface ReportingSaveState {
  packets: Partial<Record<ReportingSectionName, ReportingPacket>>
  receipts: Partial<Record<ReportingSectionName, SavedReportReceipt | null>>
  pending: Partial<Record<ReportingSectionName, boolean>>
  errors: Partial<Record<ReportingSectionName, string>>
  failures: Partial<Record<ReportingSectionName, 'source_unavailable' | 'invalid_report'>>
}
export function savedReportingSelection(state: ReportingSaveState): { sources: SavedReportSources | null; reason: string | null } {
  const bindings: Partial<SavedReportSources> = {}
  let snapshots = 0
  for (const source of SAVED_SOURCES) {
    const packet = state.packets[source], receipt = state.receipts[source]
    let binding: SavedSourceBinding
    if (packet?.result.data && receipt) {
      snapshots++
      binding = state.errors[source] || state.pending[source]
        ? { state: 'retained_snapshot', receipt, code: state.errors[source] ? 'refresh_failed' : 'refreshing' }
        : { state: 'snapshot', receipt }
    } else if (state.pending[source]) return { sources: null, reason: 'Saving will be available when the displayed sources finish loading.' }
    else if (packet?.result.data) return { sources: null, reason: 'Exact saving is unavailable for this report. You can still inspect, export and print these results.' }
    else binding = state.errors[source] || packet
      ? { state: 'unavailable', code: state.failures[source] ?? 'source_unavailable', context: packet?.context ?? null }
      : { state: 'missing', code: 'not_supplied', context: null }
    bindings[source] = binding
  }
  return snapshots ? { sources: bindings as SavedReportSources, reason: null }
    : { sources: null, reason: 'Load reporting evidence before saving a report.' }
}
