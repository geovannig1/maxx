import { makeReportingSnapshotScope, readReportingHistoryEntity } from './snapshot-scope'
import { validateScopedReportingPacket } from './packet-scope'
import { ReportingPacketSchema, type ReportingPacket, type ReportingSectionName } from './contracts'
import { previousReportingRange, resolveReportingRange } from './range'
import { REPORTING_REQUEST_TIMEOUT_MS, ReportingDeadlineError, withReportingDeadline } from './deadline'
import { ReportingRequestError } from './request-error'
import { REPORTING_STREAM_TYPE } from './stream-contract'
import { hasPendingBusinessIntelligence } from './business-progress'
import { readReportingStream } from './stream-reader'
import { REPORTING_PREPARED_TYPE } from './prepared-contract'
import { readStoredReportingPacket } from './packet-format'
import { readPreparedReporting } from './prepared-reader'
import { checkReportingResponse } from './response-status'
import type { ReportingEvidenceDelivery } from './saved-delivery'

export { ReportingRequestError } from './request-error'

export async function requestReportingPacket(
  section: ReportingSectionName, key: string, signal: AbortSignal, refresh = false,
  onProgress?: (packet: ReportingPacket) => void,
  onEvidence?: (delivery: ReportingEvidenceDelivery) => void,
): Promise<ReportingPacket> {
  try {
    return await withReportingDeadline(async requestSignal => {
      const params = new URLSearchParams(key)
      const detailIds = (params.get('details') ?? '').split(',').filter(Boolean)
      let historyEntity
      try { historyEntity = readReportingHistoryEntity(params, section, detailIds) }
      catch { throw new ReportingRequestError('Choose one valid campaign or ad set for history.', 'invalid') }
      const response = await fetch(`/api/reporting?${key}&section=${section}${refresh ? '&refresh=1' : ''}`, {
        cache: 'no-store', signal: requestSignal,
        headers: { Accept: `${REPORTING_PREPARED_TYPE}, ${section === 'meta' || section === 'business' ? `${REPORTING_STREAM_TYPE}, ` : ''}application/json` },
      })
      checkReportingResponse(response)
      if (response.headers.get('content-type')?.split(';')[0].trim() === REPORTING_PREPARED_TYPE) {
        return readPreparedReporting(response, section, key, requestSignal, refresh, onProgress, onEvidence)
      }
      const range = resolveReportingRange({ from: params.get('from') ?? '', to: params.get('to') ?? '' })
      const comparison = previousReportingRange({ from: range.from, to: range.to })
      const validate = (packet: ReportingPacket) => {
        if (packet.result.state === 'loading') throw new ReportingRequestError('This source returned an unfinished report. Retry this source.', 'invalid')
        if (packet.section !== section || packet.context.range.from !== range.from || packet.context.range.to !== range.to
          || packet.context.comparison.from !== comparison.from || packet.context.comparison.to !== comparison.to) {
          throw new ReportingRequestError('The source returned a different source or period. Retry this source.', 'invalid')
        }
        if (historyEntity && packet.result.data) {
          try { return validateScopedReportingPacket(packet, makeReportingSnapshotScope(section, packet.context, {
            requestedRange: { from: params.get('from') ?? '', to: params.get('to') ?? '' }, historyEntity,
          }), new Date().toISOString()) }
          catch { throw new ReportingRequestError('This source returned history for a different selection. Retry this source.', 'invalid') }
        }
        return packet
      }
      if (response.headers.get('content-type')?.split(';')[0].trim() === REPORTING_STREAM_TYPE) {
        return readReportingStream(response, requestSignal, validate, packet => {
          onEvidence?.({ packet, receipt: null }); onProgress?.(packet)
        })
      }
      let packet: ReportingPacket
      try { packet = ReportingPacketSchema.parse(readStoredReportingPacket(await response.json())) }
      catch { throw new ReportingRequestError('This source returned an invalid report. Retry this source.', 'invalid') }
      if (packet.section === 'meta' && packet.result.data?.detailState === 'loading'
        || packet.section === 'business' && hasPendingBusinessIntelligence(packet.result.data)) {
        throw new ReportingRequestError('This source returned unfinished report details. Retry this source.', 'invalid')
      }
      const result = validate(packet)
      onEvidence?.({ packet: result, receipt: null })
      return result
    }, REPORTING_REQUEST_TIMEOUT_MS, signal)
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof ReportingRequestError) throw error
    throw new ReportingRequestError(error instanceof ReportingDeadlineError
      ? 'This reporting source took too long. Retry this source; other results remain available.'
      : 'This reporting source could not be reached. Retry this source.', 'transient')
  }
}
