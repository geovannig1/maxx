import { z } from 'zod'
import type { MetricClaim } from '@/lib/cockpit/contracts'
import type { ReportingPacket } from './contracts'
import { META_DAILY_METRIC_KEYS } from './meta-breakdowns'
import { makeReportingSnapshotScope, ReportingSnapshotScopeSchema, type ReportingSnapshotScope } from './snapshot-scope'
import { validateReportingPacket } from './validation'

const timestamp = z.string().datetime({ offset: true })
// Keep the original saved parent catalog required; additions must not make old evidence invalid.
const parentHistoryRequiredKeys = ['spend', 'bookings', 'appointment_value', 'purchase_count', 'purchase_value', 'impressions', 'reach', 'frequency',
  'clicks', 'link_clicks', 'outbound_clicks', 'landing_page_views', 'video_plays', 'video_2s', 'thruplays',
  'watch_p25', 'watch_p50', 'watch_p75', 'watch_p100', 'average_watch_seconds', 'engagements', 'reactions', 'comments', 'shares', 'saves',
  'bookings_click', 'bookings_view', 'cost_per_booking', 'appointment_roas', 'purchase_roas', 'cpm', 'ctr', 'cpc', 'link_ctr', 'link_cpc',
  'outbound_ctr', 'outbound_cpc', 'cost_per_lpv', 'cost_per_2s_view', 'cost_per_thruplay', 'cost_per_engagement', 'cost_per_share',
  'engagement_rate', 'share_rate', 'retention_p25', 'retention_p50', 'retention_p75', 'retention_p100']
const parentHistoryCpaKeys = [...parentHistoryRequiredKeys, 'cost_per_purchase']
const nativeDailyKeys = new Set(META_DAILY_METRIC_KEYS)

function hasExactKeys(metrics: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(metrics)
  return keys.length === expected.length && expected.every(key => key in metrics)
}

function hasKnownParentHistoryCatalog(metrics: Record<string, unknown>): boolean {
  return hasExactKeys(metrics, parentHistoryRequiredKeys)
    || hasExactKeys(metrics, parentHistoryCpaKeys)
    || hasExactKeys(metrics, META_DAILY_METRIC_KEYS)
}

function packetClaims(value: unknown): MetricClaim[] {
  if (!value || typeof value !== 'object') return []
  if ('claimId' in value && 'metricKey' in value) return [value as MetricClaim]
  return Object.values(value).flatMap(packetClaims)
}

/** Pending and completed reports share the full evidence checks. Completion is
 * an additional snapshot requirement, never fabricated for a progress packet. */
export function validateScopedReportingPacket(
  raw: unknown, expectedScope: ReportingSnapshotScope, observedUntil: string,
): ReportingPacket {
  try {
    const expected = ReportingSnapshotScopeSchema.parse(expectedScope)
    const packet = validateReportingPacket(raw)
    const packetScope = makeReportingSnapshotScope(packet.section, packet.context, {
      requestedRange: expected.requestedRange, detailIds: expected.detailIds, historyEntity: expected.historyEntity,
    })
    if (packet.section === 'meta' && packet.result.data) {
      const terminal = [undefined, 'complete'].includes(packet.result.data.detailState)
      for (const entity of packet.result.data.entities) {
        if (entity.level === 'campaign' || entity.level === 'adset' && expected.historyEntity?.level === 'adset' && expected.historyEntity.id === entity.id) {
          const selectedParent = expected.historyEntity?.level === entity.level && expected.historyEntity.id === entity.id
          const requestedBreakdown = selectedParent ? expected.historyEntity?.breakdown : undefined
          const keys = selectedParent ? nativeDailyKeys : new Set(['bookings', 'appointment_value', 'bookings_click', 'bookings_view'])
          if ((!requestedBreakdown && entity.breakdowns !== undefined)
            || (requestedBreakdown && terminal && entity.breakdowns === undefined)
            || entity.breakdowns?.some(row => row.dimension !== requestedBreakdown)
            || (selectedParent && terminal && (entity.series === undefined || entity.comparisonSeries === undefined))
            || [entity.series, entity.comparisonSeries].some(points => points?.some(point =>
              selectedParent ? !hasKnownParentHistoryCatalog(point.metrics)
                : Object.keys(point.metrics).some(key => !keys.has(key))))) throw new Error('Invalid parent daily history scope.')
          continue
        }
        const selected = entity.level === 'ad' && expected.detailIds.includes(entity.id)
        const details = [entity.series, entity.comparisonSeries, entity.breakdowns]
        if ((!selected && details.some(value => value !== undefined))
          || (selected && terminal && details.some(value => value === undefined))) throw new Error('Invalid selected-ad detail scope.')
      }
    }
    const finished = Date.parse(timestamp.parse(observedUntil))
    if (JSON.stringify(packetScope) !== JSON.stringify(expected)
      || !['available', 'partial'].includes(packet.result.state)
      || finished < Date.parse(packet.context.asOf)
      || (packet.result.asOf !== null && Date.parse(packet.result.asOf) > finished)
      || (packet.section === 'business' && Object.values(packet.result.data?.intelligence ?? {})
        .some(section => section.asOf !== null && Date.parse(section.asOf) > finished))
      || packetClaims(packet).some(claim => claim.definitionVersion !== 1
        || claim.authority.state !== 'diagnostic' || claim.authority.policyVersion !== expected.policyVersion
        || Date.parse(claim.asOf) > finished)) throw new Error('Invalid scoped reporting evidence.')
    return packet
  } catch { throw new Error('Invalid scoped reporting evidence.') }
}
