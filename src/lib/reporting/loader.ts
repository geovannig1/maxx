import { validateScopedReportingPacket } from './packet-scope'
import { makeReportingSnapshotScope, ReportingHistoryEntitySchema, type ReportingHistoryEntity } from './snapshot-scope'
import { validateReportingPacket } from './validation'
export { validateReportingPacket } from './validation'
import { getAdPlatform, requireCapability } from '@/lib/platforms/registry'
import type { ReportingReader } from '@/lib/platforms/types'
import { readBusinessReport } from './business-reader'
import { readWebsiteReport } from './website-reader'
import { readMeasurementReport } from './measurement-reader'
import { finishBusinessProgress, hasPendingBusinessIntelligence, hasUnavailableBusinessIntelligence } from './business-progress'
import { META_DETAILS_LOADING_NOTE, type BusinessReport, ReportingPacketSchema, type MetaReport, type ReportSection, type ReportingContext, type ReportingPacket, type ReportingSectionName } from './contracts'

// The Meta section is read through the ad-platform interface (its reporting capability).
const readMetaReport = (...args: Parameters<ReportingReader['readReport']>) =>
  requireCapability(getAdPlatform('meta'), 'reporting').readReport(...args)

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 24
const MAX_CACHE_BYTES = 24 * 1024 * 1024
const SOURCE_TIMEOUT_MS = 90_000
const cache = new Map<string, { expires: number; packet: ReportingPacket; bytes: number }>()
interface PendingReport {
  promise: Promise<ReportingPacket>
  subscribers: Set<(packet: ReportingPacket) => void>
  latest?: ReportingPacket
}
const inFlight = new Map<string, PendingReport>()

export function clearReportingCache(): void { cache.clear(); inFlight.clear() }

async function readSection(
  section: ReportingSectionName, context: ReportingContext, detailIds: string[], onProgress: (packet: ReportingPacket) => void, historyEntity?: ReportingHistoryEntity,
): Promise<ReportingPacket> {
  const validate = (raw: unknown) => {
    const packet = validateReportingPacket(raw)
    return historyEntity && packet.result.data
      ? validateScopedReportingPacket(packet, makeReportingSnapshotScope(section, context, { historyEntity }), new Date().toISOString())
      : packet
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let finished = false, timedOut = false
  const progress: { latest?: Extract<ReportingPacket, { section: 'meta' | 'business' }> } = {}
  const publish = (result: ReportSection<MetaReport> | ReportSection<BusinessReport>) => {
    if (finished) return
    try {
      const packet = validate({ context, section, result, notes: [] })
      if (!['meta', 'business'].includes(packet.section) || !packet.result.data || !['available', 'partial'].includes(packet.result.state)) return
      progress.latest = packet as Extract<ReportingPacket, { section: 'meta' | 'business' }>
      onProgress(packet)
    } catch { /* Invalid progress cannot reach observers or replace validated evidence. */ }
  }
  try {
    const read = section === 'meta' ? readMetaReport(context, { detailIds, onProgress: publish, ...(historyEntity ? { historyEntity } : {}) }) : section === 'business' ? readBusinessReport(context, { includeIntelligence: true, onProgress: publish })
      : section === 'measurement' ? readMeasurementReport(context) : readWebsiteReport(context)
    const result = await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { finished = true; timedOut = true; reject(new Error('Reporting source timeout')) }, SOURCE_TIMEOUT_MS)
    })])
    finished = true
    const packet = validate({ context, section, result, notes: [] })
    if (packet.section === 'business' && hasPendingBusinessIntelligence(packet.result.data)) {
      return validateReportingPacket({ ...packet, result: finishBusinessProgress(packet.result) })
    }
    return packet
  } catch {
    const latest = progress.latest
    if (latest?.section === 'business' && latest.result.data) return validateReportingPacket({ ...latest, result: finishBusinessProgress(latest.result,
      timedOut ? 'Business details timed out. Validated booking totals remain available; retry this source.' : undefined) })
    if (latest?.section === 'meta' && latest.result.data) return validateReportingPacket({ ...latest, result: {
      ...latest.result, state: 'partial', data: { ...latest.result.data, detailState: 'unavailable' },
      notes: [...latest.result.notes.filter(note => note !== META_DETAILS_LOADING_NOTE),
        timedOut ? 'Optional Meta details, configuration and trends timed out. Validated totals remain available; retry to load details.'
          : 'Optional Meta details, configuration and trends could not complete a validated report. Validated totals remain available; retry to load details.'],
    } })
    return ReportingPacketSchema.parse({ context, section, notes: [], result: {
      state: 'unavailable', data: null, asOf: null,
      notes: ['This source could not return a validated report in time. Retry this source; other results remain available.'],
    } })
  } finally { finished = true; if (timer) clearTimeout(timer) }
}

function subscribe(pending: PendingReport, onProgress?: (packet: ReportingPacket) => void, signal?: AbortSignal): Promise<ReportingPacket> {
  const deliver = onProgress ? (packet: ReportingPacket) => {
    if (signal?.aborted) return
    try { void Promise.resolve(onProgress(packet)).catch(() => undefined) }
    catch { /* One observer cannot interrupt other callers sharing the read. */ }
  } : undefined
  const unsubscribe = () => {
    if (deliver) pending.subscribers.delete(deliver)
    signal?.removeEventListener('abort', unsubscribe)
  }
  if (deliver && !signal?.aborted) {
    pending.subscribers.add(deliver)
    signal?.addEventListener('abort', unsubscribe, { once: true })
    if (pending.latest) deliver(pending.latest)
  }
  return pending.promise.finally(unsubscribe)
}

function cacheSuccess(key: string, packet: ReportingPacket): ReportingPacket {
  if ((packet.result.state === 'available' || packet.result.state === 'partial')
    && (packet.section !== 'meta' || !['loading', 'unavailable'].includes(packet.result.data?.detailState ?? 'complete'))
    && (packet.section !== 'business' || !hasPendingBusinessIntelligence(packet.result.data) && !hasUnavailableBusinessIntelligence(packet.result.data))) {
    const bytes = Buffer.byteLength(JSON.stringify(packet))
    while (cache.size && (cache.size >= MAX_CACHE_ENTRIES || [...cache.values()].reduce((sum, entry) => sum + entry.bytes, bytes) > MAX_CACHE_BYTES)) cache.delete(cache.keys().next().value as string)
    if (bytes <= MAX_CACHE_BYTES) cache.set(key, { expires: Date.now() + CACHE_TTL_MS, packet, bytes })
  }
  return packet
}

/** In-process only. Authentication/account ownership is resolved before every call, including cache hits. */
export async function loadReportingSection(
  section: ReportingSectionName, context: ReportingContext, refresh = false, detailIds: string[] = [],
  onProgress?: (packet: ReportingPacket) => void, signal?: AbortSignal,
  options: { isolateGeneration?: boolean; historyEntity?: ReportingHistoryEntity } = {},
): Promise<ReportingPacket> {
  const historyEntity = options.historyEntity === undefined ? undefined : ReportingHistoryEntitySchema.parse(options.historyEntity)
  if (historyEntity && (section !== 'meta' || detailIds.length)) throw new Error('Invalid reporting history selection')
  const selected = section === 'meta' ? [...new Set(detailIds)].sort() : []
  const key = JSON.stringify([section, context.account.id, context.account.metaAccountId, context.range, context.comparison, context.timezone, context.currency, selected, ...(historyEntity ? [historyEntity] : [])])
  const pendingKey = options.isolateGeneration ? JSON.stringify([key, context.asOf]) : key
  const now = Date.now()
  for (const [entryKey, entry] of cache) if (entry.expires <= now) cache.delete(entryKey)
  const cached = cache.get(key)
  if (!options.isolateGeneration && !refresh && cached) return { ...cached.packet, context: { ...cached.packet.context, account: context.account } }
  const pending = inFlight.get(pendingKey)
  if (pending) return subscribe(pending, onProgress, signal)
  const request: PendingReport = {
    subscribers: new Set(),
    promise: Promise.resolve().then(() => readSection(section, context, selected, packet => {
      request.latest = packet
      for (const subscriber of [...request.subscribers]) subscriber(packet)
    }, historyEntity)).then(packet => options.isolateGeneration ? packet : cacheSuccess(key, packet)).finally(() => {
      request.subscribers.clear()
      if (inFlight.get(pendingKey) === request) inFlight.delete(pendingKey)
    }),
  }
  inFlight.set(pendingKey, request)
  return subscribe(request, onProgress, signal)
}
