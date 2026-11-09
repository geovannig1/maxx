// Server adapter. Call only after the reporting route resolves the authenticated account.
import { metaGet } from '@/lib/platforms/meta/client'
import { ACTION_ATTRIBUTION_WINDOWS, ATTRIBUTION_WINDOW_LABEL } from '@/lib/platforms/meta/attribution'
import { META_DETAILS_LOADING_NOTE, ReportingContextSchema, type MetaReport, type ReportEntity, type ReportObservation, type ReportSection, type ReportingContext, type ReportingRange } from '@/lib/reporting/contracts'
import { buildMetaMetrics, type MetaRow } from '@/lib/reporting/meta-metrics'
import { inventoryObservations, metaText, readMetaInventory, resolveInventoryAudience, type MetaInventory } from './meta-inventory'
import { buildMetaBreakdowns, buildMetaSeries, META_DAILY_METRIC_KEYS, META_DIMENSIONS, omitUnavailableEntityMetrics, reconcileReportOutcomes, previousContext, validateMetaReportRows, type MetaDimension } from '@/lib/reporting/meta-breakdowns'
import { readReportCreativeAssignmentEvidence } from '@/lib/reporting/creative-assignment-reader'
import type { ReportCreativeAssignmentEvidence } from '@/lib/reporting/creative-assignment-contract'
import { projectMetaDailyAuthority } from '@/lib/reporting/meta-daily-authority'
import { createMetaReadSession, metaReadFailureNote } from './meta-read-session'
import { ReportingHistoryEntitySchema, type ReportingHistoryEntity } from '@/lib/reporting/snapshot-scope'
import { projectBudgetEvidence } from '@/lib/reporting/budget-evidence'

type Level = 'account' | 'campaign' | 'adset' | 'ad'
interface Query { key: string; range: ReportingRange; level: Level; daily?: boolean; dimension?: MetaDimension; detailIds?: string[]; historyEntity?: ReportingHistoryEntity }
export interface MetaReportOptions { detailIds?: string[]; historyEntity?: ReportingHistoryEntity; onProgress?: (result: ReportSection<MetaReport>) => void }
interface Page { data?: unknown; paging?: { next?: string; cursors?: { after?: string } } }
const DELIVERY_FIELDS = ['date_start', 'date_stop', 'account_id', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks', 'actions', 'action_values', 'results', 'conversions', 'conversion_values', 'outbound_clicks', 'outbound_clicks_ctr', 'cost_per_outbound_click', 'instagram_profile_visits', 'instagram_profile_follow']
const VIDEO_FIELDS = ['video_play_actions', 'video_continuous_2_sec_watched_actions', 'video_thruplay_watched_actions', 'video_p25_watched_actions', 'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p100_watched_actions', 'video_avg_time_watched_actions']
const RANKING_FIELDS = ['quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking']
const LEVEL_FIELDS: Record<Level, string[]> = { account: [], campaign: ['campaign_id', 'campaign_name'], adset: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name'], ad: ['campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name'] }

/** Cursor pagination reissues the fixed authenticated path and query; paging URLs are never trusted. */
export async function readMetaPages(path: string, params: Record<string, string>, get: typeof metaGet = metaGet): Promise<MetaRow[]> {
  const rows: MetaRow[] = []
  let after: string | undefined
  const seen = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const response = await get<Page>(path, { ...params, ...(after ? { after } : {}) })
    if (!Array.isArray(response.data) || response.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid Meta reporting response')
    for (const row of response.data as MetaRow[]) rows.push(row)
    if (!response.paging?.next) return rows
    const next = response.paging.cursors?.after
    if (!next || seen.has(next)) throw new Error('Meta pagination did not advance')
    seen.add(next)
    after = next
  }
  throw new Error('Meta reporting pagination limit reached; incomplete read rejected')
}

async function readInsights(context: ReportingContext, query: Query, pages: typeof readMetaPages = readMetaPages): Promise<{ rows: MetaRow[]; notes: string[] }> {
  const account = context.account.metaAccountId.replace(/^act_/, '')
  let fields = [...LEVEL_FIELDS[query.level], ...DELIVERY_FIELDS, ...VIDEO_FIELDS,
    ...(query.level === 'ad' && !query.dimension && !query.daily ? RANKING_FIELDS : [])]
  const required = [...LEVEL_FIELDS[query.level], 'date_start', 'date_stop', 'account_id', 'spend', 'impressions', 'reach', 'frequency', 'clicks', 'inline_link_clicks']
  const notes: string[] = []
  for (;;) {
    try {
      const rows = await pages(`/act_${account}/insights`, {
        fields: fields.join(','), level: query.level, limit: '500',
        time_range: JSON.stringify({ since: query.range.from, until: query.range.to }),
        action_attribution_windows: ACTION_ATTRIBUTION_WINDOWS, action_report_time: 'impression',
        ...(query.daily ? { time_increment: '1' } : {}),
        ...(query.detailIds?.length ? { filtering: JSON.stringify([{ field: 'ad.id', operator: 'IN', value: query.detailIds }]) } : {}),
        ...(query.historyEntity ? { filtering: JSON.stringify([{ field: `${query.historyEntity.level}.id`, operator: 'IN', value: [query.historyEntity.id] }]) } : {}),
        ...(query.dimension ? { breakdowns: META_DIMENSIONS[query.dimension].join(',') } : {}),
      })
      if (query.detailIds && rows.some(row => !query.detailIds!.includes(String(row.ad_id)))) throw new Error('Meta detail identity mismatch')
      if (query.historyEntity && rows.some(row => row[`${query.historyEntity!.level}_id`] !== query.historyEntity!.id
        || query.historyEntity!.level === 'adset' && !metaText(row.campaign_id))) throw new Error('Meta parent history identity mismatch')
      if (rows.some(row => row.account_id !== undefined && String(row.account_id).replace(/^act_/, '') !== account)) throw new Error('Meta account mismatch')
      return { rows: validateMetaReportRows(rows, query.range, query.level, Boolean(query.daily), query.dimension), notes }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 100) throw error
      const rejected = fields.filter(field => !required.includes(field) && error.message.includes(field))
      if (rejected.length) {
        fields = fields.filter(field => !rejected.includes(field))
        notes.push(`Meta ${query.key} rejected optional field(s): ${rejected.join(', ')}. Those measures remain unavailable.`)
      } else if (fields.some(field => !required.includes(field)) && /field|metric|breakdown/i.test(error.message)) {
        fields = required
        notes.push(`Meta ${query.key} could not combine optional outcome/watch fields; only independently supported delivery fields are returned.`)
      } else throw error
    }
  }
}

function queryPlan(context: ReportingContext, detailIds: string[], historyEntity?: ReportingHistoryEntity): Query[] {
  return (['current', 'previous'] as const).flatMap(period => {
    const range = period === 'current' ? context.range : context.comparison
    return [
      ...(['account', 'campaign', 'adset', 'ad'] as const).map(level => ({ key: `${period}:${level}`, range, level })),
      { key: `${period}:account:daily`, range, level: 'account' as const, daily: true },
      { key: `${period}:campaign:daily`, range, level: 'campaign' as const, daily: true },
      ...(historyEntity?.level === 'adset' ? [{ key: `${period}:adset:daily`, range, level: 'adset' as const, daily: true, historyEntity }] : []),
      ...(historyEntity?.breakdown ? [{ key: `${period}:${historyEntity.level}:${historyEntity.breakdown}`, range,
        level: historyEntity.level, dimension: historyEntity.breakdown, historyEntity }] : []),
      ...(Object.keys(META_DIMENSIONS) as MetaDimension[]).map(dimension => ({ key: `${period}:account:${dimension}`, range, level: 'account' as const, dimension })),
      ...(detailIds.length ? [
        { key: `${period}:ad:daily`, range, level: 'ad' as const, daily: true, detailIds },
        { key: `${period}:ad:placement`, range, level: 'ad' as const, dimension: 'placement' as const, detailIds },
      ] : []),
    ]
  })
}

function uniqueInventory(rows: MetaRow[]): Map<string, MetaRow> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = metaText(row.id)
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return new Map(rows.flatMap(row => {
    const id = metaText(row.id)
    return id && counts.get(id) === 1 ? [[id, row]] : []
  }))
}

/** Rows of one read grouped by an identity field, in read order: one pass instead of a filter per entity. */
function rowIndex(reads: Map<string, MetaRow[]>) {
  const indexes = new Map<string, Map<unknown, MetaRow[]>>()
  return (key: string, field: string, id: string): MetaRow[] => {
    let index = indexes.get(`${key}|${field}`)
    if (!index) {
      index = new Map()
      for (const row of reads.get(key) ?? []) {
        const group = index.get(row[field])
        if (group) group.push(row)
        else index.set(row[field], [row])
      }
      indexes.set(`${key}|${field}`, index)
    }
    return index.get(id) ?? []
  }
}

function historyCampaignParent(current: MetaRow | undefined, previous: MetaRow | undefined, config: MetaRow | undefined, daily: MetaRow[]): string | null {
  const nativeParent = metaText(current?.campaign_id) ?? metaText(previous?.campaign_id) ?? metaText(config?.campaign_id)
  const dailyParents = new Set(daily.map(row => metaText(row.campaign_id)))
  return nativeParent ?? (dailyParents.size === 1 ? [...dailyParents][0] : null)
}

function entities(context: ReportingContext, inventory: MetaInventory, reads: Map<string, MetaRow[]>, detailIds: string[], historyEntity?: ReportingHistoryEntity): ReportEntity[] {
  const campaigns = uniqueInventory(inventory.campaigns)
  const adsets = uniqueInventory(inventory.adsets)
  const ads = uniqueInventory(inventory.ads)
  const rowsOf = rowIndex(reads)
  return (['campaign', 'adset', 'ad'] as const).flatMap(level => {
    const current = new Map((reads.get(`current:${level}`) ?? []).map(row => [String(row[`${level}_id`]), row]))
    const previous = new Map((reads.get(`previous:${level}`) ?? []).map(row => [String(row[`${level}_id`]), row]))
    const configured = level === 'campaign' ? campaigns : level === 'adset' ? adsets : ads
    const daily = [...(reads.get(`current:${level}:daily`) ?? []), ...(reads.get(`previous:${level}:daily`) ?? [])]
      .filter(row => level === 'campaign' || (historyEntity?.level === level && row[`${level}_id`] === historyEntity.id)
        || (level === 'ad' && detailIds.includes(String(row.ad_id))))
    const ids = [...new Set([...current.keys(), ...previous.keys(), ...configured.keys(), ...daily.map(row => String(row[`${level}_id`]))])].sort()
    const firstDaily = new Map<unknown, MetaRow>()
    for (const row of daily) if (!firstDaily.has(row[`${level}_id`])) firstDaily.set(row[`${level}_id`], row)
    return ids.map(id => {
      const config = configured.get(id)
      const selectedParent = historyEntity?.level === level && historyEntity.id === id
      const parentBreakdown = selectedParent ? historyEntity.breakdown : undefined
      const row = current.get(id) ?? previous.get(id) ?? firstDaily.get(id)
      const campaignId = level === 'campaign' ? id : level === 'adset'
        ? historyCampaignParent(current.get(id), previous.get(id), config, daily.filter(item => item.adset_id === id))
        : metaText(row?.campaign_id) ?? metaText(config?.campaign_id)
      const adsetId = level === 'adset' ? id : level === 'ad' ? metaText(row?.adset_id) ?? metaText(config?.adset_id) : null
      const observedCampaignId = level === 'adset' ? campaignId : row?.campaign_id
      // Conflicting parent identity means current configuration cannot be attributed to this historical row.
      const compatible = config && (!row || (!config.campaign_id || !observedCampaignId || config.campaign_id === observedCampaignId)
        && (!config.adset_id || !row.adset_id || config.adset_id === row.adset_id)) ? config : undefined
      const adset = adsetId ? adsets.get(adsetId) : undefined
      const parentCompatible = !adset || !campaignId || adset.campaign_id === campaignId
      const audience = resolveInventoryAudience(context, compatible && parentCompatible ? adset : undefined, inventory.audiences, compatible ? inventory.observedAt : null)
      const creative = compatible?.creative && typeof compatible.creative === 'object' ? compatible.creative as MetaRow : null
      const creativeId = metaText(creative?.id)
      const entity = { level, id }
      const adRows = (key: string) => rowsOf(key, 'ad_id', id)
      const parentRows = (key: string) => rowsOf(key, `${level}_id`, id)
      return {
        id, level, name: metaText(row?.[`${level}_name`]) ?? metaText(config?.name) ?? id,
        campaignId, campaignName: metaText(row?.campaign_name) ?? metaText(campaigns.get(campaignId ?? '')?.name),
        adsetId, adsetName: metaText(row?.adset_name) ?? metaText(adset?.name),
        status: metaText(compatible?.effective_status) ?? metaText(compatible?.status) ?? 'UNKNOWN',
        configurationAsOf: compatible ? inventory.observedAt : null, ...audience,
        audienceEvidence: level === 'adset' ? audience.audienceEvidence : undefined,
        budgetEvidence: level === 'ad' ? undefined : projectBudgetEvidence(context, { level, id, campaignId }, compatible, compatible ? inventory.observedAt : null),
        creative: creativeId ? inventory.creatives[creativeId] ?? null : null,
        metrics: buildMetaMetrics(context, current.get(id) ?? null, previous.get(id) ?? null, entity),
        ...(selectedParent || level === 'campaign' && (reads.has('current:campaign:daily') || reads.has('previous:campaign:daily')) ? {
          series: buildMetaSeries(context, parentRows(`current:${level}:daily`), parentRows(`previous:${level}:daily`), entity, selectedParent ? META_DAILY_METRIC_KEYS : undefined),
          comparisonSeries: buildMetaSeries(previousContext(context), parentRows(`previous:${level}:daily`), null, entity, selectedParent ? META_DAILY_METRIC_KEYS : undefined),
        } : {}),
        ...(parentBreakdown ? { breakdowns: buildMetaBreakdowns(context, parentBreakdown,
          parentRows(`current:${level}:${parentBreakdown}`), parentRows(`previous:${level}:${parentBreakdown}`), entity) } : {}),
        ...(level === 'ad' && detailIds.includes(id) ? {
          series: buildMetaSeries(context, adRows('current:ad:daily'), adRows('previous:ad:daily'), entity),
          comparisonSeries: buildMetaSeries(previousContext(context), adRows('previous:ad:daily'), null, entity),
          breakdowns: buildMetaBreakdowns(context, 'placement', adRows('current:ad:placement'), adRows('previous:ad:placement'), entity),
        } : {}),
      }
    })
  })
}

function rankings(context: ReportingContext, rows: MetaRow[]): ReportObservation[] {
  return rows.flatMap(row => RANKING_FIELDS.flatMap(field => {
    const ranking = metaText(row[field])
    return ranking ? [{ id: `${field}:${row.ad_id}`, entityId: metaText(row.ad_id), observedAt: context.asOf,
      kind: 'quality' as const, title: field.replaceAll('_', ' '), detail: `Meta reports ${ranking} for ${metaText(row.ad_name) ?? row.ad_id} in ${context.range.from}–${context.range.to}. This is an auction diagnostic, not an instruction to change delivery.` }] : []
  }))
}

/** A selected ad-set day must belong to the same native campaign as its retained entity. */
function parentHistoryReads(inventory: MetaInventory, reads: Map<string, MetaRow[]>, historyEntity?: ReportingHistoryEntity) {
  if (historyEntity?.level !== 'adset') return { reads, notes: [] as string[] }
  const dailyKeys = ['current:adset:daily', 'previous:adset:daily']
  const keys = [...dailyKeys, ...(historyEntity.breakdown
    ? [`current:adset:${historyEntity.breakdown}`, `previous:adset:${historyEntity.breakdown}`]
    : [])]
  const periodRows = ['current:adset', 'previous:adset'].map(key => reads.get(key)?.find(row => row.adset_id === historyEntity.id))
  const config = uniqueInventory(inventory.adsets).get(historyEntity.id)
  const parent = historyCampaignParent(periodRows[0], periodRows[1], config, dailyKeys.flatMap(key => reads.get(key) ?? []))
  const rejected = keys.filter(key => reads.get(key)?.some(row => !parent || row.campaign_id !== parent))
  return { reads: new Map([...reads].filter(([key]) => !rejected.includes(key))), notes: rejected.map(key =>
    `Meta ${key.replaceAll(':', ' ')} campaign identity does not match the retained ad set; this history is unavailable. Independent period and other source observations remain available.`) }
}

function assembleMetaReport(
  context: ReportingContext, inventory: MetaInventory, plan: Query[],
  outcomes: PromiseSettledResult<Awaited<ReturnType<typeof readInsights>>>[], detailIds: string[], detailState: 'loading' | 'complete',
  creativeAssignmentEvidence?: ReportCreativeAssignmentEvidence, historyEntity?: ReportingHistoryEntity,
): ReportSection<MetaReport> {
  const scoped = parentHistoryReads(inventory, new Map(outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [[plan[index].key, outcome.value.rows] as const] : [])), historyEntity)
  const reads = scoped.reads
  const fieldNotes = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value.notes : [])
  const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
    ? [[`Meta ${plan[index].key.replaceAll(':', ' ')} unavailable; unsupported dimensions or incomplete source reads do not remove valid totals.`, metaReadFailureNote(outcome.reason)].filter(Boolean).join(' ')] : [])
  const empty = [...reads.entries()].filter(([, rows]) => rows.length === 0).map(([key]) => `Meta ${key.replaceAll(':', ' ')} returned no rows. Omitted dates/entities are unknown, not measured zero.`)
  const currentAccount = reads.get('current:account')?.[0] ?? null
  const previousAccount = reads.get('previous:account')?.[0] ?? null
  const metrics = buildMetaMetrics(context, currentAccount, previousAccount)
  const data: MetaReport = {
    detailState, metrics, entities: entities(context, inventory, reads, detailIds, historyEntity),
    ...(creativeAssignmentEvidence ? { creativeAssignmentEvidence } : {}),
    series: buildMetaSeries(context, reads.get('current:account:daily') ?? [], reads.get('previous:account:daily') ?? []),
    comparisonSeries: buildMetaSeries(previousContext(context), reads.get('previous:account:daily') ?? [], null),
    breakdowns: (Object.keys(META_DIMENSIONS) as MetaDimension[]).flatMap(dimension => buildMetaBreakdowns(context, dimension, reads.get(`current:account:${dimension}`) ?? [], reads.get(`previous:account:${dimension}`) ?? [])),
    observations: [...inventoryObservations(context, inventory), ...rankings(context, reads.get('current:ad') ?? [])],
    attributionWindow: `${ATTRIBUTION_WINDOW_LABEL}; conversion default totals follow Meta's entity attribution settings.`,
    reportingTime: 'Impression date in the account timezone; current configuration is observed now and is not historical setup evidence.',
    sourceDescription: 'Meta-reported delivery and attributed estimates, read directly from authenticated Meta Graph GET endpoints. Reach and frequency use native period aggregates; outcome business records remain separate.',
  }
  const reconciled = reconcileReportOutcomes(context, projectMetaDailyAuthority(context, data, reads), reads)
  const missing = Object.values(reconciled.report.metrics).filter(metric => metric.current.value === null).map(metric => metric.label)
  const missingPrior = Object.values(reconciled.report.metrics).filter(metric => metric.previous?.value == null).map(metric => metric.label)
  const notes = [...reconciled.notes, ...inventory.notes, ...fieldNotes, ...failures, ...scoped.notes, ...empty, ...(creativeAssignmentEvidence?.notes ?? []),
    ...(detailState === 'loading' ? [META_DETAILS_LOADING_NOTE] : []),
    ...(missing.length ? [`Current account fields unavailable: ${missing.join(', ')}. Each entity retains its own field coverage.`] : []),
    ...(missingPrior.length ? [`Prior account fields unavailable: ${missingPrior.join(', ')}.`] : []),
    'Daily series include observed dates only; omitted days remain unknown and are never filled with zero.',
    'Video starts and continuous 2-second views are distinct from watch milestones. Dynamic creative assets are not assigned ad-level performance individually.',
  ]
  const hasData = currentAccount !== null || previousAccount !== null || data.entities.length > 0 || data.series.length > 0 || data.comparisonSeries.length > 0 || data.breakdowns.length > 0
  return { state: hasData ? detailState === 'loading' || reconciled.notes.length > 1 || inventory.notes.length || fieldNotes.length || failures.length || scoped.notes.length || empty.length || missing.length || missingPrior.length ? 'partial' : 'available' : 'unavailable', data: hasData ? omitUnavailableEntityMetrics(reconciled.report) : null, asOf: context.asOf, notes }
}

export async function readMetaReport(rawContext: ReportingContext, options: MetaReportOptions = {}): Promise<ReportSection<MetaReport>> {
  const context = ReportingContextSchema.parse(rawContext)
  const historyEntity = options.historyEntity === undefined ? undefined : ReportingHistoryEntitySchema.parse(options.historyEntity)
  const detailIds = [...new Set(options.detailIds ?? [])]
  if (historyEntity && detailIds.length) throw new Error('Parent history and ad detail cannot be requested together.')
  const account = context.account.metaAccountId.replace(/^act_/, '')
  if (!/^\d+$/.test(account)) return { state: 'unavailable', data: null, asOf: context.asOf, notes: ['Meta account identity is invalid.'] }
  const session = createMetaReadSession()
  try {
    try {
      const metadata = await session.coreGet<MetaRow>(`/act_${account}`, { fields: 'id,currency,timezone_name' })
      if (metadata.id !== `act_${account}` || metadata.currency !== context.currency || metadata.timezone_name !== context.timezone) {
        return { state: 'unavailable', data: null, asOf: context.asOf, notes: ['Meta account identity, currency or timezone does not match the requested report; totals were withheld.'] }
      }
    } catch (error) {
      return { state: 'unavailable', data: null, asOf: context.asOf, notes: ['Meta account currency and timezone could not be verified.', metaReadFailureNote(error)].filter(Boolean) }
    }
    const plan = queryPlan(context, detailIds, historyEntity)
    const pages = (path: string, params: Record<string, string>) => readMetaPages(path, params, session.get)
    const corePages = (path: string, params: Record<string, string>) => readMetaPages(path, params, session.coreGet)
    const queries = plan.map(query => readInsights(context, query, !query.daily && !query.dimension ? corePages : pages))
    const outcomes = Promise.allSettled(queries)
    // Hierarchy/configuration is required to retain entities without delivery in either period.
    // Queue those reads with period totals, ahead of optional daily and breakdown detail.
    const inventory = readMetaInventory(context, corePages, session.get)
    const core = plan.flatMap((query, index) => !query.daily && !query.dimension ? [{ query, read: queries[index] }] : [])
    const coreOutcomes = Promise.allSettled(core.map(query => query.read))
    // History is optional and starts independently of slower trends/breakdowns. Progress never waits for it.
    const history = Promise.all([inventory, coreOutcomes]).then(([configuration, settled]) => {
      const observedAds = settled.flatMap((outcome, index) => core[index].query.level === 'ad' && outcome.status === 'fulfilled'
        ? outcome.value.rows.map(row => metaText(row.ad_id)) : [])
      const adIds = [...new Set([...uniqueInventory(configuration.ads).keys(), ...observedAds]
        .filter((id): id is string => id !== null))].sort()
      return readReportCreativeAssignmentEvidence(context, adIds)
    })
    const progress = options.onProgress ? coreOutcomes.then(settled => {
      const emptyInventory: MetaInventory = { campaigns: [], adsets: [], ads: [], audiences: {}, creatives: {}, notes: [], observedAt: context.asOf }
      const partial = assembleMetaReport(context, emptyInventory, core.map(item => item.query), settled, detailIds, 'loading', undefined, historyEntity)
      if (partial.data) {
        try { void Promise.resolve(options.onProgress?.(partial)).catch(() => undefined) }
        catch { /* A progress observer cannot discard the final source report. */ }
      }
    }) : Promise.resolve()
    const [completeInventory, completeOutcomes, assignmentEvidence] = await Promise.all([inventory, outcomes, history, progress])
    return assembleMetaReport(context, completeInventory, plan, completeOutcomes, detailIds, 'complete', assignmentEvidence, historyEntity)
  } finally { session.close() }
}
