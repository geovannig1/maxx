import type { ReportEntity } from '@/lib/reporting/contracts'
import { buildMetaMetrics } from '@/lib/reporting/meta-metrics'
import { dailyMetaMetrics, previousContext, dayOffset } from '@/lib/reporting/meta-breakdowns'
import { creativeReportingFixture } from '../reporting-browser/creative-fixture'

/** Fictional opposed trajectories; no current Example Studio account findings. */
export function hierarchyHistoryFixture() {
  const data = creativeReportingFixture(), context = data.context
  const native = (count: number, prior: boolean, spend = 50, impressions = 1000) => ({ spend: String(spend), impressions: String(impressions), clicks: String(count),
    actions: [{ action_type: 'purchase', value: String(count) }],
    action_values: [{ action_type: 'purchase', value: String(count * (prior ? 5 : 10)) }] })
  const series = (entity: ReportEntity, prior: boolean) => {
    const scope = prior ? previousContext(context) : context
    const falling = entity.id.endsWith('1') === (entity.level === 'campaign')
    const values = falling ? [12, 8, 0] : [0, 8, 12]
    return values.map((count, index) => {
      const date = dayOffset(scope.range.from, index)
      return { date, metrics: dailyMetaMetrics(buildMetaMetrics({ ...scope, range: { from: date, to: date },
        comparison: { from: dayOffset(scope.comparison.from, index), to: dayOffset(scope.comparison.from, index) } },
      native(count, prior), undefined, { level: entity.level, id: entity.id })) }
    })
  }
  const parents = data.meta.data!.entities.filter(entity => entity.level !== 'ad').flatMap(entity => [entity, { ...entity,
    id: entity.level === 'campaign' ? '102' : '202', campaignId: '102', adsetId: entity.level === 'adset' ? '202' : null,
    name: `${entity.name} — opposite trajectory`, campaignName: 'Opposite campaign' }]).map(entity => ({ ...entity,
    metrics: buildMetaMetrics(context, native(20, false, 150, 3000), native(20, true, 150, 3000), { level: entity.level, id: entity.id }),
    series: series(entity, false), comparisonSeries: series(entity, true) }))
  return { ...data, meta: { ...data.meta,
    notes: ['Entirely fictional native-shaped evidence. Equal parent totals conceal opposing daily trajectories. This is not current Example Studio performance.'],
    data: { ...data.meta.data!, entities: [...parents, ...data.meta.data!.entities.filter(entity => entity.level === 'ad')] } } }
}
