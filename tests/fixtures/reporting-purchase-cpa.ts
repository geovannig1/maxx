import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { dailyMetaMetrics, dayOffset, previousContext, reconcileReportOutcomes } from '@/lib/reporting/meta-breakdowns'
import type { ReportEntity, ReportingContext } from '@/lib/reporting/contracts'
import { hierarchyHistoryFixture } from './reporting-hierarchy-history'

/** Fictional cost/volume movements with no Purchase value. Never account performance. */
export function purchaseCpaFixture() {
  const base = hierarchyHistoryFixture(), context = base.context
  const native = (spend: number, count: number | null) => ({ spend: String(spend), impressions: '1000',
    ...(count === null ? {} : { actions: [{ action_type: 'purchase', value: String(count) }] }),
  })
  const metrics = (scope: ReportingContext, entity: { level: ReportEntity['level'] | 'account'; id: string },
    current = native(100, 5), previous = native(200, 20)) => buildMetaMetrics(scope, current, previous, { level: entity.level, id: entity.id })
  const amounts = (entity: ReportEntity, prior: boolean): [number, number | null] => {
    if (entity.level !== 'ad') return entity.campaignId === '102'
      ? prior ? [400, 40] : [250, 10] : prior ? [1600, 160] : [750, 40]
    return prior ? [200, 20] : entity.id === '302' ? [50, 10] : [100, entity.id === '303' ? 0 : entity.id === '304' ? null : 5]
  }
  const row = (entity: ReportEntity, prior: boolean) => ({ ...native(...amounts(entity, prior)),
    account_id: context.account.metaAccountId, campaign_id: entity.campaignId, adset_id: entity.adsetId,
    ...(entity.level === 'ad' ? { ad_id: entity.id } : {}),
    date_start: (prior ? context.comparison : context.range).from, date_stop: (prior ? context.comparison : context.range).to })
  const entities = base.meta.data!.entities.map(entity => {
    const current = row(entity, false), previous = row(entity, true)
    const history = (prior: boolean) => {
      const scope = prior ? previousContext(context) : context
      const [spend, count] = amounts(entity, prior)
      return [0, 1, 2].map(index => {
        const date = dayOffset(scope.range.from, index), previousDate = dayOffset(scope.comparison.from, index)
        const dayContext = { ...scope, range: { from: date, to: date }, comparison: { from: previousDate, to: previousDate } }
        const spendShare = (prior ? [0.5, 0.25, 0.25] : [0.3, 0.3, 0.4])[index]
        const countShare = (prior ? [0.5, 0.25, 0.25] : [0.6, 0.4, 0])[index]
        return { date, metrics: dailyMetaMetrics(buildMetaMetrics(dayContext,
          native(spend * spendShare, count === null ? null : count * countShare), undefined, { level: entity.level, id: entity.id })) }
      })
    }
    return { ...entity, name: `Fictional Purchase cost ${entity.level} ${entity.id}`,
      metrics: metrics(context, entity, current, previous), series: history(false), comparisonSeries: history(true),
      ...(entity.level === 'ad' ? { breakdowns: [{ id: `ad:${entity.id}:placement:instagram / reels`,
        dimension: 'placement' as const, label: 'instagram / reels',
        metrics: metrics(context, { level: 'ad', id: `${entity.id}:placement:instagram / reels` }, current, previous) }] } : {}),
    }
  })
  const currentAccount = native(1000, 50), previousAccount = native(2000, 200)
  const reads = new Map(['current', 'previous'].flatMap((period, index): [string, MetaRow[]][] => [
    [`${period}:account`, [index ? previousAccount : currentAccount]],
    ...(['campaign', 'adset', 'ad'] as const).map((level): [string, MetaRow[]] => [`${period}:${level}`,
      base.meta.data!.entities.filter(entity => entity.level === level).map(entity => row(entity, Boolean(index)))]),
  ]))
  const reconciled = reconcileReportOutcomes(context, { ...base.meta.data!, entities,
    metrics: metrics(context, { level: 'account', id: context.account.id }, currentAccount, previousAccount),
    sourceDescription: 'Entirely fictional cost and volume observations, not Example Studio results.' }, reads)
  return { ...base, meta: { ...base.meta,
    notes: ['Fictional Purchase CPA exercise. No Purchase value supplied.', ...reconciled.notes], data: reconciled.report } }
}
