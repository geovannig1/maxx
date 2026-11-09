'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { useGlobalControls } from '@/lib/use-global-controls'
import { META_DETAILS_LOADING_NOTE, type ReportingPacket, type ReportingSectionName } from './contracts'
import { ReportingRequestError, requestReportingPacket } from './request-packet'
import { SAVED_SOURCE_MESSAGES, type SavedReportReceipt } from './saved-contract'
import { savedReportingSelection } from './saved-selection'
import { assembleSavedReportData } from './saved-assembly'
import { useSavedReport } from './use-saved-report'

import { REPORT_SOURCES, mergeReportingPackets } from './merge-packets'
import { META_DIMENSION_KEYS, type MetaDimension } from './meta-breakdowns'
export { REPORT_SOURCES, mergeReportingPackets } from './merge-packets'
type Packets = Partial<Record<ReportingSectionName, ReportingPacket>>

interface LoadState {
  key: string
  packets: Packets
  errors: Partial<Record<ReportingSectionName, string>>
  pending: Partial<Record<ReportingSectionName, boolean>>
  accessDenied: boolean
  receipts: Partial<Record<ReportingSectionName, SavedReportReceipt | null>>
  failures: Partial<Record<ReportingSectionName, 'source_unavailable' | 'invalid_report'>>
}
function emptyState(key: string): LoadState { return { key, packets: {}, errors: {}, pending: {}, receipts: {}, failures: {}, accessDenied: false } }
function endedProgress(packet?: ReportingPacket): ReportingPacket | undefined {
  if (packet?.section !== 'meta' || packet.result.data?.detailState !== 'loading') return packet
  return { ...packet, result: { ...packet.result,
    data: { ...packet.result.data, detailState: 'unavailable' },
    notes: packet.result.notes.filter(note => note !== META_DETAILS_LOADING_NOTE),
  } }
}
export function useReportingData() {
  const { range, ready } = useGlobalControls()
  const search = useSearchParams()
  const pathname = usePathname()
  const savedId = search.get('saved')
  const savedReport = useSavedReport(savedId)
  // Preserve malformed explicit dates for server validation instead of silently replacing them.
  const explicit = search.has('from') || search.has('to')
  const from = explicit ? search.get('from') ?? '' : range.from
  const to = explicit ? search.get('to') ?? '' : range.to
  // Comparison uses the complete period metrics already returned for every ad.
  // History is scoped to one parent or the requested individual ad.
  const details = search.get('ad')
  const level = search.get('level')
  const requestedBreakdown = search.get('breakdown')
  const breakdown = META_DIMENSION_KEYS.includes(requestedBreakdown as MetaDimension) ? requestedBreakdown as MetaDimension : undefined
  const historyEntity = pathname === '/performance' && search.get('view') === 'detail' && (level === 'campaign' || level === 'adset')
    ? { level, id: search.get(level === 'campaign' ? 'campaign' : 'adset') ?? '', ...(breakdown ? { breakdown } : {}) } : undefined
  const key = ready && savedId === null ? new URLSearchParams({ from, to, ...(details ? { details } : {}),
    ...(historyEntity ? { historyEntity: JSON.stringify(historyEntity) } : {}),
  }).toString() : ''
  const [state, setState] = useState<LoadState>(() => emptyState(''))
  const generation = useRef(0)
  const controllers = useRef(new Map<ReportingSectionName, AbortController>())
  const request = useCallback(async (section: ReportingSectionName, requestKey: string, token: number, refresh = false) => {
    controllers.current.get(section)?.abort()
    const controller = new AbortController()
    controllers.current.set(section, controller)
    const current = () => !controller.signal.aborted && generation.current === token && controllers.current.get(section) === controller
    setState(previous => previous.key === requestKey && current()
      ? { ...previous, pending: { ...previous.pending, [section]: true }, errors: { ...previous.errors, [section]: undefined } } : previous)
    const receive = (packet: ReportingPacket, complete: boolean, receipt: SavedReportReceipt | null) => {
      setState(previous => {
        if (previous.key !== requestKey || !current()) return previous
        const pending = { ...previous.pending, [section]: !complete }
        const packets = { ...previous.packets, [section]: packet }
        try { mergeReportingPackets(packets) } catch {
          return { ...previous, pending, packets: { ...previous.packets, [section]: undefined },
            receipts: { ...previous.receipts, [section]: null }, failures: { ...previous.failures, [section]: 'invalid_report' },
            errors: { ...previous.errors, [section]: 'The source returned a different account or period. Refresh the report.' } }
        }
        // A refresh's initial totals must not erase a matching complete report's
        // creative/configuration detail while its replacement is still loading.
        if (!complete && previous.packets[section]?.result.data) return { ...previous, pending }
        const prior = previous.packets[section]
        if (packet.section === 'meta' && packet.result.data?.detailState === 'unavailable'
          && prior?.section === 'meta' && prior.result.data && !['loading', 'unavailable'].includes(prior.result.data.detailState ?? 'complete')) {
          return { ...previous, pending, errors: { ...previous.errors,
            [section]: 'Meta details could not refresh. The previous complete report remains visible with its original as-of time.',
          } }
        }
        if (packet.result.state === 'unavailable' && previous.packets[section]?.result.data) {
          return { ...previous, pending, errors: { ...previous.errors, [section]: 'The refresh returned no usable data. The previous report remains visible.' } }
        }
        return { ...previous, packets, pending, accessDenied: false, receipts: { ...previous.receipts, [section]: receipt },
          failures: { ...previous.failures, [section]: undefined }, errors: { ...previous.errors, [section]: undefined } }
      })
    }
    try {
      let receipt: SavedReportReceipt | null = null
      const sourceParams = new URLSearchParams(requestKey)
      if (section !== 'meta') sourceParams.delete('historyEntity')
      const packet = await requestReportingPacket(section, sourceParams.toString(), controller.signal, refresh, undefined, delivery => {
        receipt = delivery.receipt
        receive(delivery.packet, false, receipt)
      })
      receive(packet, true, receipt)
    } catch (error) {
      if (!current()) return
      const failure = error instanceof ReportingRequestError ? error : new ReportingRequestError('This source could not load. Retry this source.', 'transient')
      if (failure.kind === 'access') {
        const deniedGeneration = ++generation.current
        for (const active of controllers.current.values()) active.abort()
        setState(previous => previous.key === requestKey && generation.current === deniedGeneration ? {
          ...emptyState(requestKey), accessDenied: true,
          errors: Object.fromEntries(REPORT_SOURCES.map(source => [source, failure.message])),
        } : previous)
        return
      }
      setState(previous => previous.key === requestKey && current() ? {
        ...previous, pending: { ...previous.pending, [section]: false },
        packets: failure.kind === 'invalid' ? { ...previous.packets, [section]: undefined }
          : { ...previous.packets, [section]: endedProgress(previous.packets[section]) },
        receipts: failure.kind === 'invalid' ? { ...previous.receipts, [section]: null } : previous.receipts,
        failures: { ...previous.failures, [section]: failure.kind === 'invalid' ? 'invalid_report' : 'source_unavailable' },
        errors: { ...previous.errors, [section]: failure.message },
      } : previous)
    }
  }, [])
  useEffect(() => {
    const token = ++generation.current
    const activeControllers = controllers.current
    void Promise.resolve().then(() => {
      if (generation.current !== token || !key) return
      setState(emptyState(key))
      for (const section of REPORT_SOURCES) void request(section, key, token)
    })
    return () => { for (const controller of activeControllers.values()) controller.abort() }
  }, [key, request])
  const retry = useCallback((section: ReportingSectionName) => {
    if (!key) return
    void request(section, key, generation.current, true)
  }, [key, request])
  const retryAll = useCallback(() => { for (const section of REPORT_SOURCES) retry(section) }, [retry])
  const visible = useMemo(() => state.key === key ? state : emptyState(key), [state, key])
  const selection = useMemo(() => savedReportingSelection(visible), [visible])
  const data = useMemo(() => {
    const merged = mergeReportingPackets(visible.packets)
    if (!merged) return null
    if (selection.sources) return assembleSavedReportData(visible.packets, selection.sources)
    return REPORT_SOURCES.reduce((current, section) => !visible.packets[section]?.result.data && (visible.errors[section] || visible.packets[section])
      ? { ...current, [section]: { state: 'unavailable', data: null, asOf: null,
        notes: [SAVED_SOURCE_MESSAGES[visible.failures[section] ?? 'source_unavailable']] } } : current, merged)
  }, [visible, selection])
  if (savedId !== null) return { data: savedReport.value?.data ?? null,
    errors: savedReport.error ? Object.fromEntries(REPORT_SOURCES.map(source => [source, savedReport.error!])) : {},
    pending: Object.fromEntries(REPORT_SOURCES.map(source => [source, savedReport.loading])), accessDenied: savedReport.denied,
    retry: () => {}, retryAll: () => {}, ready: !savedReport.loading, notes: savedReport.value?.notes ?? [], sources: null, saveReason: null,
    saved: savedReport.value ?? null, savedId, savedError: savedReport.error }
  return { data, errors: visible.errors, pending: visible.pending, accessDenied: visible.accessDenied, retry, retryAll, ready,
    notes: [...new Set(REPORT_SOURCES.flatMap(source => !selection.sources || 'receipt' in selection.sources[source]
      ? visible.packets[source]?.notes ?? [] : []))],
    sources: selection.sources, saveReason: selection.reason, saved: null, savedId: null, savedError: null }
}
