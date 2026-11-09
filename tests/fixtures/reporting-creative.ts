import type { ReportEntity, ReportingData } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { describeCreativeIdentity } from '@/lib/reporting/creative-identity'
import type { ReportCreativeAssignmentEvidence } from '@/lib/reporting/creative-assignment-contract'
import { snapshotContext } from './reporting-snapshot'

export const creativeContext = { ...snapshotContext, account: { ...snapshotContext.account, name: 'Synthetic creative test' } }
export const emptyCreativeSection = { state: 'unavailable' as const, data: null, asOf: null, notes: [] }
export function creativeAd(id: string, current: MetaRow = {}, previous: MetaRow | null = current, creativeId = '401'): ReportEntity {
  return { id, level: 'ad', name: `Ad ${id}`, campaignId: '101', campaignName: 'Campaign', adsetId: '201', adsetName: 'Ad set',
    status: 'ACTIVE', configurationAsOf: creativeContext.asOf, audience: 'unknown', audienceLabel: 'Unknown',
    creative: { id: creativeId, name: `Creative ${creativeId}`, format: 'video', thumbnailUrl: null, imageUrl: null,
      videoUrl: 'https://example.test/video.mp4', durationSeconds: 12, body: null, headline: null, destination: null,
      identity: describeCreativeIdentity({ video_id: '501' }, creativeContext.asOf) },
    metrics: buildMetaMetrics(creativeContext, current, previous, { level: 'ad', id }) }
}
export function creativeHistory(ads: readonly ReportEntity[]): ReportCreativeAssignmentEvidence {
  return { accountId: creativeContext.account.id, asOf: creativeContext.asOf, state: 'available', notes: [],
    observations: ads.flatMap((ad, index) => ['2026-08-30T03:59:59.999Z', '2026-09-05T04:00:00Z'].map((observedAt, side) => ({
      id: `00000000-0000-4000-8000-${String(index * 2 + side + 1).padStart(12, '0')}`, metaAdId: ad.id,
      metaCreativeId: ad.creative?.id ?? null, observedAt, metaUpdatedTime: '2026-08-01T00:00:00Z',
    }))) }
}
export function creativeData(
  ads = [creativeAd('301', { spend: '10', clicks: '1', impressions: '10' }), creativeAd('302', { spend: '90', clicks: '9', impressions: '990' })],
  history: ReportCreativeAssignmentEvidence | null = creativeHistory(ads),
): ReportingData {
  return { context: creativeContext, business: emptyCreativeSection, website: emptyCreativeSection,
    meta: { state: 'available', asOf: creativeContext.asOf, notes: [], data: { metrics: {}, entities: ads,
      series: [], comparisonSeries: [], breakdowns: [], observations: [], detailState: 'complete',
      attributionWindow: 'Meta entity attribution settings', reportingTime: 'Impression date in America/New_York', sourceDescription: 'Synthetic native-shaped data',
      ...(history ? { creativeAssignmentEvidence: history } : {}),
    } } }
}
export function appointmentResults(total: number) {
  return [{ indicator: 'conversions:offsite_conversion.fb_pixel_custom.AppointmentConfirmed', values: [{ value: String(total), attribution_windows: ['default'] }] }]
}
